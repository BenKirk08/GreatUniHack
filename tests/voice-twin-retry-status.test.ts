import { describe, expect, it } from "vitest";
import type { VoiceTwinState } from "@/lib/types";
import {
  RETRY_IDLE,
  RETRY_PENDING_MS,
  retryReducer,
  retryView,
  twinFailureDetail,
  type RetryEvent,
  type RetryState,
} from "@/lib/voice-twin/retry-status";
import { friendlyCloneError } from "@/lib/voice-twin/view";

const T0 = 1_762_430_400_000;

function snap(state: VoiceTwinState, signalsAtRead: number | null, consent = true): RetryEvent {
  return { type: "snapshot", twin: { consent, state }, signalsAtRead };
}

function run(events: RetryEvent[], from: RetryState = RETRY_IDLE): RetryState {
  return events.reduce(retryReducer, from);
}

const tapped: RetryEvent = { type: "requested", at: T0, signals: 4 };

describe("retryReducer", () => {
  it("ignores snapshots when no retry is being followed", () => {
    expect(run([snap("failed", 9), snap("cloning", 9)])).toBe(RETRY_IDLE);
  });

  it("stays pending on the stale 'failed' reads that come before the clone is claimed", () => {
    // The reply's own read, a poll, a read started before the tap: none is evidence of anything.
    const state = run([tapped, snap("failed", null), snap("failed", 4), snap("failed", 3)]);
    expect(state.phase).toBe("pending");
  });

  it("clears 'Trying again…' as soon as it is seen cloning, and reports a repeat failure after that", () => {
    const cloning = run([tapped, snap("failed", 4), snap("cloning", 5)]);
    expect(cloning.phase).toBe("cloning");
    expect(retryView(cloning, "cloning", T0 + 1_000)).toEqual({ retrying: false, failedAgain: false });

    const again = retryReducer(cloning, snap("failed", 6));
    expect(again.phase).toBe("failed_again");
    expect(retryView(again, "failed", T0 + 2_000)).toEqual({ retrying: false, failedAgain: true });
  });

  it("reports a fast repeat failure it never saw cloning, from a read started after a change signal", () => {
    // failed → cloning → failed between two reads: the first read after the claim's signal already says failed.
    const state = run([tapped, snap("failed", 5)]);
    expect(state.phase).toBe("failed_again");
    expect(retryView(state, "failed", T0 + 1_500)).toEqual({ retrying: false, failedAgain: true });
  });

  it("a twin carried in a sample upload's reply proves nothing about a repeat failure, but can show cloning", () => {
    expect(run([tapped, snap("failed", null)]).phase).toBe("pending");
    expect(run([tapped, snap("cloning", null)]).phase).toBe("cloning");
  });

  it("ends when the twin becomes ready or consent goes, and on dismiss", () => {
    expect(run([tapped, snap("cloning", 5), snap("ready", 6)])).toBe(RETRY_IDLE);
    expect(run([tapped, snap("ready", 5)])).toBe(RETRY_IDLE);
    expect(run([tapped, snap("failed", 5, false)])).toBe(RETRY_IDLE);
    expect(run([tapped, { type: "dismissed" }])).toBe(RETRY_IDLE);
    expect(run([tapped, snap("failed", 5), snap("collecting", 6)])).toBe(RETRY_IDLE);
  });

  it("goes back to idle when the retry request itself fails", () => {
    expect(run([tapped, { type: "request_failed" }])).toBe(RETRY_IDLE);
    // A late request failure doesn't undo what the snapshots showed.
    expect(run([tapped, snap("cloning", 5), { type: "request_failed" }]).phase).toBe("cloning");
  });

  it("follows a clone that turns up after a (wrong) repeat-failure note, and a fresh tap starts over", () => {
    const noted = run([tapped, snap("failed", 5)]);
    expect(run([snap("cloning", 6)], noted).phase).toBe("cloning");
    const again = retryReducer(noted, { type: "requested", at: T0 + 60_000, signals: 9 });
    expect(again).toEqual({ phase: "pending", since: T0 + 60_000, signalsAtStart: 9 });
    expect(retryReducer(again, snap("failed", 9)).phase).toBe("pending");
  });
});

describe("retryView", () => {
  const pending = run([tapped]);

  it("shows 'Trying again…' while pending, then the repeat-failure note after RETRY_PENDING_MS without any sign", () => {
    expect(retryView(pending, "failed", T0 + 1_000)).toEqual({ retrying: true, failedAgain: false });
    expect(retryView(pending, "failed", T0 - 4_000)).toEqual({ retrying: true, failedAgain: false }); // a stale clock
    expect(retryView(pending, "failed", T0 + RETRY_PENDING_MS)).toEqual({ retrying: false, failedAgain: true });
  });

  it("shows nothing unless the twin is in the failed state", () => {
    for (const state of ["collecting", "cloning", "ready", undefined, null] as const) {
      expect(retryView(pending, state, T0 + 1_000)).toEqual({ retrying: false, failedAgain: false });
      expect(retryView(run([tapped, snap("failed", 5)]), state, T0)).toEqual({ retrying: false, failedAgain: false });
    }
    expect(retryView(RETRY_IDLE, "failed", T0)).toEqual({ retrying: false, failedAgain: false });
  });
});

describe("twinFailureDetail", () => {
  it("drops the generic message, which only restates the heading", () => {
    expect(twinFailureDetail("We couldn't make your AI Voice Twin. You can try again from Settings.")).toBeNull();
    expect(twinFailureDetail("We couldn’t make your AI Voice Twin this time.")).toBeNull();
    expect(twinFailureDetail(null)).toBeNull();
    expect(twinFailureDetail(undefined)).toBeNull();
    expect(twinFailureDetail("   ")).toBeNull();
  });

  it("keeps a plain reason, without the restating sentences", () => {
    expect(twinFailureDetail("ElevenLabs asked for voice verification, so the clone can't be used.")).toBe(
      "ElevenLabs asked for voice verification, so the clone can't be used.",
    );
    expect(twinFailureDetail("We couldn't make your AI Voice Twin. There wasn't enough clear speech. You can try again from Settings.")).toBe(
      "There wasn't enough clear speech.",
    );
  });

  // Every message friendlyCloneError (lib/voice-twin/view.ts) can produce, as Settings shows it under its own heading.
  it.each([
    [
      "We couldn't make your AI Voice Twin: ElevenLabs asked for extra voice verification. You can try again from Settings.",
      "ElevenLabs asked for extra voice verification.",
    ],
    [
      "We couldn't make your AI Voice Twin: the ElevenLabs plan doesn't allow voice cloning right now. You can try again from Settings.",
      "The ElevenLabs plan doesn't allow voice cloning right now.",
    ],
    [
      "We couldn't make your AI Voice Twin: the ElevenLabs voice limit is full. You can try again from Settings.",
      "The ElevenLabs voice limit is full.",
    ],
    [
      "We couldn't make your AI Voice Twin from the speech we had. Record a short sample in Settings, then try again.",
      "The speech we had wasn't enough. Record a short sample below, then try again.",
    ],
    ["We couldn't make your AI Voice Twin. You can try again from Settings.", null],
  ])("%s", (error, detail) => {
    expect(twinFailureDetail(error)).toBe(detail);
  });

  it("never repeats the heading or points to Settings for any friendlyCloneError message", () => {
    for (const raw of ["needs verification", "402 subscription", "voice_limit_reached", "audio_too_short", "boom", null]) {
      const detail = twinFailureDetail(friendlyCloneError(raw));
      expect(detail ?? "").not.toMatch(/we couldn['’]t make your ai voice twin/i);
      expect(detail ?? "").not.toMatch(/settings/i);
      if (detail) expect(detail.charAt(0)).toBe(detail.charAt(0).toUpperCase());
    }
  });

  it("keeps a whole sentence rather than show a fragment when the heading runs on some other way", () => {
    expect(twinFailureDetail("We couldn't make your AI Voice Twin because the upload failed.")).toBe(
      "We couldn't make your AI Voice Twin because the upload failed.",
    );
  });
});
