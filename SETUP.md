# Setup: what's left to do by hand

The build configured everything else through APIs, and the scripts can reproduce it:

- **Supabase**: migrations including `0007_call_guard.sql`, `0009_voice_twin.sql` (AI Voice Twin tables, RPCs and the private `voice-twin` Storage bucket) and `0012_ai_voices.sql` (the six AI voices, `calls.ai_voice_match` and the customer's AI voice match setting), seed, RLS and Realtime (`npm run db:migrate`; `npm run db:check-voice-twin` exercises the 0009 SQL in a rolled-back transaction). If this machine can't reach the Postgres pooler ports, `vercel deploy --prod -b RUN_DB_MIGRATIONS=1` applies pending migrations from the Vercel build instead.
- **Vercel**: env vars and the production domain `https://granny-agent.vercel.app` (`scripts/sync-vercel-env.ts`, `vercel deploy --prod`).
- **Twilio and ElevenLabs** (`npm run setup-agent`, idempotent; `-- --check` is read-only):
  - The number was removed from ElevenLabs.
  - The Twilio number's VoiceUrl and StatusCallback now point at `/api/twilio/voice` and `/api/twilio/status`.
  - The agent accepts per-call overrides (prompt, first message, voice), uses μ-law 8000 Hz audio, and `record_details` carries `northgate_call_id`.
  - The six AI voices (IDs in `lib/ai-voices/config.ts`) were added from the public Voice Library to My Voices, keeping their IDs: `npm run setup-ai-voices` checks them and adds any that are missing (`-- --check` is read-only).
  - GB geo permissions were checked.
- **AI Voice Twin** (`npm run setup-voice-twin`, idempotent; `-- --check` is read-only):
  - It checks the bucket is private and the agent's System prompt, First message and Voice ID overrides are on. They were already on, so the agent was not changed.
  - It reports whether the ElevenLabs plan can clone voices (Starter: yes) and whether the fallback voice exists.
  - It schedules the 10-minute purge job. That job deletes clones about 24 h after they're made, because Vercel's Hobby plan only allows a daily cron.

## 1. Accept Twilio's AI/ML addendum (once)
Twilio Real-Time Transcription is covered by Twilio's *Predictive and Generative AI/ML Features Addendum*, and Twilio's guide lists accepting it as a prerequisite. It can't be checked or accepted through the API.

Open **Twilio Console → Voice → Settings → Privacy & Security** (legacy Console: Voice → Settings → General) and accept the addendum if it isn't already. Without it, calls still ring through to you but nothing is screened. The Twilio debugger shows error 95250 or a transcription error, and the dashboard shows the call with no transcript.

## 2. Put Call Guard on your phone (the customer)
1. On the customer's phone, open the personal link **in the browser** (Safari on iPhone):
   `https://granny-agent.vercel.app/protect?k=<CUSTOMER_LINK_TOKEN from .env.local>`
   It sets a sign-in cookie and opens the Call Guard page (*You're protected, Ben*). Keep the link private: anyone with it can hand your calls over.
2. **iPhone**: tap **Share → Add to Home Screen**, then open **Call Guard** from the Home Screen. iOS only allows web notifications for Home Screen apps, and it copies the sign-in when the app is added. If the Home Screen app ever says *Open your Call Guard link*, paste the link into the box on that page.
   **Android / desktop Chrome**: optionally use **Install app**.
3. Tap **Turn on alerts** and allow notifications. This arms the alarm sound and vibration for the open page, and subscribes the phone to push alerts. Then tap **Send a test alert**: a "Call Guard test alert" notification should arrive within a few seconds. If it doesn't, nothing will arrive mid-call either.
   - **iPhone:** turn alerts on from the Call Guard Home Screen app, not Safari; in Safari the card tells you this.
   - **Icons added before 7 Nov 2026:** the manifest used to be blocked for Safari, so such icons may never get notifications. Delete the icon, open your link in Safari again, then **Add to Home Screen**, open it from the new icon and turn alerts on.
   - On Android and desktop, the notification has **Use AI voice** and **Dismiss** buttons.
   - On iPhone, tapping the notification opens the full-screen alert.
   - The page also alerts live without notifications, as long as it is open.
4. **Optional: Your AI voice match.** In Call Guard, tap **Your AI voice match** (or open `/protect/settings`) and choose your age band (younger, middle, older) and gender. If you hand a scam call to the AI voice, it uses a voice of your age and gender so the caller doesn't notice the switch. Leave either unset and Call Guard works it out from what's said on the call, or uses a middle-aged voice (female unless you set male). Each tap saves straight away.

## 3. Two-phone smoke test
You need two phones: **phone A** (the "scammer", any phone) and **your phone** (the customer, with Call Guard from step 2 and the number in `CUSTOMER_PHONE_NUMBER`).

1. On a laptop, open **https://granny-agent.vercel.app**. Use any username; the password is `DASHBOARD_PASSWORD` from `.env.local`. The header should show a green **Realtime** dot.
2. From **phone A**, ring **+1 (445) 275-5928**.
   - **Your phone rings showing phone A's number** (or the Twilio number if A withholds its number).
   - The dashboard shows a new **LIVE** call with A's last three digits.
3. Answer on your phone. On phone A, run the scam from `demo/JUDGE_CARD.md` (Part 1): claim to be the Northgate fraud team and push for a "safe account" transfer.
   - **Dashboard**: the transcript fills in, with A in red and you in green. The **Live risk** gauge and its reason update every few lines.
   - **Your phone**: at the threshold (`RISK_THRESHOLD`, default 70), `/protect` turns into the full-screen alert, with a notification, sound and vibration if alerts are on. It shows **Suspected scam**, the two most suspicious things phone A has said (they update if worse ones come up), your AI Voice Twin's progress or **Use my Voice Twin**, one large **Use AI voice** button and a small **I know this caller** link. The dashboard tags the call **ALERT**.
4. **Tap Use AI voice** on your phone (or press **Take over now** on the dashboard: the same automatic voice).
   - **Your leg drops**, and your phone shows *Northgate has this call. Don't call them back.*
   - **Phone A hears the AI voice** pick up mid-conversation as you, in a voice matched to your age and gender: *"Sorry, are you still there? The line went funny for a second. You said you're from Northgate's fraud team?"*
   - **Dashboard**: the risk panel shows which voice and why, e.g. *AI voice: middle-aged male (inferred from the call)*, how it was chosen, and the character it plays (*Speaking as Steve Marsh, 52*). A divider *Northgate took over · AI voice: … · by the customer · time* appears, followed by its lines in blue.
5. On phone A, carry on (JUDGE_CARD Part 2): give payee **Daniel Price**, sort code **99-50-17**, account **41873026**, then hang up.
   - The **SUSPECTED MULE ACCOUNT** banner appears.
   - Within about a minute of hanging up, the report appears with its protection timeline, and it's emailed (Auto-send) or waits for **Approve & Send**.
6. **Also try:**
   - Tap **I know this caller** instead. The alert clears and only comes back if the risk climbs 15+ points.
   - Make an ordinary call. It is never flagged and gets no report.

> Only ring the line from phones whose owners agreed to be part of the test. Calls through the US number cost Twilio per-minute rates for the UK leg, and Real-Time Transcription and ElevenLabs minutes are charged on top.

## 4. AI Voice Twin (optional)
The customer can hand a flagged call to an **AI Voice Twin**: an ElevenLabs Instant Voice Clone of their *own* voice, which carries on the call as them. It uses the same agent, `record_details` and report pipeline as the AI voice, and is only ever used if the customer taps **Use my Voice Twin** in a scam alert. It's labelled *AI Voice Twin* everywhere, and reports call it *AI Voice Twin (consented)*. Only ever clone the consenting account holder.

### 4.1 Consent (on the customer's phone)
1. In Call Guard, tap the **AI Voice Twin** card, or open `/protect/settings`.
2. Read the explanation, then tick *"I consent to my voice being recorded during flagged calls and cloned so an AI can speak as me to suspected scammers"*. The box starts unticked. Tap **Give consent**. The app stores who consented and when, and keeps a consent log.
3. **Nothing is recorded, stored or cloned without this consent.** The database refuses audio, clones and voices for an account without consent.

What happens after consent:
- **Recording:** when a screened call is answered, only *your* side is recorded (the customer's leg, never the caller's).
  - A call's recording is only ever used if Call Guard flagged the call as a likely scam **and** you actually spoke on it. Calls picked up by voicemail or a phone's call-screening assistant (iOS, Pixel) are never used, so a greeting can't be cloned as your voice.
  - Any other call's recording is deleted when the call ends. A call whose end was never recorded counts as ended after 6 hours.
- **Cloning:** once there are at least `VOICE_TWIN_MIN_SECONDS` (15) of your speech, Northgate makes the clone straight away, in the background. The progress bar shows e.g. `9s / 15s of your voice`, with a "good quality" mark at `VOICE_TWIN_TARGET_SECONDS` (60).
  - The counter measures your real speaking time, short gaps between words included, so 15 s takes about 15–20 s of talking.
  - Silence, background noise, the ringback tone and clicks don't count.
  - Each piece of audio is levelled to the loudness ElevenLabs recommends, for a more accurate clone.
- **Personality:** the twin speaks like you did on the call. At handover, Claude reads only your own lines from the call and picks a style: energy, warmth, formality, pace, sentence length, humour, and up to three phrases you actually used.
  - It never guesses age, gender or health, and it doesn't play an elderly person.
  - If you've said too little (fewer than 3 lines or 25 words), or the analysis is slow or fails, it uses a "normal" personality: an ordinary, level-headed adult.
- **Deletion:**
  - The raw recordings are deleted as soon as the clone exists.
  - The clone is deleted automatically 24 h after it was made. Only a twin handover from the last hour can hold that off, so a stuck call row can't keep the voice alive. Clones that a crashed or timed-out run made but never recorded are found by their twin tag at ElevenLabs and deleted too.
  - **Revoke & delete** in Settings deletes everything at once: the recordings in Storage and the voice at ElevenLabs (through the API).
- **Fallback voice:** if cloning fails and `VOICE_TWIN_FALLBACK_VOICE_ID` is set, that voice is used instead and the twin shows *ready (fallback voice)*. The fallback is a clone you made by hand in the ElevenLabs dashboard, so the app never deletes it: delete it in ElevenLabs → Voices when you're done.

### 4.2 Get enough of your voice before the demo
The quickest way is **Record a sample now** in Settings:
1. Tap the button and allow the microphone.
2. Read the paragraph aloud at a relaxed pace. Recording stops by itself at 60 s, or you can tap **Stop**.
3. Every second of clear speech counts. The clone is made when you finish, so the twin is **ready** before the call starts. Settings shows *Ready until <time tomorrow>*.

You can also collect speech during real screened calls. That needs the media bridge below, because Vercel can't hold the websocket that Twilio streams audio over.

### 4.3 The media bridge (only for collecting during calls)
`services/media-bridge` is a small local Node service. When a screened call is answered, the app asks Twilio, through `/api/twilio/dial-status`, to start a Media Stream of the customer's leg only (`inbound_track` of the `<Dial>` child call) to the bridge.

The bridge:
- checks the stream's HMAC token and re-checks consent;
- decodes μ-law 8 kHz to PCM;
- counts your speaking time with the same voice-activity detector as the browser: 30 ms frames, a threshold that adapts to the line's background noise, short gaps inside sentences counted, tones and clicks rejected;
- writes WAV chunks to the private bucket;
- publishes `speech_seconds` live through the existing Realtime channel.

```bash
npm run media-bridge        # needs NGROK_AUTHTOKEN in .env.local; opens an ngrok tunnel and registers it
```
- **Restart it after updating the code** (e.g. after a `git pull`): the faster speech counter runs inside the bridge.
- **Run it before the call.** If no bridge is running, calls aren't recorded at all. The app says so: the AI Voice Twin card and Settings show **Recording during calls: on / off**.
- It registers its public `wss://…/media` URL in Supabase and heartbeats every 30 s. The app only starts streams while a bridge is up, so there's no redeploy when the ngrok URL changes. Stop it with Ctrl-C and it unregisters.
- `MEDIA_BRIDGE_PUBLIC_URL` (an `https://` or `wss://` URL that reaches the bridge) replaces ngrok. `MEDIA_BRIDGE_PORT` changes the port from 8787. `GET /healthz` reports open streams.
- Without the bridge, calls are screened and handed over exactly as before; only in-call voice collection is skipped.
- The account's static ngrok domain is `greedless-endearing-making.ngrok-free.dev`, so the bridge URL is the same every run. Checked: `/healthz` answers through the tunnel, and a stream with a forged token is refused (1008) before any audio is kept.

### 4.4 Demo: hand a scam call to your AI Voice Twin
1. Do 4.1 and 4.2 on your phone. Settings should show the twin as **ready**.
2. Run the two-phone test from step 3. When the alert appears, it shows **Use my Voice Twin** above **Use AI voice**. Tap **Use my Voice Twin**.
   - Your leg drops. Phone A hears your own voice pick up: *"Sorry, I'm back — where were we?"*
   - It carries on in the style you used on the call (not a granny). After a very short call it uses a "normal" personality.
   - The twin keeps the caller talking, asks them to spell names, sort codes and account numbers, and never agrees to anything ("it keeps saying error").
   - The dashboard shows **Northgate has the call · AI Voice Twin** with the seconds of speech used and the consent reference. The transcript labels its lines *AI Voice Twin*.
   - The report has a **Takeover: AI Voice Twin (consented)** line and a **Consent reference** (the consent timestamp).
3. **Without enough audio** (no sample, or a fresh consent): the alert shows the twin's live progress bar (*9s / 15s of your voice*) above **Use AI voice**. It switches to **Use my Voice Twin** by itself the moment the twin is ready, even while the alert is open. With no consent, it shows a small **Set up Voice Twin** link to Settings instead.
4. **Revoke & delete** in Settings afterwards. The result lists the recordings and the voice that were deleted.

Rehearse without a phone: `npx tsx scripts/simulate-call.ts safe-account --choice voice_twin`. Without a ready twin, the takeover returns `twin_unavailable` with nothing claimed, and the run continues with **Use AI voice**. Add `--expect-twin` to fail instead.

## 5. Before a live demo
- **Clear test data** (simulated calls, reports, frozen accounts) and reset auto-send: `npm run db:migrate -- --reset-demo`.
- **Rehearse without a phone**: `npx tsx scripts/simulate-call.ts safe-account --mode auto`. Use `--list` for the others. `retired-safe-account --hold-offer 60` keeps the alert open for a minute so you can look at it on `/protect`, then checks the older male voice was inferred.
- **Decide the AI voice match**: set **Your AI voice match** on the customer's phone if the voice must be fixed for the demo; otherwise it's inferred from the call.

## 6. Housekeeping (recommended)
- **Move `granny-agent-spec.md`, `granny-agent-spec2.md` and `granny-agent-spec3.md` out of this folder.** They contain live credentials, including the Twilio auth token and the ngrok token. Both are in `.gitignore` and `.vercelignore`, so they have never been committed or uploaded. If either file has been shared, rotate the keys: Twilio auth token, ElevenLabs, Anthropic, Supabase, Resend.
- `CUSTOMER_LINK_TOKEN` is the customer's only credential. To revoke every signed-in phone, generate a new one, then run `sync-vercel-env.ts CUSTOMER_LINK_TOKEN` and redeploy.
- `VERCEL_TOKEN` sits on the Vercel project but the running app never uses it, so you can delete it there. `SUPABASE_DB_URL` is only read by the build when you deploy with `-b RUN_DB_MIGRATIONS=1`; delete it if you always migrate from your own machine.
- `ELEVENLABS_VOICE_ID`, `VOICE_ID_DEREK`, `VOICE_ID_PRIYA` and `VOICE_ID_KEITH` (the old personas' voices) are no longer read: the AI voices' IDs are in `lib/ai-voices/config.ts`. You can delete them from `.env.local` and Vercel, and the four old voices from ElevenLabs My Voices if nothing else uses them.
- Reports come from Resend's test sender, which only delivers to the Resend account owner. To use other recipients, verify a domain in Resend and change `REPORT_FROM_EMAIL` / `REPORT_TO_EMAIL`.

## 7. If something doesn't work
| Symptom | Check |
|---|---|
| The number doesn't ring your phone | `npm run setup-agent -- --check`: the number's VoiceUrl must be `…/api/twilio/voice`. In the Twilio debugger, look for 13227 (geo permissions: Voice → Settings → Geo permissions → United Kingdom) or 13214 (caller ID). The account must not be a trial. |
| It rings but nothing is screened | Accept the AI/ML addendum (step 1). In the Twilio debugger, look for transcription errors 32650–32655. In `vercel logs`, look for `transcription` lines. |
| No alert on the phone | Check that `/protect` is open, or that alerts are on. On iPhone, notifications only work from the Home Screen app. The page still updates live while it's open. |
| The handover fails | The dashboard shows *Handover failed* with the reason, and the customer stays connected. Check that `ELEVENLABS_AGENT_ID` is set, that `npm run setup-agent -- --check` passes (overrides and μ-law), and `vercel logs` for `takeover`. |
| The caller hears silence after the handover | The agent's audio must be μ-law 8000 Hz in and out (setup checks this). ElevenLabs → Agents → the agent → Conversations shows whether the call connected. |
| The call ends but there's no report | Not taken over and the peak stayed below the threshold: that's by design. Taken over: ElevenLabs → Settings → Webhooks, *Granny Agent post-call* must be enabled. To rebuild a report: `npx tsx scripts/regenerate-report.ts <call id>`. |
| **Use my Voice Twin** never appears | Settings shows the state. *Collecting* means fewer than `VOICE_TWIN_MIN_SECONDS` of clear speech: record a sample. *Failed* means ElevenLabs refused the clone and no fallback is set: tap **Try again**. `npm run setup-voice-twin -- --check` shows the plan's cloning permission and the fallback voice. In `vercel logs`, look for `voice twin`. |
| No speech collected during calls | Only with consent and while `npm run media-bridge` is running (`GET /healthz`); the dial-status log line says why capture was skipped (`no_consent`, `not_needed`, `no_bridge`). |
| The AI voice is the wrong age or gender | The dashboard's risk panel and the report say why it was chosen (*from settings*, *inferred from the call* with its confidence, or *default*). Set **Your AI voice match** in Settings to fix it for every call. In `vercel logs`, look for `takeover … AI voice:`. |
| **Use AI voice** fails: voice not found | `npm run setup-ai-voices -- --check`: all six must be in My Voices. Run it without `--check` to add any that are missing. |
| Changed an env value | Run `npx tsx scripts/sync-vercel-env.ts <KEY>`, then `vercel deploy --prod --token "$VERCEL_TOKEN"`. |
