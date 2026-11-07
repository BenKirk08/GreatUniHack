import { registerTwilioCall, type RegisterCallInput } from "@/lib/elevenlabs/register-call";
import { requireEnv, serverEnv } from "@/lib/env";
import { buildFirstMessage, buildPersonaPrompt, personaVoiceId } from "@/lib/personas";
import { getVoiceMatchSetting } from "@/lib/settings";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  endChildCalls,
  getCall,
  inProgressChildCalls,
  startScreeningTranscription,
  stopTranscription,
  TwilioError,
  updateCallTwiml,
  type TwilioCredentials,
} from "@/lib/twilio";
import type { AiVoiceMatch, CallRow, PersonaId, ScreeningSegment, TakeoverKind } from "@/lib/types";
import {
  aiVoiceSummary,
  EMPTY_VOICE_MATCH_SETTING,
  isCompleteSetting,
  normaliseSetting,
  resolveVoiceMatch,
  type InferenceResult,
  type VoiceMatchSetting,
} from "@/lib/voice-match";
import { inferVoiceMatch, VOICE_MATCH_TIMEOUT_MS } from "@/lib/voice-match-infer";
import {
  deriveTwinPersonality,
  normalTwinPersonality,
  TWIN_PERSONALITY_TIMEOUT_MS,
  type TwinPersonality,
} from "@/lib/voice-twin/personality";
import { buildTwinPrompt, TWIN_FIRST_MESSAGE } from "@/lib/voice-twin/prompt";
import { twinForTakeover, type TwinTakeover } from "@/lib/voice-twin/service";
import { isCallFlagged } from "@/lib/voice-twin/store";

/** Handoff states a takeover may start from. 'failed' is final: the customer stays on the line. */
export const CLAIMABLE_STATUSES = ["none", "offered", "declined"] as const;
/** A 'requested' claim older than this belongs to a takeover whose function died (the routes allow 30 s). */
export const STALE_CLAIM_MS = 45_000;
/** Everything up to the redirect must finish inside this, leaving time to record the outcome before maxDuration. */
export const TAKEOVER_BUDGET_MS = 22_000;
/** The AI Voice Twin is looked up (consent, ready, voice still at ElevenLabs) before the claim, within this. */
export const TWIN_LOAD_TIMEOUT_MS = 4_000;
/**
 * The twin's personality is derived alongside fetching the caller's number, capped at TWIN_PERSONALITY_TIMEOUT_MS
 * (3.5 s) and never into this much of the remaining budget (kept for register-call, stopping screening and the
 * redirect). With less than TWIN_PERSONALITY_MIN_MS to spare it isn't attempted: the normal personality is used.
 */
export const TWIN_PERSONALITY_RESERVE_MS = 12_000;
export const TWIN_PERSONALITY_MIN_MS = 500;
/** Grace on top of the personality's own cap before the takeover stops waiting for it regardless. */
const TWIN_PERSONALITY_BACKSTOP_MS = 250;
/**
 * The AI voice match: the customer's setting is read within VOICE_MATCH_SETTING_TIMEOUT_MS; if it doesn't give both
 * parts, Claude infers the rest from the call within VOICE_MATCH_TIMEOUT_MS (3.5 s), never into the time kept for
 * register-call and the redirect (the same reserve as the twin's personality). Anything slow or failing gives the default.
 */
export const VOICE_MATCH_SETTING_TIMEOUT_MS = 2_000;
export const VOICE_MATCH_RESERVE_MS = TWIN_PERSONALITY_RESERVE_MS;
export const VOICE_MATCH_MIN_MS = TWIN_PERSONALITY_MIN_MS;
const VOICE_MATCH_BACKSTOP_MS = 250;

/** Simulated calls (scripts/simulate-call.ts) use CallSids starting CAsim: no Twilio or ElevenLabs calls. */
export function isSimulatedCallSid(callSid: string | null | undefined): boolean {
  return Boolean(callSid?.startsWith("CAsim"));
}

/**
 * Who picks the call up: the AI voice matched to the customer (a persona; `match` says which voice and why), or the
 * customer's own consented AI Voice Twin.
 */
export type ConnectedTakeover = { kind: "persona"; persona: PersonaId; match: AiVoiceMatch } | { kind: "voice_twin"; twin: TwinTakeover };

/**
 * What the claim records before anything else happens: the takeover kind and, for the twin, its consent reference
 * (the persona itself is only written once connected, as before). A ConnectedTakeover is accepted as is.
 */
export type TakeoverClaim = { kind: "persona" } | ConnectedTakeover | { kind: "voice_twin"; twin: TwinTakeover };

export type TakeoverResult =
  | { outcome: "connected"; call: CallRow; takeover: TakeoverKind; persona: PersonaId | null; aiVoice: AiVoiceMatch | null; simulated: boolean }
  | { outcome: "failed"; call: CallRow | null; takeover: TakeoverKind; persona: PersonaId | null; aiVoice: AiVoiceMatch | null; error: string }
  | { outcome: "conflict"; call: CallRow | null }
  /** The customer chose their AI Voice Twin but it can't be used: nothing was claimed, the call is still claimable. */
  | { outcome: "twin_unavailable"; call: CallRow | null };

export interface TakeoverRequest {
  /** "customer" or "analyst:<name>". */
  by: string;
  /**
   * The customer chose their own AI Voice Twin (never offered to analysts). Otherwise the AI voice takes the call: always
   * the automatic match (setting, inferred or default), for the customer and analysts alike; nobody picks a voice.
   */
  voiceTwin?: boolean;
}

/** Everything takeOver touches, injectable for tests. `timeoutMs` is the time left in the takeover's budget. */
export interface TakeoverDeps {
  /**
   * Atomic claim: returns the row only for the one caller that moved it to 'requested'. Also records takeover_kind
   * and, for the twin, voice_twin_consent_at / _speech_seconds / _voice_source (the DB requires the consent reference,
   * and voice_twin_expire won't retire a voice while a twin takeover is requested or connected).
   */
  claim(callId: string, by: string, takeover: TakeoverClaim): Promise<CallRow | null>;
  load(callId: string): Promise<CallRow | null>;
  /** The customer's usable AI Voice Twin, or null (not consented/ready/expired, gone, error or timeout). Never throws. */
  loadVoiceTwin(timeoutMs: number): Promise<TwinTakeover | null>;
  fetchCallerNumber(callSid: string, timeoutMs: number): Promise<string>;
  /**
   * The AI Voice Twin's personality from the customer's side of the screening transcript (deriveTwinPersonality), or
   * the normal personality. Must finish within timeoutMs; a throw, a bad value or a late answer gives the normal one.
   */
  describePersonality(input: { screening: ScreeningSegment[]; firstName: string }, timeoutMs: number): Promise<TwinPersonality>;
  /** The customer's "Your AI voice match" setting (either part may be unset). Must finish within timeoutMs. */
  loadVoiceMatchSetting(timeoutMs: number): Promise<VoiceMatchSetting>;
  /** Claude's age band and gender for the customer from the call so far (inferVoiceMatch). Must finish within timeoutMs. */
  inferVoiceMatch(screening: ScreeningSegment[], timeoutMs: number): Promise<InferenceResult>;
  registerCall(input: RegisterCallInput, timeoutMs: number): Promise<string>;
  /** Stop the `screen` transcription. Returns false if it couldn't be stopped (not fatal). */
  stopScreening(callSid: string, timeoutMs: number): Promise<boolean>;
  redirectCall(callSid: string, twiml: string, timeoutMs: number): Promise<void>;
  /** After an ambiguous redirect error (timeout/network): did Twilio apply it anyway? */
  redirectApplied(callSid: string): Promise<boolean>;
  /** Restart screening after a failed handover that had already stopped it. Never throws. */
  resumeScreening(callSid: string): Promise<void>;
  /** Backstop after the redirect: hang up the customer's leg if Twilio left it up. Never throws. */
  dropCustomerLeg(callSid: string): Promise<void>;
  /**
   * handoff_status connected, handoff_at, persona (the AI voice; null for the twin), takeover_kind, the twin fields (null
   * for the AI voice) and ai_voice_match (null for the twin).
   */
  markConnected(callId: string, takeover: ConnectedTakeover, at: Date): Promise<CallRow>;
  /** handoff_status failed with the error; for an AI voice, also which voice it tried and why. */
  markFailed(callId: string, error: string, aiVoice?: AiVoiceMatch | null): Promise<CallRow | null>;
  config(): {
    agentId: string;
    twilioNumber: string;
    customerFirstName: string;
    voiceFor(persona: PersonaId): string;
  };
  now?(): number;
}

/** A timeout/abort/network error: the request may or may not have reached Twilio. */
function isAmbiguous(error: unknown): boolean {
  if (error instanceof TwilioError) return false;
  const name = (error as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError" || error instanceof TypeError;
}

/**
 * Hand a live call over to Northgate's AI voice or the customer's AI Voice Twin (synchronous; the routes allow 30 s):
 *  0. the twin only: check the call was flagged and the twin can be used (consent, ready, not expiring, voice still at
 *     ElevenLabs) before claiming;
 *     if it can't, return twin_unavailable without claiming, so the customer can still use the AI voice
 *  1. claim it atomically (409 if someone else already did, or it isn't live/claimable): at most one handover per call
 *  2. the AI voice: match it to the customer (their setting, else inferred from the call, else the default; at most
 *     ~3.5 s, never fails the handover); the twin: its voice and prompt
 *  3. fetch the caller's number from Twilio (alongside step 2, or the twin's personality from the call so far, at most
 *     3.5 s; on any problem the normal personality) and register the call with ElevenLabs → TwiML (the same agent and
 *     northgate_call_id for both; only the prompt, first message and voice differ)
 *  4. only then touch the live call: stop the `screen` transcription, and update the call with the TwiML, which
 *     drops the customer's leg (the <Dial> has no action URL) and connects the caller to the AI voice or twin
 *  5. mark it connected (with the voice and why); on any error mark it failed and leave the customer connected
 *     (screening resumes)
 *  6. simulated calls (CAsim…) skip 3–4 (the twin check in 0 and the voice match in 2 still apply; the twin's
 *     personality is the normal one, with no model call)
 * All upstream calls share one budget, so the outcome is always recorded before the function's maxDuration.
 */
export async function takeOver(callId: string, request: TakeoverRequest, deps: TakeoverDeps = liveTakeoverDeps()): Promise<TakeoverResult> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const deadline = now() + TAKEOVER_BUDGET_MS;
  const budget = (cap: number) => {
    const left = deadline - now();
    if (left < 1_000) throw new Error("The handover took too long.");
    return Math.min(cap, left);
  };

  let twin: TwinTakeover | null = null;
  if (request.voiceTwin) {
    // The twin is only ever used inside a flagged-scam handover (flags only accumulate, so checking first is safe).
    const current = await deps.load(callId);
    if (!current || !isCallFlagged(current)) return { outcome: "twin_unavailable", call: current };
    twin = await loadTwin(deps, callId);
    if (!twin) return { outcome: "twin_unavailable", call: await deps.load(callId) };
  }
  const call = await deps.claim(callId, request.by, twin ? { kind: "voice_twin", twin } : { kind: "persona" });
  if (!call) return { outcome: "conflict", call: await deps.load(callId) };

  const simulated = isSimulatedCallSid(call.twilio_call_sid);
  const screening = call.screening_transcript ?? [];
  let aiVoice: AiVoiceMatch | null = null;
  let redirected = false;
  let screeningStopped = false;
  const kind: TakeoverKind = twin ? "voice_twin" : "persona";
  try {
    let takeover: ConnectedTakeover;
    if (simulated) {
      if (twin) {
        logPersonality(callId, normalTwinPersonality("simulated"));
        takeover = { kind: "voice_twin", twin };
      } else {
        aiVoice = await matchAiVoice(deps, callId, screening, deadline - now());
        takeover = { kind: "persona", persona: aiVoice.voice, match: aiVoice };
      }
    } else {
      const callSid = call.twilio_call_sid;
      if (!callSid) throw new Error("This call has no Twilio CallSid.");
      const cfg = deps.config();
      // All must finish before register-call; neither the personality nor the voice match ever fails the handover.
      const [from, personality, match] = await Promise.all([
        deps.fetchCallerNumber(callSid, budget(5_000)),
        twin ? twinPersonality(deps, callId, screening, cfg.customerFirstName, deadline - now()) : null,
        twin ? null : matchAiVoice(deps, callId, screening, deadline - now()),
      ]);
      aiVoice = match;
      if (twin) takeover = { kind: "voice_twin", twin };
      else if (match) takeover = { kind: "persona", persona: match.voice, match };
      else throw new Error("No AI voice was chosen.");
      const twiml = await deps.registerCall(
        {
          agent_id: cfg.agentId,
          from_number: from,
          to_number: cfg.twilioNumber,
          direction: "inbound",
          conversation_initiation_client_data: {
            dynamic_variables: { northgate_call_id: call.id },
            conversation_config_override: conversationOverride(takeover, call, cfg, personality),
          },
        },
        budget(9_000),
      );
      // Nothing on the live call has changed up to here.
      screeningStopped = await deps.stopScreening(callSid, budget(3_000));
      try {
        await deps.redirectCall(callSid, twiml, budget(7_000));
      } catch (error) {
        if (!isAmbiguous(error) || !(await deps.redirectApplied(callSid))) throw error;
        console.warn(`takeover ${callId}: the redirect timed out but Twilio applied it`);
      }
      redirected = true;
    }
    const connected = await markConnectedWithRetry(deps, callId, takeover);
    if (!simulated && call.twilio_call_sid) await deps.dropCustomerLeg(call.twilio_call_sid);
    return { outcome: "connected", call: connected, takeover: kind, persona: aiVoice?.voice ?? null, aiVoice, simulated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (redirected) {
      // The caller is already with the AI voice or twin; only our bookkeeping failed. Don't claim the handover failed.
      console.error(`takeover ${callId}: connected but could not record it`, error);
      const current = await deps.load(callId).catch(() => null);
      return { outcome: "connected", call: current ?? call, takeover: kind, persona: aiVoice?.voice ?? null, aiVoice, simulated };
    }
    console.error(`takeover ${callId} failed`, error);
    if (screeningStopped && call.twilio_call_sid) await deps.resumeScreening(call.twilio_call_sid);
    let failed: CallRow | null = null;
    for (let attempt = 0; attempt < 2 && !failed; attempt++) {
      failed = await deps.markFailed(callId, message.slice(0, 500), aiVoice).catch((e) => {
        console.error(`takeover ${callId}: could not record the failure`, e);
        return null;
      });
    }
    return { outcome: "failed", call: failed, takeover: kind, persona: aiVoice?.voice ?? null, aiVoice, error: message };
  }
}

/** `promise`, or `fallback` once `ms` have passed. Never rejects: a rejection also gives `fallback`. */
async function settleWithin<T>(promise: Promise<T>, ms: number, fallback: () => T, onError: (error: unknown) => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  try {
    return await Promise.race([promise, backstop]);
  } catch (error) {
    return onError(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The AI voice for this handover (resolveVoiceMatch): the customer's setting; for any part it leaves unset, Claude's
 * inference from the call (medium or high confidence only); else the default (middle-aged, female unless the setting
 * says otherwise). Never throws and never runs into the time kept for the rest of the handover. Logs the choice and
 * why, never the transcript.
 */
async function matchAiVoice(deps: TakeoverDeps, callId: string, screening: ScreeningSegment[], timeLeftMs: number): Promise<AiVoiceMatch> {
  const started = Date.now();
  const setting = await settleWithin(
    Promise.resolve().then(() => deps.loadVoiceMatchSetting(VOICE_MATCH_SETTING_TIMEOUT_MS)).then(normaliseSetting),
    VOICE_MATCH_SETTING_TIMEOUT_MS + VOICE_MATCH_BACKSTOP_MS,
    () => {
      console.warn(`takeover ${callId}: the AI voice setting took too long; treating it as not set`);
      return EMPTY_VOICE_MATCH_SETTING;
    },
    (error) => {
      console.error(`takeover ${callId}: could not read the AI voice setting; treating it as not set`, error);
      return EMPTY_VOICE_MATCH_SETTING;
    },
  );
  let result: InferenceResult | null = null;
  if (!isCompleteSetting(setting)) {
    const cap = Math.min(VOICE_MATCH_TIMEOUT_MS, timeLeftMs - (Date.now() - started) - VOICE_MATCH_RESERVE_MS);
    result =
      cap < VOICE_MATCH_MIN_MS
        ? { outcome: "no_time" }
        : await settleWithin<InferenceResult>(
            Promise.resolve().then(() => deps.inferVoiceMatch(screening, cap)),
            cap + VOICE_MATCH_BACKSTOP_MS,
            () => ({ outcome: "timeout" }),
            (error) => {
              console.error(`takeover ${callId}: the AI voice inference failed (${(error as Error)?.name ?? "error"})`);
              return { outcome: "failed" };
            },
          );
  }
  const match = resolveVoiceMatch(setting, result);
  console.info(`takeover ${callId}: ${aiVoiceSummary(match)} → ${match.voice} (inference: ${match.inference})`);
  return match;
}

/** The twin for a handover, or null. A dependency that throws counts as "not usable" (nothing is claimed). */
async function loadTwin(deps: TakeoverDeps, callId: string): Promise<TwinTakeover | null> {
  try {
    const twin = await deps.loadVoiceTwin(TWIN_LOAD_TIMEOUT_MS);
    if (!twin) console.info(`takeover ${callId}: the AI Voice Twin can't be used right now; nothing was claimed`);
    return twin;
  } catch (error) {
    console.error(`takeover ${callId}: could not load the AI Voice Twin`, error);
    return null;
  }
}

/** Which personality the twin got (and why it was the normal one). Never the transcript or the profile text. */
function logPersonality(callId: string, personality: TwinPersonality): void {
  const why = personality.source === "normal" && personality.reason ? ` (${personality.reason})` : "";
  console.info(`takeover ${callId}: AI Voice Twin personality: ${personality.source}${why}`);
}

/**
 * The twin's personality within the budget: at most TWIN_PERSONALITY_TIMEOUT_MS, never into the time reserved for the
 * rest of the handover, and the normal personality on a throw, a bad value or no answer in time. Never throws.
 */
async function twinPersonality(
  deps: TakeoverDeps,
  callId: string,
  screening: ScreeningSegment[],
  firstName: string,
  timeLeftMs: number,
): Promise<TwinPersonality> {
  const cap = Math.min(TWIN_PERSONALITY_TIMEOUT_MS, timeLeftMs - TWIN_PERSONALITY_RESERVE_MS);
  let personality: TwinPersonality;
  if (cap < TWIN_PERSONALITY_MIN_MS) {
    personality = normalTwinPersonality("no_time");
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<TwinPersonality>((resolve) => {
      timer = setTimeout(() => resolve(normalTwinPersonality("timeout")), cap + TWIN_PERSONALITY_BACKSTOP_MS);
    });
    try {
      const derived = Promise.resolve().then(() => deps.describePersonality({ screening, firstName }, cap));
      const result = await Promise.race([derived, backstop]);
      personality = typeof result?.profile === "string" && result.profile.trim() ? result : normalTwinPersonality("invalid_output");
    } catch (error) {
      console.error(`takeover ${callId}: could not derive the AI Voice Twin's personality (${(error as Error)?.name ?? "error"})`);
      personality = normalTwinPersonality("model_error");
    } finally {
      clearTimeout(timer);
    }
  }
  logPersonality(callId, personality);
  return personality;
}

type ConversationOverride = RegisterCallInput["conversation_initiation_client_data"]["conversation_config_override"];

/** The AI voice's prompt, opening line and voice, or the twin's (the same agent and override fields either way). */
function conversationOverride(
  takeover: ConnectedTakeover,
  call: CallRow,
  cfg: ReturnType<TakeoverDeps["config"]>,
  personality: TwinPersonality | null,
): ConversationOverride {
  const screening = call.screening_transcript ?? [];
  if (takeover.kind === "voice_twin") {
    return {
      agent: {
        prompt: {
          prompt: buildTwinPrompt({
            victimFirstName: cfg.customerFirstName,
            screening,
            personality: personality ?? normalTwinPersonality("model_error"),
          }),
        },
        first_message: TWIN_FIRST_MESSAGE,
      },
      tts: { voice_id: takeover.twin.voiceId },
    };
  }
  const { persona } = takeover;
  const claimedOrg = call.intel?.impersonated_org ?? call.agent_notes?.claimed_organisation;
  return {
    agent: {
      prompt: { prompt: buildPersonaPrompt({ persona, scamType: call.risk?.scam_type, claimedOrg, screening }) },
      first_message: buildFirstMessage(persona, claimedOrg),
    },
    tts: { voice_id: cfg.voiceFor(persona) },
  };
}

async function markConnectedWithRetry(deps: TakeoverDeps, callId: string, takeover: ConnectedTakeover): Promise<CallRow> {
  const at = new Date();
  try {
    return await deps.markConnected(callId, takeover, at);
  } catch (error) {
    console.warn(`takeover ${callId}: retrying the connected update`, error);
    return deps.markConnected(callId, takeover, at);
  }
}

/* ---------- live dependencies ---------- */

function twilioCreds(): TwilioCredentials {
  const env = serverEnv();
  return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET };
}

/**
 * calls.takeover_kind, the twin's columns (consent reference, speech seconds, voice source; null for the AI voice) and
 * ai_voice_match (which AI voice and why: only once it is known, so a claim clears any from an earlier failed attempt).
 */
export function takeoverColumns(takeover: TakeoverClaim): Pick<
  CallRow,
  "takeover_kind" | "voice_twin_consent_at" | "voice_twin_speech_seconds" | "voice_twin_voice_source" | "ai_voice_match"
> {
  if (takeover.kind === "voice_twin") {
    return {
      takeover_kind: "voice_twin",
      voice_twin_consent_at: takeover.twin.consentGivenAt,
      voice_twin_speech_seconds: takeover.twin.speechSeconds,
      voice_twin_voice_source: takeover.twin.voiceSource,
      ai_voice_match: null,
    };
  }
  return {
    takeover_kind: "persona",
    voice_twin_consent_at: null,
    voice_twin_speech_seconds: null,
    voice_twin_voice_source: null,
    ai_voice_match: "match" in takeover ? takeover.match : null,
  };
}

export function liveTakeoverDeps(): TakeoverDeps {
  const db = supabaseAdmin();
  return {
    async claim(callId, by, takeover) {
      const now = new Date();
      const stale = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
      const { data, error } = await db
        .from("calls")
        .update({
          handoff_status: "requested",
          handoff_by: by,
          handoff_error: null,
          handoff_requested_at: now.toISOString(),
          ...takeoverColumns(takeover),
        })
        .eq("id", callId)
        .eq("status", "live")
        // claimable, or a 'requested' claim whose takeover died (older than the routes' maxDuration allows)
        .or(`handoff_status.in.(${CLAIMABLE_STATUSES.join(",")}),and(handoff_status.eq.requested,handoff_requested_at.lt.${stale})`)
        .select("*");
      if (error) throw new Error(`takeover claim failed: ${error.message}`);
      return ((data ?? []) as CallRow[])[0] ?? null;
    },
    async load(callId) {
      const { data } = await db.from("calls").select("*").eq("id", callId).maybeSingle<CallRow>();
      return data ?? null;
    },
    async loadVoiceTwin(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`takeover: the AI Voice Twin check took longer than ${timeoutMs}ms`);
          resolve(null);
        }, timeoutMs);
      });
      try {
        return await Promise.race([twinForTakeover(), timedOut]);
      } catch (error) {
        console.error("takeover: could not check the AI Voice Twin", error);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async fetchCallerNumber(callSid, timeoutMs) {
      return (await getCall(twilioCreds(), callSid, timeoutMs)).from;
    },
    async describePersonality(input, timeoutMs) {
      return deriveTwinPersonality(input, { timeoutMs });
    },
    async loadVoiceMatchSetting() {
      return getVoiceMatchSetting();
    },
    async inferVoiceMatch(screening, timeoutMs) {
      return inferVoiceMatch(screening, { timeoutMs });
    },
    async registerCall(input, timeoutMs) {
      return registerTwilioCall(serverEnv().ELEVENLABS_API_KEY, input, timeoutMs);
    },
    async stopScreening(callSid, timeoutMs) {
      try {
        await stopTranscription(twilioCreds(), callSid, "screen", timeoutMs);
        return true;
      } catch (error) {
        // Not fatal: the transcription route ignores segments once a takeover is under way.
        if (error instanceof TwilioError && error.status === 404) return false;
        console.warn(`takeover: could not stop the screen transcription on ${callSid}`, error);
        return false;
      }
    },
    async redirectCall(callSid, twiml, timeoutMs) {
      await updateCallTwiml(twilioCreds(), callSid, twiml, timeoutMs);
    },
    async redirectApplied(callSid) {
      try {
        const call = await getCall(twilioCreds(), callSid, 3_000);
        if (call.status !== "in-progress") return false;
        return (await inProgressChildCalls(twilioCreds(), callSid, 3_000)).length === 0;
      } catch {
        return false;
      }
    },
    async resumeScreening(callSid) {
      const base = serverEnv().PUBLIC_BASE_URL;
      if (!base) return;
      for (const name of ["screen", `screen-${Date.now().toString(36)}`]) {
        try {
          await startScreeningTranscription(twilioCreds(), callSid, base, name, 4_000);
          console.info(`takeover: screening resumed on ${callSid} (${name})`);
          return;
        } catch (error) {
          console.warn(`takeover: could not resume screening on ${callSid} as ${name}`, error);
        }
      }
    },
    async dropCustomerLeg(callSid) {
      try {
        const ended = await endChildCalls(twilioCreds(), callSid, 3_000);
        if (ended) console.info(`takeover: ended ${ended} customer leg(s) Twilio left up on ${callSid}`);
      } catch (error) {
        console.warn(`takeover: could not check the customer leg on ${callSid}`, error);
      }
    },
    async markConnected(callId, takeover, at) {
      const { data, error } = await db
        .from("calls")
        .update({
          handoff_status: "connected",
          handoff_at: at.toISOString(),
          persona: takeover.kind === "persona" ? takeover.persona : null,
          handoff_error: null,
          ...takeoverColumns(takeover),
        })
        .eq("id", callId)
        .select("*")
        .single<CallRow>();
      if (error) throw new Error(`could not mark the call connected: ${error.message}`);
      return data;
    },
    async markFailed(callId, message, aiVoice) {
      const { data, error } = await db
        .from("calls")
        .update({
          handoff_status: "failed",
          handoff_error: message,
          // The voice it tried, so the dashboard and report say "AI voice: … — handover failed".
          ...(aiVoice ? { persona: aiVoice.voice, ai_voice_match: aiVoice } : {}),
        })
        .eq("id", callId)
        .eq("handoff_status", "requested")
        .select("*")
        .maybeSingle<CallRow>();
      if (error) throw new Error(error.message);
      return data ?? null;
    },
    config() {
      const env = serverEnv();
      return {
        agentId: requireEnv("ELEVENLABS_AGENT_ID"),
        twilioNumber: env.TWILIO_PHONE_NUMBER,
        customerFirstName: env.CUSTOMER_FIRST_NAME,
        voiceFor: (persona) => personaVoiceId(persona),
      };
    },
  };
}
