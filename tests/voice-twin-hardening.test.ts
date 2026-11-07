import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIMABLE_STATUSES, takeOver, type TakeoverDeps } from "@/lib/takeover";
import type { CallRow, HandoffStatus, ScreeningSegment } from "@/lib/types";
import { VOICE_TWIN_CLONE_TTL_MS } from "@/lib/voice-twin/config";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";
import {
  giveConsent,
  maybeStartClone,
  revokeAndDelete,
  storeAudioChunk,
  sweepOrphanVoices,
  twinForTakeover,
  voiceTwinHousekeeping,
  type VoiceTwinDeps,
} from "@/lib/voice-twin/service";
import { hasCustomerSpeech, isCallAudioEligible, isCallOver } from "@/lib/voice-twin/store";
import { customerTwinView, friendlyCloneError } from "@/lib/voice-twin/view";
import { encodeWav } from "@/lib/voice-twin/wav";

/**
 * Fixes from the adversarial review (0010 and the service): only the customer's own voice is cloned, the clone run
 * that made a claim is the only one that can finish it, orphaned clones and leftover recordings are swept, a voice
 * that's gone at ElevenLabs is retired, the view never offers a voice in its last minute, and the twin never takes an
 * unflagged call.
 */

const CALL = "33333333-3333-4333-8333-333333333333";
const iso = (ms: number) => new Date(ms).toISOString();
const wav = () => encodeWav(new Int16Array(160), 8000);
const seg = (speaker: "caller" | "customer", text: string): ScreeningSegment => ({ speaker, text, at: "2026-11-06T12:00:00.000Z" });

function setup(settings: Parameters<MemoryVoiceTwin["deps"]>[0] = {}) {
  const m = new MemoryVoiceTwin().withConsent();
  return { m, deps: m.deps(settings) };
}

async function sample(deps: VoiceTwinDeps, seq: number, seconds = 12) {
  return storeAudioChunk({ source: "sample", callId: null, sessionId: "5a1e5e55-0000-4000-8000-0000000000aa", seq, wav: wav(), sampleRate: 8000, speechSeconds: seconds }, deps);
}

async function makeReady(deps: VoiceTwinDeps) {
  for (let seq = 0; seq < 3; seq++) expect((await sample(deps, seq)).stored).toBe(true);
  const outcome = await maybeStartClone({}, deps);
  expect(outcome.outcome).toBe("ready");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("only the account holder's own voice is cloned (call audio eligibility)", () => {
  const flagged = { offered_at: "2026-11-06T12:00:10.000Z", risk: null, handoff_status: "offered" as HandoffStatus };

  it("needs a real customer line (3+ words) and nothing that sounds like voicemail or a call-screening assistant", () => {
    expect(hasCustomerSpeech({ screening_transcript: [seg("customer", "Hello, who is this please?")] })).toBe(true);
    expect(hasCustomerSpeech({ screening_transcript: [seg("customer", "Yes?")] })).toBe(false);
    expect(hasCustomerSpeech({ screening_transcript: [seg("caller", "This is HMRC calling about your tax")] })).toBe(false);
    for (const greeting of [
      "The person you have called is not available. Please leave a message after the tone.",
      "Hi, the person you're calling is using a screening service from Google. Go ahead and say your name and why you're calling.",
      "Hi, if you record your name and reason for calling, I'll see if this person is available.",
      "Welcome to the Vodafone voicemail service.",
      "Sorry, I can't take your call right now, leave your name and number.",
    ]) {
      expect(hasCustomerSpeech({ screening_transcript: [seg("customer", greeting)] }), greeting).toBe(false);
      // Even if the customer then talks, a screened/voicemail leg is never used.
      expect(hasCustomerSpeech({ screening_transcript: [seg("customer", greeting), seg("customer", "Hello who is this please")] })).toBe(false);
    }
  });

  it("eligible = flagged AND the customer really spoke", () => {
    const spoke = [seg("customer", "Oh no, what do I need to do?")];
    expect(isCallAudioEligible({ ...flagged, screening_transcript: spoke })).toBe(true);
    expect(isCallAudioEligible({ ...flagged, screening_transcript: [seg("customer", "Please leave a message after the tone")] })).toBe(false);
    expect(isCallAudioEligible({ offered_at: null, risk: null, handoff_status: "none", screening_transcript: spoke })).toBe(false);
  });

  it("a voicemail-answered flagged call's audio is never used for the clone, and is discarded when the call ends", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL, ...flagged, screening_transcript: [seg("customer", "The person you have called is not available, please leave a message")] });
    for (let seq = 0; seq < 4; seq++) {
      const r = await storeAudioChunk({ source: "call", callId: CALL, sessionId: "MZvoicemail", seq, wav: wav(), sampleRate: 8000, speechSeconds: 10 }, deps);
      expect(r.stored).toBe(true); // stored while live (eligibility is decided at claim / call end)
    }
    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "not_enough_audio" });
    expect(m.created).toHaveLength(0);

    m.updateCall(CALL, { status: "ended" });
    const summary = await voiceTwinHousekeeping(deps, { sweepVoices: false });
    expect(summary.discardedChunks).toBe(4);
    expect(m.audio).toHaveLength(0);
    expect(m.twin?.speech_seconds).toBe(0);
  });

  it("a call stuck 'live' for over 6 hours counts as over: its unflagged audio is discarded", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL, started_at: iso(m.clock) });
    await storeAudioChunk({ source: "call", callId: CALL, sessionId: "MZstuck", seq: 0, wav: wav(), sampleRate: 8000, speechSeconds: 8 }, deps);
    expect(isCallOver({ status: "live", started_at: iso(m.clock) }, m.clock)).toBe(false);
    m.clock += 6 * 60 * 60 * 1000 + 1;
    expect(isCallOver({ status: "live", started_at: iso(m.clock - 6 * 60 * 60 * 1000 - 1) }, m.clock)).toBe(true);
    expect((await voiceTwinHousekeeping(deps, { sweepVoices: false })).discardedChunks).toBe(1);
    expect(m.twin?.speech_seconds).toBe(0);
  });
});

describe("claim token: only the run that made the claim can finish it", () => {
  it("a superseded run (revoke + re-consent + new claim in between) can't complete the newer claim", async () => {
    const { m, deps } = setup();
    for (let seq = 0; seq < 3; seq++) await sample(deps, seq);
    const first = await m.store.claimClone(m.twin!.id, { minSeconds: 30, staleSeconds: 180, allowFailed: false });
    expect(first.claimed).toBe(true);
    const firstToken = first.claimed ? first.claimedAt : null;

    // The customer revokes, consents again and records again; a new claim is made while the old run is still going.
    await revokeAndDelete({ userAgent: null }, deps);
    await giveConsent({ userAgent: null }, deps);
    for (let seq = 10; seq < 13; seq++) await sample(deps, seq);
    m.clock += 1;
    const second = await m.store.claimClone(m.twin!.id, { minSeconds: 30, staleSeconds: 180, allowFailed: false });
    expect(second.claimed).toBe(true);
    expect(second.claimed && second.claimedAt).not.toBe(firstToken);

    const lateFinish = await m.store.finishClone(m.twin!.id, {
      claimedAt: firstToken,
      voiceId: "voice-from-revoked-audio",
      voiceSource: "clone",
      speechSeconds: 36,
      createdAt: iso(m.clock),
      expiresAt: iso(m.clock + VOICE_TWIN_CLONE_TTL_MS),
    });
    expect(lateFinish).toBeNull();
    expect(await m.store.failClone(m.twin!.id, "late", firstToken)).toBeNull();
    expect(m.twin?.state).toBe("cloning"); // still the new claim's
  });

  it("each claim gets a fresh token, even at the same instant", async () => {
    const { m, deps } = setup();
    for (let seq = 0; seq < 3; seq++) await sample(deps, seq);
    const a = await m.store.claimClone(m.twin!.id, { minSeconds: 30, staleSeconds: 0, allowFailed: false });
    m.clock += 1_000;
    const b = await m.store.claimClone(m.twin!.id, { minSeconds: 30, staleSeconds: 0, allowFailed: false });
    expect(a.claimed && b.claimed).toBe(true);
    expect(a.claimed && b.claimed && a.claimedAt !== b.claimedAt).toBe(true);
  });
});

describe("orphaned clones and leftover recordings are swept", () => {
  it("a clone ElevenLabs made but the app never recorded (killed run) is found by its twin tag and deleted", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    // A previous run's voice that was never recorded, plus somebody else's voice that must never be touched.
    m.voices.add("orphan-voice");
    m.voiceMeta.set("orphan-voice", { description: `AI Voice Twin … twin:${m.twin!.id}`, createdAtUnix: Math.floor(m.clock / 1000) - 3600 });
    m.voices.add("unrelated-voice");
    m.voiceMeta.set("unrelated-voice", { description: "Ben - Voice Twin (made by hand)", createdAtUnix: 1 });

    const summary = await voiceTwinHousekeeping(deps, { sweepVoices: true });
    expect(summary.voicesDeleted).toBe(1);
    expect(m.deleted).toEqual(["orphan-voice"]);
    expect(m.voices.has(m.twin!.voice_id!)).toBe(true); // the twin's own voice is kept
    expect(m.voices.has("unrelated-voice")).toBe(true);
  });

  it("while a clone run may be in flight, its young voice isn't swept", async () => {
    const { m, deps } = setup();
    for (let seq = 0; seq < 3; seq++) await sample(deps, seq);
    await m.store.claimClone(m.twin!.id, { minSeconds: 30, staleSeconds: 180, allowFailed: false });
    m.voices.add("in-flight-voice");
    m.voiceMeta.set("in-flight-voice", { description: `twin:${m.twin!.id}`, createdAtUnix: Math.floor(m.clock / 1000) });
    expect(await sweepOrphanVoices(m.twin!.id, m.twin, deps)).toBe(0);
    expect(m.voices.has("in-flight-voice")).toBe(true);
  });

  it("revoke deletes orphaned clones too, without trying the revoked voice twice", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    const current = m.twin!.voice_id!;
    m.voices.add("orphan-voice");
    m.voiceMeta.set("orphan-voice", { description: `twin:${m.twin!.id}`, createdAtUnix: 1 });
    const result = await revokeAndDelete({ userAgent: null }, deps);
    expect(result.voice).toBe("deleted");
    expect(m.deleted.sort()).toEqual([current, "orphan-voice"].sort());
  });

  it("raw audio left behind after cloning is retried by housekeeping while the twin is ready", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    // A deletion that failed after cloning left a row and an object behind.
    await m.storage.upload(`${m.twin!.id}/sample/left/00000.wav`, wav(), "audio/wav");
    m.audio.push({ ...{ id: "aaaaaaaa-0000-4000-8000-999999999999", twin_id: m.twin!.id, source: "sample", call_id: null, session_id: "left", seq: 0 },
      storage_path: `${m.twin!.id}/sample/left/00000.wav`, mime_type: "audio/wav", sample_rate: 8000, speech_seconds: 5, bytes: 10, created_at: iso(m.clock) });
    await voiceTwinHousekeeping(deps, { sweepVoices: false });
    expect(m.audio).toHaveLength(0);
    expect(await m.storage.listTwinObjects(m.twin!.id)).toEqual([]);
  });

  it("consenting again first deletes recordings a failed revoke left behind", async () => {
    const { m, deps } = setup();
    await sample(deps, 0);
    m.removeError = null;
    const realRemove = m.storage.remove;
    m.storage.remove = async () => {
      throw new Error("storage down");
    };
    const revoked = await revokeAndDelete({ userAgent: null }, deps);
    expect(revoked.problem).toMatch(/couldn't be deleted yet/);
    m.storage.remove = realRemove;
    expect((await m.storage.listTwinObjects(m.twin!.id)).length).toBe(1);

    await giveConsent({ userAgent: null }, deps);
    expect(await m.storage.listTwinObjects(m.twin!.id)).toEqual([]);
    expect(m.twin?.voice_twin_consent).toBe(true);
  });
});

describe("a voice that can't be used is never offered", () => {
  it("a voice deleted at ElevenLabs is retired at once (expired, back to collecting)", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.voices.delete(m.twin!.voice_id!);
    expect(await twinForTakeover(deps)).toBeNull();
    expect(m.twin).toMatchObject({ state: "collecting", voice_id: null });
    expect(customerTwinView(m.twin, { minSeconds: 30, targetSeconds: 60 }, m.clock).usable).toBe(false);
  });

  it("the customer view treats a voice in its last minute as expired (matches twinForTakeover's margin)", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    const expires = Date.parse(m.twin!.voice_expires_at!);
    const at = (ms: number) => customerTwinView(m.twin, { minSeconds: 30, targetSeconds: 60 }, ms);
    expect(at(expires - 61_000)).toMatchObject({ usable: true, state: "ready" });
    expect(at(expires - 59_000)).toMatchObject({ usable: false, state: "collecting", speechSeconds: 0 });
    m.clock = expires - 59_000;
    expect(await twinForTakeover(deps)).toBeNull();
  });
});

describe("the AI Voice Twin only takes a flagged call", () => {
  function call(handoff: HandoffStatus, flagged: boolean): CallRow {
    return {
      id: CALL,
      conversation_id: null,
      twilio_call_sid: "CAsim0123456789abcdef0123456789ab",
      caller_masked: "•••481",
      direction: "inbound",
      status: "live",
      started_at: "2026-11-06T12:00:00.000Z",
      ended_at: null,
      screening_transcript: [seg("customer", "Hello, who is this please?")],
      risk: flagged
        ? { score: 88, peak: 88, scam_type: "hmrc", tactics: [], reason: "x", segments_scored: 1, scored_at: "2026-11-06T12:00:08.000Z", threshold_crossed_at: "2026-11-06T12:00:08.000Z" }
        : { score: 12, peak: 12, scam_type: "unknown", tactics: [], reason: "x", segments_scored: 1, scored_at: "2026-11-06T12:00:08.000Z" },
      handoff_status: handoff,
      handoff_by: null,
      handoff_at: null,
      handoff_requested_at: null,
      handoff_error: null,
      persona: null,
      offered_at: flagged ? "2026-11-06T12:00:08.000Z" : null,
      declined_score: null,
      transcript: [],
      intel: null,
      intel_turns: 0,
      intel_claimed_at: null,
      mule_match: null,
      agent_notes: {},
      updated_at: "2026-11-06T12:00:08.000Z",
    };
  }

  function deps(row: CallRow): TakeoverDeps & { claims: number } {
    let state = { ...row };
    const d = {
      claims: 0,
      claim: vi.fn(async (_id: string, by: string) => {
        if (!(CLAIMABLE_STATUSES as readonly HandoffStatus[]).includes(state.handoff_status)) return null;
        d.claims++;
        state = { ...state, handoff_status: "requested", handoff_by: by };
        return { ...state };
      }),
      load: vi.fn(async () => ({ ...state })),
      loadVoiceTwin: vi.fn(async () => ({ voiceId: "clone-1", voiceSource: "clone" as const, consentGivenAt: "2026-11-06T11:00:00.000Z", speechSeconds: 42 })),
      fetchCallerNumber: vi.fn(async () => "+447700900481"),
      loadVoiceMatchSetting: vi.fn(async () => ({ ageBand: null, gender: null })),
      inferVoiceMatch: vi.fn(async () => ({ outcome: "no_data" as const })),
      registerCall: vi.fn(async () => "<Response/>"),
      stopScreening: vi.fn(async () => true),
      redirectCall: vi.fn(async () => undefined),
      redirectApplied: vi.fn(async () => false),
      resumeScreening: vi.fn(async () => undefined),
      dropCustomerLeg: vi.fn(async () => undefined),
      markConnected: vi.fn(async () => ({ ...state, handoff_status: "connected" as HandoffStatus })),
      markFailed: vi.fn(async () => null),
      config: () => ({ agentId: "agent_x", twilioNumber: "+14452755928", customerFirstName: "Ben", voiceFor: () => "voice" }),
    };
    return d as unknown as TakeoverDeps & { claims: number };
  }

  it("refuses an unflagged call (handoff 'none', below the threshold) without claiming it", async () => {
    const d = deps(call("none", false));
    const result = await takeOver(CALL, { by: "customer", voiceTwin: true }, d);
    expect(result.outcome).toBe("twin_unavailable");
    expect(d.claims).toBe(0);
    expect(d.loadVoiceTwin).not.toHaveBeenCalled();
  });

  it("takes a flagged (offered) call", async () => {
    const d = deps(call("offered", true));
    const result = await takeOver(CALL, { by: "customer", voiceTwin: true }, d);
    expect(result).toMatchObject({ outcome: "connected", takeover: "voice_twin" });
    expect(d.claims).toBe(1);
  });

  it("the AI voice handover still works on an unflagged call (the twin's flag check doesn't apply to it)", async () => {
    const d = deps(call("none", false));
    expect((await takeOver(CALL, { by: "customer" }, d)).outcome).toBe("connected");
  });
});

describe("audio captured under one consent is never stored under the next", () => {
  it("a call chunk whose stream started under an older consent is refused and nothing is written", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL });
    const startedUnder = m.twin!.consent_given_at;
    await revokeAndDelete({ userAgent: null }, deps);
    m.clock += 1_000;
    await giveConsent({ userAgent: null }, deps);
    expect(m.twin!.consent_given_at).not.toBe(startedUnder);
    const r = await storeAudioChunk(
      { source: "call", callId: CALL, sessionId: "MZold", seq: 0, wav: wav(), sampleRate: 8000, speechSeconds: 5, consentAt: startedUnder },
      deps,
    );
    expect(r).toEqual({ stored: false, reason: "no_consent" });
    expect(m.audio).toHaveLength(0);
    expect(m.objects.size).toBe(0);
  });

  it("a chunk under the current consent is stored", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL });
    const r = await storeAudioChunk(
      { source: "call", callId: CALL, sessionId: "MZok", seq: 0, wav: wav(), sampleRate: 8000, speechSeconds: 5, consentAt: m.twin!.consent_given_at },
      deps,
    );
    expect(r.stored).toBe(true);
  });
});

describe("a failed clone tells the customer why, in plain words", () => {
  it.each([
    ["ElevenLabs asked for voice verification, so the clone can't be used", /verification/],
    ["ElevenLabs POST /v1/voices/add → 403: subscription_required", /plan doesn't allow/],
    ["ElevenLabs POST /v1/voices/add → 400: voice_limit_reached", /voice limit is full/],
    ["no usable audio", /Record a short sample/],
    ["fetch failed", /You can try again from Settings/],
  ])("%s", (raw, expected) => {
    const text = friendlyCloneError(raw);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/ElevenLabs POST|→|\d{3}:/); // never the raw error
  });
});

describe("second review: the speech rule only judges the greeting", () => {
  it.each([
    [["Hello, who's calling please?", "Oh dear, what do I need to do with my savings?"], true],
    [["Hello?", "I'm not available on Thursday, can it wait?"], true],
    [["Hello who is this", "Sorry what", "I got a voicemail saying my account was frozen."], true],
    [["Is the money unavailable now? What's the reason for calling?"], true],
    [["Hi, the person you’re calling is using a call assistant. Tell me who you are and why you’re calling."], false],
    [["Thanks for calling. You've reached the person you've called, what are you calling about?"], false],
    [["Welcome to the Vodafone voicemail service.", "Hello who is this please"], false],
  ])("%j → %s (same answers as the SQL in 0011)", (lines, expected) => {
    expect(hasCustomerSpeech({ screening_transcript: (lines as string[]).map((t) => seg("customer", t)) })).toBe(expected);
  });
});

describe("second review: consent binding, final-minute voices, cleanup and revoke timing", () => {
  it("the store refuses audio recorded under an earlier consent even if the service check passed", async () => {
    const { m } = setup();
    const r = await m.store.addAudio({
      twinId: m.twin!.id, source: "sample", callId: null, sessionId: "s", seq: 0, path: "p", mimeType: "audio/wav", sampleRate: 8000,
      speechSeconds: 5, bytes: 10, consentAt: "2020-01-01T00:00:00.000Z",
    });
    expect(r).toEqual({ accepted: false, reason: "no_consent" });
  });

  it("audio arriving in a voice's final minute retires the voice and is stored for the next twin", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.clock = Date.parse(m.twin!.voice_expires_at!) - 30_000;
    const voice = m.twin!.voice_id!;
    const r = await sample(deps, 20, 6);
    expect(r.stored).toBe(true);
    expect(m.twin).toMatchObject({ state: "collecting", speech_seconds: 6, voice_id: null });
    expect(m.deletionQueue.has(voice)).toBe(true);
  });

  it("retiring a voice ElevenLabs no longer has also deletes its leftover recordings", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    await m.storage.upload(`${m.twin!.id}/sample/left/00001.wav`, wav(), "audio/wav");
    m.voices.delete(m.twin!.voice_id!);
    expect(await twinForTakeover(deps)).toBeNull();
    expect(await m.storage.listTwinObjects(m.twin!.id)).toEqual([]);
  });

  it("revoke can leave the orphan sweep for later (the route runs it after responding)", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.voices.add("orphan-voice");
    m.voiceMeta.set("orphan-voice", { description: `twin:${m.twin!.id}`, createdAtUnix: 1 });
    const before = m.twin!;
    await revokeAndDelete({ userAgent: null }, deps, { sweepOrphans: false });
    expect(m.voices.has("orphan-voice")).toBe(true);
    const { sweepAfterRevoke } = await import("@/lib/voice-twin/service");
    expect(await sweepAfterRevoke(before.id, before.voice_id, deps)).toBe(1);
    expect(m.voices.has("orphan-voice")).toBe(false);
  });
});

describe("second review: report timeline", () => {
  it("dates a failed handover by its claim, not the end of the call", async () => {
    const { buildProtectionTimeline } = await import("@/lib/report");
    const events = buildProtectionTimeline({
      started_at: "2026-11-06T12:00:00.000Z",
      ended_at: "2026-11-06T12:09:00.000Z",
      risk: null,
      handoff_status: "failed",
      handoff_by: "customer",
      handoff_at: null,
      handoff_requested_at: "2026-11-06T12:02:30.000Z",
      handoff_error: "register-call timed out",
      persona: null,
      takeover_kind: "voice_twin",
    } as Parameters<typeof buildProtectionTimeline>[0]);
    const failed = events.find((e) => /failed/.test(e.event));
    expect(failed?.time).toBe(new Date("2026-11-06T12:02:30.000Z").toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/London" }));
    expect(failed?.event).toMatch(/AI Voice Twin/);
  });
});

describe("the customer can see whether their voice is being recorded during calls", () => {
  it("liveCapture is on only with consent, while collecting, and with a media bridge online", async () => {
    const { m, deps } = setup();
    const { getCustomerTwinView } = await import("@/lib/voice-twin/service");
    expect((await getCustomerTwinView(deps)).liveCapture).toBe(false); // no bridge
    await m.store.heartbeatBridge({ id: "laptop-8787", publicUrl: "https://bridge.example" });
    expect((await getCustomerTwinView(deps)).liveCapture).toBe(true);
    await makeReady(deps);
    expect((await getCustomerTwinView(deps)).liveCapture).toBe(false); // ready: nothing more to collect
    expect(customerTwinView(null, { minSeconds: 30, targetSeconds: 60 }, m.clock, { bridgeOnline: true }).liveCapture).toBe(false); // no consent
  });
});
