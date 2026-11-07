import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { customerCall, CUSTOMER_COLUMNS } from "@/lib/customer-view";
import { offerPayload } from "@/lib/push";
import {
  CLAIMABLE_STATUSES,
  isSimulatedCallSid,
  takeOver,
  takeoverColumns,
  TWIN_LOAD_TIMEOUT_MS,
  TWIN_PERSONALITY_RESERVE_MS,
  VOICE_MATCH_RESERVE_MS,
  type ConnectedTakeover,
  type TakeoverDeps,
} from "@/lib/takeover";
import { customerTakeoverResponse, takeoverResponse, TWIN_UNAVAILABLE_MESSAGE } from "@/lib/takeover-http";
import type { CallRow, HandoffStatus, VoiceTwinRow } from "@/lib/types";
import type { InferenceResult } from "@/lib/voice-match";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";
import { NORMAL_TWIN_PROFILE, TWIN_PERSONALITY_TIMEOUT_MS, type TwinPersonality } from "@/lib/voice-twin/personality";
import { TWIN_FIRST_MESSAGE } from "@/lib/voice-twin/prompt";
import { twinForTakeover, type TwinTakeover } from "@/lib/voice-twin/service";
import { resolveVoiceMatch } from "@/lib/voice-match";
import { VOICE_MATCH_TIMEOUT_MS } from "@/lib/voice-match-infer";

function makeCall(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversation_id: null,
    twilio_call_sid: "CA0123456789abcdef0123456789abcdef",
    caller_masked: "•••481",
    direction: "inbound",
    status: "live",
    started_at: "2026-11-06T12:00:00.000Z",
    ended_at: null,
    screening_transcript: [
      { speaker: "caller", text: "This is HMRC, you owe tax and face arrest.", at: "2026-11-06T12:00:05.000Z" },
      { speaker: "customer", text: "What?", at: "2026-11-06T12:00:07.000Z" },
    ],
    risk: { score: 88, peak: 88, scam_type: "hmrc", tactics: ["fear"], reason: "Threatening arrest.", segments_scored: 2, scored_at: "2026-11-06T12:00:08.000Z" },
    handoff_status: "offered",
    handoff_by: null,
    handoff_at: null,
    handoff_requested_at: null,
    handoff_error: null,
    persona: null,
    offered_at: null,
    declined_score: null,
    transcript: [],
    intel: null,
    intel_turns: 0,
    intel_claimed_at: null,
    mule_match: null,
    agent_notes: {},
    updated_at: "2026-11-06T12:00:08.000Z",
    ...overrides,
  };
}

/** What the (faked) personality derivation returns for the call: upbeat and casual, like the real customer. */
const DERIVED: TwinPersonality = {
  source: "conversation",
  profile: 'the same as on the call so far — upbeat, warm and friendly, casual, everyday words, short sentences and a quick pace. They say things like "okay okay"; use these naturally, not in every reply.',
};

const TWIN: TwinTakeover = {
  voiceId: "twin-voice-1",
  voiceSource: "clone",
  consentGivenAt: "2026-11-05T09:30:00.000Z",
  speechSeconds: 42.5,
};

const INFERRED_MIDDLE_MALE: InferenceResult = { outcome: "inferred", inference: { age_band: "middle", gender: "male", confidence: "high" } };

/** In-memory deps whose claim is atomic like the SQL UPDATE … WHERE handoff_status IN (…) RETURNING *. */
function fakeDeps(row: CallRow, overrides: Partial<TakeoverDeps> = {}) {
  const state = { row: { ...row } };
  const log: string[] = [];
  const deps: TakeoverDeps = {
    claim: vi.fn(async (_id: string, by: string, takeover) => {
      await Promise.resolve();
      const r = state.row;
      if (r.status !== "live" || !(CLAIMABLE_STATUSES as readonly HandoffStatus[]).includes(r.handoff_status)) return null;
      state.row = { ...r, handoff_status: "requested", handoff_by: by, ...takeoverColumns(takeover) };
      return { ...state.row };
    }),
    load: vi.fn(async () => ({ ...state.row })),
    loadVoiceTwin: vi.fn(async () => null),
    fetchCallerNumber: vi.fn(async () => {
      log.push("fetchFrom");
      await new Promise((r) => setTimeout(r, 5));
      return "+447700900481";
    }),
    describePersonality: vi.fn(async () => DERIVED),
    // No AI voice match setting; Claude infers a middle-aged man from the call ("Sir", working-age cues).
    loadVoiceMatchSetting: vi.fn(async () => ({ ageBand: null, gender: null })),
    inferVoiceMatch: vi.fn(async () => INFERRED_MIDDLE_MALE),
    registerCall: vi.fn(async () => {
      log.push("registerCall");
      await new Promise((r) => setTimeout(r, 5));
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.elevenlabs.io/x"/></Connect></Response>';
    }),
    stopScreening: vi.fn(async () => {
      log.push("stopScreening");
      return true;
    }),
    redirectCall: vi.fn(async () => {
      log.push("redirectCall");
    }),
    redirectApplied: vi.fn(async () => false),
    resumeScreening: vi.fn(async () => {
      log.push("resumeScreening");
    }),
    dropCustomerLeg: vi.fn(async () => {
      log.push("dropCustomerLeg");
    }),
    markConnected: vi.fn(async (_id, takeover: ConnectedTakeover, at) => {
      state.row = {
        ...state.row,
        handoff_status: "connected",
        persona: takeover.kind === "persona" ? takeover.persona : null,
        handoff_at: at.toISOString(),
        ...takeoverColumns(takeover),
      };
      return { ...state.row };
    }),
    markFailed: vi.fn(async (_id, error, aiVoice) => {
      state.row = { ...state.row, handoff_status: "failed", handoff_error: error, ...(aiVoice ? { persona: aiVoice.voice, ai_voice_match: aiVoice } : {}) };
      return { ...state.row };
    }),
    config: () => ({ agentId: "agent_x", twilioNumber: "+14452755928", customerFirstName: "Ben", voiceFor: (p) => `voice-${p}` }),
    ...overrides,
  };
  return { deps, state, log };
}

describe("takeover", () => {
  it("is idempotent: two concurrent claims lead to exactly one register-call", async () => {
    const { deps } = fakeDeps(makeCall());
    const [a, b] = await Promise.all([takeOver("id", { by: "customer" }, deps), takeOver("id", { by: "analyst:Priya" }, deps)]);
    expect(deps.registerCall).toHaveBeenCalledTimes(1);
    expect(deps.redirectCall).toHaveBeenCalledTimes(1);
    expect([a.outcome, b.outcome].sort()).toEqual(["conflict", "connected"]);
  });

  it("returns a conflict for a call that isn't live or is already being taken over", async () => {
    for (const row of [makeCall({ status: "ended" }), makeCall({ handoff_status: "connected" }), makeCall({ handoff_status: "failed" })]) {
      const { deps } = fakeDeps(row);
      expect((await takeOver("id", { by: "customer" }, deps)).outcome).toBe("conflict");
      expect(deps.registerCall).not.toHaveBeenCalled();
    }
  });

  it("registers the call with the matched AI voice's prompt, opening line, voice and northgate_call_id, then stops screening and redirects", async () => {
    const { deps, log, state } = fakeDeps(makeCall());
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result).toMatchObject({ outcome: "connected", takeover: "persona", persona: "middle_male", simulated: false });
    expect(result.outcome === "connected" && result.aiVoice).toMatchObject({ voice: "middle_male", source: "inferred", inference: "used" });
    expect(log).toEqual(["fetchFrom", "registerCall", "stopScreening", "redirectCall", "dropCustomerLeg"]);
    expect(deps.loadVoiceTwin).not.toHaveBeenCalled();
    expect(deps.describePersonality).not.toHaveBeenCalled();
    expect(vi.mocked(deps.claim).mock.calls[0][2]).toEqual({ kind: "persona" });
    expect(vi.mocked(deps.markConnected).mock.calls[0][1]).toMatchObject({ kind: "persona", persona: "middle_male", match: { source: "inferred" } });
    const input = vi.mocked(deps.registerCall).mock.calls[0][0];
    expect(input).toMatchObject({ agent_id: "agent_x", from_number: "+447700900481", to_number: "+14452755928", direction: "inbound" });
    const data = input.conversation_initiation_client_data;
    expect(data.dynamic_variables).toEqual({ northgate_call_id: makeCall().id });
    expect(data.conversation_config_override.tts.voice_id).toBe("voice-middle_male");
    expect(data.conversation_config_override.agent.first_message).toBe("Sorry, are you still there? Lost you for a second. Who did you say you were calling from?");
    const prompt = data.conversation_config_override.agent.prompt.prompt;
    expect(prompt).toMatch(/^You are Steve Marsh, 52/);
    expect(prompt).toContain("Caller: This is HMRC, you owe tax and face arrest.");
    expect(prompt).toContain("They claim to be HMRC"); // the scam type's playbook, from risk.scam_type
    expect(prompt).not.toContain("Your personality and way of speaking");
    expect(state.row).toMatchObject({ handoff_status: "connected", persona: "middle_male", handoff_by: "customer", takeover_kind: "persona" });
    expect(state.row.ai_voice_match).toMatchObject({ voice: "middle_male", age_band: "middle", gender: "male", source: "inferred", confidence: "high" });
    expect(state.row).toMatchObject({ voice_twin_consent_at: null, voice_twin_speech_seconds: null, voice_twin_voice_source: null });
    expect(state.row.handoff_at).toBeTruthy();
  });

  it("runs the voice match alongside fetching the caller's number, within the budget", async () => {
    const { deps } = fakeDeps(makeCall());
    await takeOver("id", { by: "customer" }, deps);
    expect(deps.loadVoiceMatchSetting).toHaveBeenCalledTimes(1);
    expect(deps.inferVoiceMatch).toHaveBeenCalledTimes(1);
    const [screening, timeoutMs] = vi.mocked(deps.inferVoiceMatch).mock.calls[0];
    expect(screening).toEqual(makeCall().screening_transcript);
    expect(timeoutMs).toBeLessThanOrEqual(VOICE_MATCH_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThan(3_000);
  });

  it("uses the customer's AI Voice Twin when they pick it (no voice match)", async () => {
    const twin = fakeDeps(makeCall(), { loadVoiceTwin: vi.fn(async () => TWIN) });
    expect(await takeOver("id", { by: "customer", voiceTwin: true }, twin.deps)).toMatchObject({
      outcome: "connected",
      takeover: "voice_twin",
      persona: null,
      aiVoice: null,
    });
    expect(twin.deps.inferVoiceMatch).not.toHaveBeenCalled();
    expect(twin.state.row.ai_voice_match).toBeNull();
  });

  it("gives the analyst's \"Take over now\" the same automatic choice", async () => {
    const setting = { ageBand: "older", gender: "female" } as const;
    const customer = fakeDeps(makeCall(), { loadVoiceMatchSetting: vi.fn(async () => setting) });
    const analyst = fakeDeps(makeCall(), { loadVoiceMatchSetting: vi.fn(async () => setting) });
    await takeOver("id", { by: "customer" }, customer.deps);
    await takeOver("id", { by: "analyst:Sam" }, analyst.deps);
    for (const { deps, state } of [customer, analyst]) {
      expect(vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.tts.voice_id).toBe(
        "voice-older_female",
      );
      expect(state.row).toMatchObject({ persona: "older_female", ai_voice_match: { source: "setting" } });
    }
    expect(analyst.state.row.handoff_by).toBe("analyst:Sam");
  });

  it("changes nothing on the live call when register-call fails, and marks the handover failed", async () => {
    const { deps, state } = fakeDeps(makeCall(), {
      registerCall: vi.fn(async () => {
        throw new Error("ElevenLabs POST /v1/convai/twilio/register-call → 422: bad override");
      }),
    });
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result.outcome).toBe("failed");
    expect(deps.stopScreening).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(state.row).toMatchObject({ handoff_status: "failed" });
    expect(state.row.handoff_error).toContain("422");
    // The voice it tried, and why, are recorded with the failure.
    expect(state.row).toMatchObject({ persona: "middle_male", ai_voice_match: { voice: "middle_male", source: "inferred" } });
  });

  it("marks the handover failed when the redirect fails, leaves the customer connected and resumes screening", async () => {
    const { TwilioError } = await import("@/lib/twilio");
    const { deps, state, log } = fakeDeps(makeCall(), {
      redirectCall: vi.fn(async () => {
        throw new TwilioError("Twilio POST … → 400: Call is not in-progress", 400, 21220, null);
      }),
    });
    expect((await takeOver("id", { by: "customer" }, deps)).outcome).toBe("failed");
    expect(state.row.handoff_status).toBe("failed");
    expect(log).toContain("resumeScreening");
    expect(deps.redirectApplied).not.toHaveBeenCalled();
  });

  it("treats a timed-out redirect as connected when Twilio shows it was applied", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { deps, state } = fakeDeps(makeCall(), {
      redirectCall: vi.fn(async () => {
        throw timeout;
      }),
      redirectApplied: vi.fn(async () => true),
    });
    expect((await takeOver("id", { by: "customer" }, deps)).outcome).toBe("connected");
    expect(state.row.handoff_status).toBe("connected");
    expect(deps.resumeScreening).not.toHaveBeenCalled();
  });

  it("gives up inside its time budget, before touching the call, when the upstream calls are slow", async () => {
    let clock = 0;
    const { deps, state } = fakeDeps(makeCall(), {
      now: () => clock,
      registerCall: vi.fn(async (_input, timeoutMs: number) => {
        expect(timeoutMs).toBeLessThanOrEqual(9_000);
        clock += 21_500; // ElevenLabs is slow: the budget is nearly spent
        return '<?xml version="1.0"?><Response><Connect><Stream url="wss://x"/></Connect></Response>';
      }),
    });
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result.outcome).toBe("failed");
    expect(deps.stopScreening).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(state.row.handoff_error).toMatch(/too long/);
  });

  it("still reports connected if only our bookkeeping fails after the redirect", async () => {
    const { deps } = fakeDeps(makeCall(), {
      markConnected: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result.outcome).toBe("connected");
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("skips Twilio and ElevenLabs for simulated calls (CAsim…), but still matches the AI voice", async () => {
    const { deps, state } = fakeDeps(makeCall({ twilio_call_sid: `CAsim${"a".repeat(30)}` }));
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result).toMatchObject({ outcome: "connected", simulated: true, persona: "middle_male", takeover: "persona" });
    expect(deps.inferVoiceMatch).toHaveBeenCalledTimes(1);
    expect(state.row.ai_voice_match).toMatchObject({ voice: "middle_male", source: "inferred" });
    expect(deps.fetchCallerNumber).not.toHaveBeenCalled();
    expect(deps.registerCall).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(deps.dropCustomerLeg).not.toHaveBeenCalled();
    expect(state.row.handoff_status).toBe("connected");
    expect(isSimulatedCallSid("CA123")).toBe(false);
  });
});

describe("AI voice matching on handover", () => {
  const setting = (ageBand: "younger" | "middle" | "older" | null, gender: "male" | "female" | null) => vi.fn(async () => ({ ageBand, gender }));
  const inferred = (age_band: "younger" | "middle" | "older" | "unknown", gender: "male" | "female" | "unknown", confidence: "low" | "medium" | "high") =>
    vi.fn(async (): Promise<InferenceResult> => ({ outcome: "inferred", inference: { age_band, gender, confidence } }));
  const voiceOf = (deps: TakeoverDeps) =>
    vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.tts.voice_id;

  it("uses the setting over anything inferred from the call (no inference at all)", async () => {
    const { deps, state } = fakeDeps(makeCall(), { loadVoiceMatchSetting: setting("older", "female"), inferVoiceMatch: inferred("younger", "male", "high") });
    const result = await takeOver("id", { by: "customer" }, deps);
    expect(result).toMatchObject({ outcome: "connected", persona: "older_female" });
    expect(deps.inferVoiceMatch).not.toHaveBeenCalled();
    expect(voiceOf(deps)).toBe("voice-older_female");
    expect(state.row.ai_voice_match).toEqual({
      voice: "older_female",
      age_band: "older",
      gender: "female",
      source: "setting",
      age_from: "setting",
      gender_from: "setting",
      confidence: null,
      inference: "not_needed",
    });
  });

  it("uses the inference when there is no setting", async () => {
    const { deps, state } = fakeDeps(makeCall(), { inferVoiceMatch: inferred("younger", "female", "medium") });
    await takeOver("id", { by: "customer" }, deps);
    expect(voiceOf(deps)).toBe("voice-younger_female");
    expect(state.row.ai_voice_match).toMatchObject({ voice: "younger_female", source: "inferred", confidence: "medium", inference: "used" });
  });

  it("fills only the parts the setting leaves unset from the inference", async () => {
    const { deps, state } = fakeDeps(makeCall(), { loadVoiceMatchSetting: setting(null, "female"), inferVoiceMatch: inferred("older", "male", "high") });
    await takeOver("id", { by: "customer" }, deps);
    expect(state.row.ai_voice_match).toMatchObject({ voice: "older_female", source: "inferred", age_from: "inferred", gender_from: "setting" });
  });

  it("falls back to the default (middle-aged, female) on low confidence", async () => {
    const { deps, state } = fakeDeps(makeCall(), { inferVoiceMatch: inferred("older", "male", "low") });
    await takeOver("id", { by: "customer" }, deps);
    expect(voiceOf(deps)).toBe("voice-middle_female");
    expect(state.row.ai_voice_match).toMatchObject({ voice: "middle_female", source: "default", confidence: "low", inference: "low_confidence" });
  });

  it("falls back to the default when there is no data, matching the setting's gender if it has one", async () => {
    const empty = makeCall({ screening_transcript: [] });
    const none = fakeDeps(empty, { inferVoiceMatch: vi.fn(async (): Promise<InferenceResult> => ({ outcome: "no_data" })) });
    await takeOver("id", { by: "customer" }, none.deps);
    expect(none.state.row.ai_voice_match).toMatchObject({ voice: "middle_female", source: "default", inference: "no_data" });
    const male = fakeDeps(empty, { loadVoiceMatchSetting: setting(null, "male"), inferVoiceMatch: vi.fn(async (): Promise<InferenceResult> => ({ outcome: "no_data" })) });
    await takeOver("id", { by: "customer" }, male.deps);
    expect(male.state.row.ai_voice_match).toMatchObject({ voice: "middle_male", source: "default", gender_from: "setting", age_from: "default" });
  });

  it("never lets the voice match fail or stall the handover", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => {
      error.mockRestore();
      warn.mockRestore();
    });
    const failures: Partial<TakeoverDeps>[] = [
      { inferVoiceMatch: vi.fn(async () => Promise.reject(new Error("anthropic down"))) },
      { inferVoiceMatch: vi.fn(() => new Promise<InferenceResult>(() => undefined)) },
      { loadVoiceMatchSetting: vi.fn(async () => Promise.reject(new Error("supabase down"))), inferVoiceMatch: inferred("older", "female", "high") },
    ];
    const outcomes: unknown[] = [];
    for (const overrides of failures) {
      const { deps, state } = fakeDeps(makeCall(), overrides);
      const running = takeOver("id", { by: "customer" }, deps);
      await vi.advanceTimersByTimeAsync(VOICE_MATCH_TIMEOUT_MS + 1_000);
      expect((await running).outcome).toBe("connected");
      outcomes.push(state.row.ai_voice_match);
    }
    expect(outcomes[0]).toMatchObject({ voice: "middle_female", source: "default", inference: "failed" });
    expect(outcomes[1]).toMatchObject({ voice: "middle_female", source: "default", inference: "timeout" });
    // A setting that can't be read counts as not set: the inference decides.
    expect(outcomes[2]).toMatchObject({ voice: "older_female", source: "inferred" });
  });

  it("doesn't spend the time the rest of the handover needs on the inference", async () => {
    let clock = 0;
    const { deps, state } = fakeDeps(makeCall(), {
      now: () => clock,
      claim: vi.fn(async (_id, by, takeover) => {
        clock += 22_000 - VOICE_MATCH_RESERVE_MS - 200; // a slow claim leaves under 0.5 s for the inference
        return { ...makeCall(), handoff_status: "requested" as const, handoff_by: by, ...takeoverColumns(takeover) };
      }),
    });
    await takeOver("id", { by: "customer" }, deps);
    expect(deps.inferVoiceMatch).not.toHaveBeenCalled();
    expect(vi.mocked(deps.markConnected).mock.calls[0][1]).toMatchObject({ persona: "middle_female", match: { source: "default", inference: "no_time" } });
    expect(state.row).toBeTruthy();
  });

  it("never hands a call over more than once: one claim, one voice match, one register-call", async () => {
    const { deps, state } = fakeDeps(makeCall(), { loadVoiceMatchSetting: setting("older", "male") });
    const results = await Promise.all([
      takeOver("id", { by: "customer" }, deps),
      takeOver("id", { by: "analyst:Sam" }, deps),
      takeOver("id", { by: "customer" }, deps),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["conflict", "conflict", "connected"]);
    expect(deps.loadVoiceMatchSetting).toHaveBeenCalledTimes(1);
    expect(deps.registerCall).toHaveBeenCalledTimes(1);
    expect(deps.redirectCall).toHaveBeenCalledTimes(1);
    expect(deps.markConnected).toHaveBeenCalledTimes(1);
    // A later tap (customer or analyst) is a conflict too, and changes nothing.
    expect((await takeOver("id", { by: "customer" }, deps)).outcome).toBe("conflict");
    expect((await takeOver("id", { by: "analyst:Sam" }, deps)).outcome).toBe("conflict");
    expect(deps.registerCall).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({ handoff_status: "connected", persona: "older_male" });
  });
});

describe("takeover by the AI Voice Twin", () => {
  const twinDeps = (row: CallRow = makeCall(), overrides: Partial<TakeoverDeps> = {}) =>
    fakeDeps(row, { loadVoiceTwin: vi.fn(async () => TWIN), ...overrides });

  it("registers the same agent and northgate_call_id with the twin's voice, opening line and prompt", async () => {
    const { deps, log } = twinDeps();
    const result = await takeOver("id", { by: "customer", voiceTwin: true }, deps);
    expect(result).toMatchObject({ outcome: "connected", takeover: "voice_twin", persona: null, simulated: false });
    expect(log).toEqual(["fetchFrom", "registerCall", "stopScreening", "redirectCall", "dropCustomerLeg"]);
    expect(deps.registerCall).toHaveBeenCalledTimes(1);
    const input = vi.mocked(deps.registerCall).mock.calls[0][0];
    expect(input).toMatchObject({ agent_id: "agent_x", from_number: "+447700900481", to_number: "+14452755928", direction: "inbound" });
    const data = input.conversation_initiation_client_data;
    expect(data.dynamic_variables).toEqual({ northgate_call_id: makeCall().id });
    expect(data.conversation_config_override.tts.voice_id).toBe("twin-voice-1");
    expect(data.conversation_config_override.agent.first_message).toBe(TWIN_FIRST_MESSAGE);
    expect(TWIN_FIRST_MESSAGE).toBe("Sorry, I'm back — where were we?");
    const prompt = data.conversation_config_override.agent.prompt.prompt;
    expect(prompt).toMatch(/^You are continuing a phone call as Ben, speaking in their voice\./);
    expect(prompt).toContain("Caller: This is HMRC, you owe tax and face arrest.");
    expect(prompt).toContain("Ben: What?");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("Derek");
    // The personality derived from this call goes into the prompt; no granny stall.
    expect(prompt).toContain(`Match the victim's way of speaking from that transcript. Your personality and way of speaking: ${DERIVED.profile} Your goals are`);
    expect(prompt).not.toContain("slow and confused");
    expect(deps.describePersonality).toHaveBeenCalledTimes(1);
    const [personalityInput, timeoutMs] = vi.mocked(deps.describePersonality).mock.calls[0];
    expect(personalityInput).toEqual({ screening: makeCall().screening_transcript, firstName: "Ben" });
    expect(timeoutMs).toBeLessThanOrEqual(TWIN_PERSONALITY_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThan(3_000);
  });

  it("derives the personality in parallel with fetching the caller's number; both finish before register-call", async () => {
    const events: string[] = [];
    const { deps } = twinDeps(makeCall(), {
      fetchCallerNumber: vi.fn(async () => {
        events.push("fetch:start");
        await new Promise((r) => setTimeout(r, 30));
        events.push("fetch:end");
        return "+447700900481";
      }),
      describePersonality: vi.fn(async () => {
        events.push("personality:start");
        await new Promise((r) => setTimeout(r, 60));
        events.push("personality:end");
        return DERIVED;
      }),
      registerCall: vi.fn(async () => {
        events.push("registerCall");
        return "<Response/>";
      }),
    });
    expect((await takeOver("id", { by: "customer", voiceTwin: true }, deps)).outcome).toBe("connected");
    // Both start before either ends (in parallel, not in series), and register-call waits for the slower one.
    expect(events).toEqual(["fetch:start", "personality:start", "fetch:end", "personality:end", "registerCall"]);
    expect(vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt).toContain(
      DERIVED.profile,
    );
  });

  it("falls back to the normal personality, without failing the handover, when the derivation is slow", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { deps, state } = twinDeps(makeCall(), { describePersonality: vi.fn(() => new Promise<TwinPersonality>(() => undefined)) });
      const pending = takeOver("id", { by: "customer", voiceTwin: true }, deps);
      await vi.advanceTimersByTimeAsync(TWIN_PERSONALITY_TIMEOUT_MS + 1_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "connected", takeover: "voice_twin" });
      expect(state.row.handoff_status).toBe("connected");
      const prompt = vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt;
      expect(prompt).toContain(`Your personality and way of speaking: ${NORMAL_TWIN_PROFILE} Your goals are`);
      expect(info.mock.calls.map((c) => String(c[0]))).toContain("takeover id: AI Voice Twin personality: normal (timeout)");
    } finally {
      vi.useRealTimers();
      info.mockRestore();
    }
  });

  it("falls back to the normal personality, without failing the handover, when the derivation fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failures: TakeoverDeps["describePersonality"][] = [
        vi.fn(async () => Promise.reject(new Error("Anthropic 529 overloaded"))),
        vi.fn(() => {
          throw new TypeError("not a function");
        }),
        vi.fn(async () => ({ source: "conversation", profile: "   " }) as TwinPersonality),
        vi.fn(async () => null as unknown as TwinPersonality),
      ];
      for (const describePersonality of failures) {
        const { deps, state } = twinDeps(makeCall(), { describePersonality });
        expect(await takeOver("id", { by: "customer", voiceTwin: true }, deps)).toMatchObject({ outcome: "connected", takeover: "voice_twin" });
        expect(state.row.handoff_status).toBe("connected");
        const prompt = vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt;
        expect(prompt).toContain(`Your personality and way of speaking: ${NORMAL_TWIN_PROFILE} Your goals are`);
      }
      // The logs say which personality was used, never the transcript.
      const logs = [...info.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
      expect(logs).toMatch(/AI Voice Twin personality: normal/);
      expect(logs).not.toMatch(/HMRC|arrest|What\?/);
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  it("doesn't spend the time the rest of the handover needs on the personality", async () => {
    let clock = 0;
    const { deps } = twinDeps(makeCall(), {
      now: () => clock,
      loadVoiceTwin: vi.fn(async () => {
        clock += 22_000 - TWIN_PERSONALITY_RESERVE_MS - 200; // the twin check was slow: too little left to spare
        return TWIN;
      }),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect((await takeOver("id", { by: "customer", voiceTwin: true }, deps)).outcome).toBe("connected");
      expect(deps.describePersonality).not.toHaveBeenCalled();
      const prompt = vi.mocked(deps.registerCall).mock.calls[0][0].conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt;
      expect(prompt).toContain(NORMAL_TWIN_PROFILE);
      expect(info.mock.calls.map((c) => String(c[0]))).toContain("takeover id: AI Voice Twin personality: normal (no_time)");
    } finally {
      info.mockRestore();
    }

    // With a little more time, the cap shrinks to what can be spared.
    clock = 0;
    const roomy = twinDeps(makeCall(), {
      now: () => clock,
      loadVoiceTwin: vi.fn(async () => {
        clock += 22_000 - TWIN_PERSONALITY_RESERVE_MS - 2_000;
        return TWIN;
      }),
    });
    await takeOver("id", { by: "customer", voiceTwin: true }, roomy.deps);
    expect(vi.mocked(roomy.deps.describePersonality).mock.calls[0][1]).toBe(2_000);
  });

  it("claims and connects with kind voice_twin and the consent reference, and no persona", async () => {
    const { deps, state } = twinDeps();
    await takeOver("id", { by: "customer", voiceTwin: true }, deps);
    expect(deps.loadVoiceTwin).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.loadVoiceTwin).mock.calls[0][0]).toBeLessThanOrEqual(TWIN_LOAD_TIMEOUT_MS);
    expect(vi.mocked(deps.claim).mock.calls[0]).toEqual(["id", "customer", { kind: "voice_twin", twin: TWIN }]);
    expect(vi.mocked(deps.markConnected).mock.calls[0][1]).toEqual({ kind: "voice_twin", twin: TWIN });
    expect(state.row).toMatchObject({
      handoff_status: "connected",
      handoff_by: "customer",
      persona: null,
      takeover_kind: "voice_twin",
      voice_twin_consent_at: "2026-11-05T09:30:00.000Z",
      voice_twin_speech_seconds: 42.5,
      voice_twin_voice_source: "clone",
    });
  });

  it("checks the twin before claiming: unavailable means no claim, no Twilio or ElevenLabs, and the call stays claimable", async () => {
    const { deps, state } = fakeDeps(makeCall());
    const result = await takeOver("id", { by: "customer", voiceTwin: true }, deps);
    expect(result.outcome).toBe("twin_unavailable");
    expect(result.call).toMatchObject({ handoff_status: "offered" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.fetchCallerNumber).not.toHaveBeenCalled();
    expect(deps.registerCall).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(state.row.handoff_status).toBe("offered");
    // The customer then taps "Use AI voice" instead.
    expect(await takeOver("id", { by: "customer" }, deps)).toMatchObject({ outcome: "connected", takeover: "persona", persona: "middle_male" });
  });

  it("treats a twin check that throws as unavailable", async () => {
    const { deps } = fakeDeps(makeCall(), {
      loadVoiceTwin: vi.fn(async () => {
        throw new Error("supabase down");
      }),
    });
    expect((await takeOver("id", { by: "customer", voiceTwin: true }, deps)).outcome).toBe("twin_unavailable");
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("marks a failed twin handover failed and leaves the customer connected, like a persona's", async () => {
    const { deps, state } = twinDeps(makeCall(), {
      registerCall: vi.fn(async () => {
        throw new Error("ElevenLabs POST /v1/convai/twilio/register-call → 422: voice not found");
      }),
    });
    const result = await takeOver("id", { by: "customer", voiceTwin: true }, deps);
    expect(result).toMatchObject({ outcome: "failed", takeover: "voice_twin", persona: null });
    expect(deps.stopScreening).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(state.row.handoff_status).toBe("failed");
  });

  it("returns a conflict (one register-call) when the twin and an analyst race for the call", async () => {
    const { deps } = twinDeps();
    const [a, b] = await Promise.all([
      takeOver("id", { by: "customer", voiceTwin: true }, deps),
      takeOver("id", { by: "analyst:Sam" }, deps),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["conflict", "connected"]);
    expect(deps.registerCall).toHaveBeenCalledTimes(1);
  });

  it("connects a simulated call (CAsim…) to the twin without Twilio or ElevenLabs, with the normal personality and no model call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    onTestFinished(() => info.mockRestore());
    const { deps, state } = twinDeps(makeCall({ twilio_call_sid: `CAsim${"b".repeat(30)}` }));
    const result = await takeOver("id", { by: "customer", voiceTwin: true }, deps);
    expect(result).toMatchObject({ outcome: "connected", takeover: "voice_twin", persona: null, simulated: true });
    expect(deps.loadVoiceTwin).toHaveBeenCalledTimes(1);
    expect(deps.describePersonality).not.toHaveBeenCalled();
    expect(deps.fetchCallerNumber).not.toHaveBeenCalled();
    expect(deps.registerCall).not.toHaveBeenCalled();
    expect(deps.redirectCall).not.toHaveBeenCalled();
    expect(state.row).toMatchObject({ handoff_status: "connected", takeover_kind: "voice_twin", voice_twin_consent_at: TWIN.consentGivenAt });
    expect(info.mock.calls.map((c) => String(c[0]))).toContain("takeover id: AI Voice Twin personality: normal (simulated)");
  });

  it("still requires a usable twin for a simulated call", async () => {
    const { deps, state } = fakeDeps(makeCall({ twilio_call_sid: `CAsim${"c".repeat(30)}` }));
    expect((await takeOver("id", { by: "customer", voiceTwin: true }, deps)).outcome).toBe("twin_unavailable");
    expect(deps.claim).not.toHaveBeenCalled();
    expect(state.row.handoff_status).toBe("offered");
  });

  it("only hands over to a consented, ready, unexpired twin whose voice still exists (twinForTakeover)", async () => {
    const clock = Date.parse("2026-11-06T12:00:00.000Z");
    const ready = (overrides: Partial<VoiceTwinRow> = {}) =>
      new MemoryVoiceTwin(clock).withConsent({
        state: "ready",
        voice_id: "cloned-voice-9",
        voice_source: "clone",
        voice_created_at: new Date(clock - 3_600_000).toISOString(),
        voice_expires_at: new Date(clock + 3_600_000).toISOString(),
        clone_speech_seconds: 37.25,
        ...overrides,
      });

    const m = ready();
    m.voices.add("cloned-voice-9");
    const ok = fakeDeps(makeCall(), { loadVoiceTwin: () => twinForTakeover(m.deps()) });
    expect(await takeOver("id", { by: "customer", voiceTwin: true }, ok.deps)).toMatchObject({ outcome: "connected", takeover: "voice_twin" });
    const input = vi.mocked(ok.deps.registerCall).mock.calls[0][0];
    expect(input.conversation_initiation_client_data.conversation_config_override.tts.voice_id).toBe("cloned-voice-9");
    expect(ok.state.row).toMatchObject({ voice_twin_consent_at: m.twin?.consent_given_at, voice_twin_speech_seconds: 37.3 });

    const gone = ready(); // the voice no longer exists at ElevenLabs
    const revoked = ready();
    await revoked.store.revoke({ by: "Ben", userAgent: null });
    revoked.voices.add("cloned-voice-9");
    const expiring = ready({ voice_expires_at: new Date(clock + 30_000).toISOString() }); // expires within the minute
    expiring.voices.add("cloned-voice-9");
    for (const memory of [gone, revoked, expiring, new MemoryVoiceTwin(clock), new MemoryVoiceTwin(clock).withConsent()]) {
      const { deps } = fakeDeps(makeCall(), { loadVoiceTwin: () => twinForTakeover(memory.deps()) });
      expect((await takeOver("id", { by: "customer", voiceTwin: true }, deps)).outcome).toBe("twin_unavailable");
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });
});

describe("takeover responses", () => {
  it("answers the customer's twin_unavailable with 409 and the plain-language message", async () => {
    const res = customerTakeoverResponse({ outcome: "twin_unavailable", call: makeCall() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: "twin_unavailable", error: TWIN_UNAVAILABLE_MESSAGE });
    expect(TWIN_UNAVAILABLE_MESSAGE).toBe("Your AI Voice Twin isn't ready right now. Tap Use AI voice instead.");
    expect(body.call).toMatchObject({ id: makeCall().id, handoff_status: "offered", takeover_kind: null });
    expect(body.call.screening_transcript).toBeUndefined();
  });

  it("includes the takeover kind when connected (customer and dashboard)", async () => {
    const call = makeCall({ handoff_status: "connected", takeover_kind: "voice_twin", voice_twin_consent_at: TWIN.consentGivenAt });
    const customer = await customerTakeoverResponse({ outcome: "connected", call, takeover: "voice_twin", persona: null, aiVoice: null, simulated: false }).json();
    expect(customer).toMatchObject({ ok: true, outcome: "connected", takeover: "voice_twin", call: { takeover_kind: "voice_twin", persona: null } });
    const dashboard = await takeoverResponse({ outcome: "connected", call, takeover: "voice_twin", persona: null, aiVoice: null, simulated: true }).json();
    expect(dashboard).toMatchObject({ ok: true, outcome: "connected", persona: null, aiVoiceLabel: null, takeover: "voice_twin", simulated: true });
    const aiVoice = resolveVoiceMatch({ ageBand: "older", gender: "female" }, null);
    const persona = await takeoverResponse({ outcome: "connected", call: makeCall(), takeover: "persona", persona: "older_female", aiVoice, simulated: false }).json();
    expect(persona).toMatchObject({ persona: "older_female", takeover: "persona", aiVoiceLabel: "AI voice: older female (from settings)" });
    // The customer is never told which voice (no names, ages or descriptions on their side).
    const customerPersona = await customerTakeoverResponse({ outcome: "connected", call: makeCall(), takeover: "persona", persona: "older_female", aiVoice, simulated: false }).json();
    expect(JSON.stringify(customerPersona)).not.toMatch(/older|female|Joan|aiVoice/);
    expect(takeoverResponse({ outcome: "twin_unavailable", call: null }).status).toBe(409);
  });

  it("shows the customer the takeover kind (and still nothing private)", () => {
    expect(CUSTOMER_COLUMNS).toContain("takeover_kind");
    expect(customerCall(makeCall({ takeover_kind: "persona", persona: "derek" }))).toMatchObject({ takeover_kind: "persona", persona: "derek" });
    // The alert's quotes reach the customer; nothing else from the risk object beyond what they already saw.
    const quoted = customerCall(makeCall({ risk: { ...makeCall().risk!, quotes: ["one", "two", "three"], model: "secret-model" } }));
    expect(quoted?.risk).toEqual({ score: 88, peak: 88, scam_type: "hmrc", reason: "Threatening arrest.", quotes: ["one", "two"] });
    expect(customerCall({ id: "x" })?.takeover_kind).toBeNull();
  });
});

/** Runs public/sw.js against a fake service worker global and records what it does. */
function loadServiceWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: { actions: { action: string }[]; data: Record<string, unknown>; body: string } }[] = [];
  const fetches: { url: string; body: unknown }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async (url: string) => opened.push(url) },
  };
  const fetch = async (url: string, init: { body: string }) => {
    fetches.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, fetch, URL, console });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  const push = (payload: unknown) => fire("push", { data: { json: () => payload, text: () => "" } });
  const click = (action: string) => {
    const last = shown[shown.length - 1];
    return fire("notificationclick", { action, notification: { close: () => undefined, data: last.options.data } });
  };
  return { fire, push, click, shown, fetches, opened };
}

describe("takeover offer push", () => {
  const risk = { scam_type: "hmrc", reason: "Threatening arrest." } as const;

  it("tells the service worker whether the AI Voice Twin is ready", () => {
    expect(offerPayload("c1", risk)).toMatchObject({ type: "offer", callId: "c1", url: "/protect", twinReady: false });
    expect(offerPayload("c1", risk, {}).twinReady).toBe(false);
    expect(offerPayload("c1", risk, { twinReady: true }).twinReady).toBe(true);
  });

  it("offers the one-tap \"Use AI voice\" handover when the twin isn't ready", async () => {
    const sw = loadServiceWorker();
    await sw.push(JSON.parse(JSON.stringify(offerPayload("c1", risk))));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("Suspected scam");
    expect(sw.shown[0].options.actions).toEqual([
      { action: "handover", title: "Use AI voice" },
      { action: "dismiss", title: "Dismiss" },
    ]);
    await sw.click("handover");
    expect(sw.fetches).toEqual([{ url: "/api/protect/takeover", body: { callId: "c1" } }]);
    expect(sw.opened).toEqual(["/protect"]);
  });

  it("only opens /protect to choose when the twin is ready (no automatic handover)", async () => {
    const sw = loadServiceWorker();
    await sw.push(JSON.parse(JSON.stringify(offerPayload("c2", risk, { twinReady: true }))));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].options.actions).toEqual([
      { action: "choose", title: "Open the alert" },
      { action: "dismiss", title: "Dismiss" },
    ]);
    await sw.click("choose");
    await sw.click("");
    await sw.click("handover"); // not offered, and refused even if a stale notification sends it
    expect(sw.fetches).toEqual([]);
    expect(sw.opened).toEqual(["/protect", "/protect", "/protect"]);
  });

  it("still shows a notification for a push it can't read", async () => {
    const sw = loadServiceWorker();
    await sw.push(null);
    await sw.fire("push", { data: null });
    await sw.fire("push", { data: { json: () => JSON.parse("not json"), text: () => "Possible scam" } });
    expect(sw.shown).toHaveLength(3);
    for (const { title, options } of sw.shown) {
      expect(title).toBe("Suspected scam");
      expect(options.actions.map((a) => a.action)).toEqual(["handover", "dismiss"]);
    }
    expect(sw.shown[2].options.body).toBe("Possible scam");
  });
});

/* Integration: the real atomic claim against Supabase (runs when .env.local is present). */
const hasDb = existsSync(".env.local");
describe.runIf(hasDb)("takeover claim (Supabase)", () => {
  it("lets exactly one of two concurrent claims through, and only for live, claimable calls", async () => {
    process.loadEnvFile(".env.local");
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { liveTakeoverDeps } = await import("@/lib/takeover");
    const db = supabaseAdmin();
    const deps = liveTakeoverDeps();
    const { data: row, error } = await db
      .from("calls")
      .insert({ twilio_call_sid: `CAtest${randomBytes(14).toString("hex")}`, caller_masked: "•••000", status: "live", handoff_status: "offered" })
      .select("id")
      .single();
    if (error) throw error;
    try {
      const persona = { kind: "persona" } as const;
      const results = await Promise.all([
        deps.claim(row.id, "customer", persona),
        deps.claim(row.id, "analyst:Test", persona),
        deps.claim(row.id, "customer", persona),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await deps.claim(row.id, "customer", persona)).toBeNull();
      const { data } = await db.from("calls").select("handoff_status, handoff_requested_at").eq("id", row.id).single();
      expect(data?.handoff_status).toBe("requested");
      expect(data?.handoff_requested_at).toBeTruthy();
      // A claim whose takeover died (stale 'requested') can be claimed again; a fresh one can't.
      await db.from("calls").update({ handoff_requested_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", row.id);
      expect(await deps.claim(row.id, "analyst:Retry", persona)).not.toBeNull();
      expect(await deps.claim(row.id, "customer", persona)).toBeNull();
    } finally {
      await db.from("calls").delete().eq("id", row.id);
    }
  });
});
