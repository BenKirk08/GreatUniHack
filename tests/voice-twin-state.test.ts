import { describe, expect, it } from "vitest";
import { VOICE_TWIN_STATES, type VoiceTwinState } from "@/lib/types";
import { acceptsAudio, nextTwinState, type VoiceTwinEvent } from "@/lib/voice-twin/state";

/** Every event variant the state machine knows, with a readable name. */
const EVENTS: Record<string, VoiceTwinEvent> = {
  audio_added: { type: "audio_added" },
  clone_claimed: { type: "clone_claimed" },
  "clone_claimed (retry)": { type: "clone_claimed", retry: true },
  "clone_claimed (stale)": { type: "clone_claimed", stale: true },
  "clone_claimed (retry + stale)": { type: "clone_claimed", retry: true, stale: true },
  clone_succeeded: { type: "clone_succeeded" },
  "clone_failed (no fallback)": { type: "clone_failed", fallback: false },
  "clone_failed (fallback)": { type: "clone_failed", fallback: true },
  expired: { type: "expired" },
  revoked: { type: "revoked" },
};

/** The full transition table: state → event → next state (null = not allowed). */
const TABLE: Record<VoiceTwinState, Record<keyof typeof EVENTS, VoiceTwinState | null>> = {
  collecting: {
    audio_added: "collecting",
    clone_claimed: "cloning",
    "clone_claimed (retry)": "cloning",
    "clone_claimed (stale)": "cloning",
    "clone_claimed (retry + stale)": "cloning",
    clone_succeeded: null,
    "clone_failed (no fallback)": null,
    "clone_failed (fallback)": null,
    expired: null,
    revoked: "collecting",
  },
  cloning: {
    audio_added: null,
    clone_claimed: null,
    "clone_claimed (retry)": null,
    "clone_claimed (stale)": "cloning",
    "clone_claimed (retry + stale)": "cloning",
    clone_succeeded: "ready",
    "clone_failed (no fallback)": "failed",
    "clone_failed (fallback)": "ready",
    expired: null,
    revoked: "collecting",
  },
  ready: {
    audio_added: null,
    clone_claimed: null,
    "clone_claimed (retry)": null,
    "clone_claimed (stale)": null,
    "clone_claimed (retry + stale)": null,
    clone_succeeded: null,
    "clone_failed (no fallback)": null,
    "clone_failed (fallback)": null,
    expired: "collecting",
    revoked: "collecting",
  },
  failed: {
    audio_added: "failed",
    clone_claimed: null,
    "clone_claimed (retry)": "cloning",
    "clone_claimed (stale)": null,
    "clone_claimed (retry + stale)": "cloning",
    clone_succeeded: null,
    "clone_failed (no fallback)": null,
    "clone_failed (fallback)": null,
    expired: null,
    revoked: "collecting",
  },
};

describe("nextTwinState: every state × event", () => {
  it("the table covers every state in VOICE_TWIN_STATES", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...VOICE_TWIN_STATES].sort());
  });

  for (const state of VOICE_TWIN_STATES) {
    for (const [name, event] of Object.entries(EVENTS)) {
      const expected = TABLE[state][name];
      it(`${state} + ${name} → ${expected ?? "not allowed"}`, () => {
        expect(nextTwinState(state, event)).toBe(expected);
      });
    }
  }
});

describe("nextTwinState: the documented paths", () => {
  it("collecting → cloning → ready", () => {
    const cloning = nextTwinState("collecting", { type: "clone_claimed" });
    expect(cloning).toBe("cloning");
    expect(nextTwinState(cloning!, { type: "clone_succeeded" })).toBe("ready");
  });

  it("cloning → failed without a fallback voice, → ready with one", () => {
    expect(nextTwinState("cloning", { type: "clone_failed", fallback: false })).toBe("failed");
    expect(nextTwinState("cloning", { type: "clone_failed", fallback: true })).toBe("ready");
  });

  it("failed → cloning only on an explicit retry", () => {
    expect(nextTwinState("failed", { type: "clone_claimed" })).toBeNull();
    expect(nextTwinState("failed", { type: "clone_claimed", retry: false })).toBeNull();
    expect(nextTwinState("failed", { type: "clone_claimed", stale: true })).toBeNull();
    expect(nextTwinState("failed", { type: "clone_claimed", retry: true })).toBe("cloning");
  });

  it("cloning → cloning only when the earlier claim is stale", () => {
    expect(nextTwinState("cloning", { type: "clone_claimed" })).toBeNull();
    expect(nextTwinState("cloning", { type: "clone_claimed", retry: true })).toBeNull();
    expect(nextTwinState("cloning", { type: "clone_claimed", stale: false })).toBeNull();
    expect(nextTwinState("cloning", { type: "clone_claimed", stale: true })).toBe("cloning");
  });

  it("ready → collecting on expiry, and nothing else expires", () => {
    expect(nextTwinState("ready", { type: "expired" })).toBe("collecting");
    for (const state of VOICE_TWIN_STATES.filter((s) => s !== "ready")) expect(nextTwinState(state, { type: "expired" })).toBeNull();
  });

  it("anything → collecting on revoke", () => {
    for (const state of VOICE_TWIN_STATES) expect(nextTwinState(state, { type: "revoked" })).toBe("collecting");
  });

  it("a ready twin can't be claimed or re-finished", () => {
    expect(nextTwinState("ready", { type: "clone_claimed", retry: true, stale: true })).toBeNull();
    expect(nextTwinState("ready", { type: "clone_succeeded" })).toBeNull();
    expect(nextTwinState("ready", { type: "clone_failed", fallback: true })).toBeNull();
  });

  it("audio_added never changes the state", () => {
    for (const state of VOICE_TWIN_STATES) {
      const next = nextTwinState(state, { type: "audio_added" });
      if (next !== null) expect(next).toBe(state);
    }
  });
});

describe("acceptsAudio", () => {
  it("accepts audio only while collecting or failed", () => {
    expect(acceptsAudio("collecting")).toBe(true);
    expect(acceptsAudio("failed")).toBe(true);
    expect(acceptsAudio("cloning")).toBe(false);
    expect(acceptsAudio("ready")).toBe(false);
  });

  it("agrees with nextTwinState for every state", () => {
    for (const state of VOICE_TWIN_STATES) expect(acceptsAudio(state)).toBe(nextTwinState(state, { type: "audio_added" }) !== null);
  });
});
