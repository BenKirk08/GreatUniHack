# Voice Twin: notes from reading the codebase (Step 0)

Written before any Voice Twin code was added. Voice Twin builds on each of the mechanisms below rather than replacing them.

## 1. How the victim's call audio reaches the system

Only over the **phone network**. There is no browser audio path and no recording.

- A scammer calls `TWILIO_PHONE_NUMBER`. Twilio POSTs `/api/twilio/voice` ([app/api/twilio/voice/route.ts](../app/api/twilio/voice/route.ts)), which creates the `calls` row and returns `screeningTwiml()` ([lib/twilio.ts](../lib/twilio.ts)):
  - `<Start><Transcription name="screen" track="both_tracks" inboundTrackLabel="caller" outboundTrackLabel="customer">` runs Twilio Real-Time Transcription on the **parent** (caller's) leg. Segments arrive at `/api/twilio/transcription`.
  - `<Dial answerOnBridge callerId=… timeout=25>CUSTOMER_PHONE_NUMBER</Dial>` rings the customer's **real mobile**. That child leg is the victim's audio. It has no `action` URL, so redirecting the parent later drops it.
- The `/protect` page ([components/protect/protect-app.tsx](../components/protect/protect-app.tsx)) is a PWA that shows alerts. It never touches call audio: the victim talks on the phone's own dialler.
- No Twilio Media Streams or websocket service exists. Vercel functions can't host websockets.

**Consequence for Voice Twin:**
- **Live calls:** use the spec's "phone network only" path, a Twilio Media Stream on the victim's leg only. When the customer answers, Twilio calls the `<Number statusCallback>` webhook. The server starts a unidirectional stream on the child leg with `track=inbound_track` over REST, so only the victim's voice is captured. The audio goes to a new local Node service, `services/media-bridge`, exposed through ngrok. It decodes μ-law 8 kHz, runs energy VAD over 30 ms frames and writes WAV files to Storage.
- **"Record a sample now" in Settings:** captured in the browser with MediaRecorder plus Web Audio, using the same VAD code.

## 2. How scam detection triggers the takeover pop-up

- Each final transcription segment goes to `handleFinalSegment()` ([lib/screening.ts](../lib/screening.ts)). That appends it with the `append_screening_segment` RPC, scores the call (Claude Haiku plus a keyword floor, [lib/risk.ts](../lib/risk.ts)) and saves the score with the `record_risk_score` RPC (migrations 0007/0008).
- The first time the peak score reaches `RISK_THRESHOLD`, `record_risk_score` atomically sets `handoff_status = 'offered'`. Exactly one caller sees `offered = true`, so `sendOfferPush()` ([lib/push.ts](../lib/push.ts)) fires once.
- A DB trigger (`broadcast_row_change`, 0008) sends a content-free `{table, id, op}` signal on the Realtime Broadcast topic `northgate-ops`. `/protect` hears it through `useChangeSignals` ([lib/supabase/change-signals.ts](../lib/supabase/change-signals.ts)), re-reads `/api/protect/state` (customer cookie), and `viewFor()` switches to the full-screen `offered` alert. The page also polls every 20 s and on focus.
- The web push notification has a "Hand over to Northgate" action ([public/sw.js](../public/sw.js)) that POSTs `/api/protect/takeover` directly.

## 3. How the existing persona handover connects the ElevenLabs agent to the scammer

`takeOver()` in [lib/takeover.ts](../lib/takeover.ts) handles both the customer (`/api/protect/takeover`) and the analyst (`/api/calls/[id]/takeover`):

1. Atomic claim: `handoff_status` moves to `requested`. The conditions are `status = 'live'` and a claimable status, or a stale `requested` claim.
2. Fetch the caller's real number from Twilio.
3. `POST /v1/convai/twilio/register-call` ([lib/elevenlabs/register-call.ts](../lib/elevenlabs/register-call.ts)) for the single takeover agent `ELEVENLABS_AGENT_ID`, with:
   - `dynamic_variables.northgate_call_id`, which `record_details` and the post-call webhook use to find the call;
   - `conversation_config_override.agent.prompt.prompt`, the persona prompt built from the screening transcript;
   - `conversation_config_override.agent.first_message`;
   - `conversation_config_override.tts.voice_id`.
4. Stop the `screen` transcription, then update the live call with the returned TwiML. That drops the customer's `<Dial>` leg and connects the caller to the agent.
5. Mark the call `connected` with `persona`. If anything fails before the redirect, mark it `failed`, resume screening and leave the customer on the line.

Simulated calls (`CAsim…` CallSids) skip steps 2–4. `scripts/setup-agent.ts` has already turned on the `agent.prompt.prompt`, `agent.first_message` and `tts.voice_id` overrides (the dashboard's Security tab toggles) and set μ-law 8 kHz audio. After the call:
- `record_details` ([app/api/tools/record-details/route.ts](../app/api/tools/record-details/route.ts)) stores notes mid-call;
- the post-call webhook ([app/api/webhooks/elevenlabs/route.ts](../app/api/webhooks/elevenlabs/route.ts)) runs `finishCall()`: intel, report, and email if auto-send is on.

**Consequence for Voice Twin:** the twin is a fourth kind of `conversation_config_override` on the same agent and the same `register-call` path. `tts.voice_id` is the clone, the prompt is the spec's twin prompt with its two variables filled in server-side, and the first message is "Sorry, I'm back — where were we?". `record_details`, the post-call webhook and the report pipeline stay unchanged, so no dedicated twin agent is needed.

## 4. How personas are chosen

> **Superseded on 2026-11-07.** The four scam-type personas were replaced by six AI voices, one per age band and gender, matched to the customer automatically: their *Your AI voice match* setting, else Claude's inference from the call, else a middle-aged default ([lib/voice-match.ts](../lib/voice-match.ts), [lib/ai-voices/config.ts](../lib/ai-voices/config.ts)). The alert now has one **Use AI voice** button, plus **Use my Voice Twin** once the twin is ready. The text below describes the code as it was when the twin was designed.

- [lib/persona-meta.ts](../lib/persona-meta.ts): `personaForScamType()` maps the screened `risk.scam_type` to a persona:
  - Derek for HMRC and tech support;
  - Priya for investment;
  - Keith for family emergency;
  - Margaret for everything else.
- `selectPersona(scamType, requested)` uses an explicit pick when there is one, otherwise the mapping. Analysts pick from a select on the dashboard ("Auto (Derek)", Margaret…Keith).
- The customer's pop-up has a single "Hand over to Northgate" button, which always gets the auto-chosen persona.
- Voices come from `personaVoiceId()` ([lib/personas.ts](../lib/personas.ts)), which reads `ELEVENLABS_VOICE_ID` and `VOICE_ID_DEREK/PRIYA/KEITH`.

**Consequence for Voice Twin:**
- The pop-up shows persona tiles with the auto-chosen one highlighted and pre-selected. One tap on "Hand over" still works as before.
- When the twin is ready, the AI Voice Twin tile sits beside the personas and nothing is pre-selected.
- The analyst dashboard stays persona-only. The twin is always the victim's own consented choice.

## Other facts the design depends on

- **Database access:** the anon key has no table access (0008). Browsers read through authenticated API routes, and Realtime carries signals only. New Voice Twin tables follow the same rules: service role only, plus a broadcast trigger so `speech_seconds` updates reach `/protect` in real time.
- **Customer identity:** there is a single customer. They are identified by the httpOnly `northgate_guard` cookie, which is derived from `CUSTOMER_LINK_TOKEN`. The consent record stores this account holder and the time.
