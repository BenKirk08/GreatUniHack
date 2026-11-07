import { describe, expect, it } from "vitest";
import type { VoiceTwinRow } from "@/lib/types";
import { alertTwinSection, LIVE_CAPTURE_TEXT, liveCaptureStatus, twinExpiryLabel, twinProgress } from "@/lib/voice-twin/popup";
import { customerTwinView, type CustomerTwinView } from "@/lib/voice-twin/view";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const SETTINGS = { minSeconds: 30, targetSeconds: 60 };
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<VoiceTwinRow> = {}): VoiceTwinRow {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    account_ref: "customer",
    voice_twin_consent: true,
    consent_given_at: "2026-11-06T09:00:00.000Z",
    consent_given_by: "Ben (account holder, Call Guard Settings)",
    consent_text_version: "test",
    consent_user_agent: null,
    consent_revoked_at: null,
    state: "collecting",
    speech_seconds: 0,
    voice_id: null,
    voice_source: null,
    voice_created_at: null,
    voice_expires_at: null,
    clone_speech_seconds: null,
    clone_error: null,
    cloning_started_at: null,
    last_audio_at: null,
    created_at: "2026-11-06T09:00:00.000Z",
    updated_at: "2026-11-06T09:00:00.000Z",
    ...overrides,
  };
}

/** The customer's view of a twin row, exactly as /api/protect/state builds it. */
function view(overrides: Partial<VoiceTwinRow> = {}, now = NOW): CustomerTwinView {
  return customerTwinView(row(overrides), SETTINGS, now);
}

/** The same, with the media bridge (the Call Guard recording service) online. */
function bridgeView(overrides: Partial<VoiceTwinRow> = {}, now = NOW): CustomerTwinView {
  return customerTwinView(row(overrides), SETTINGS, now, { bridgeOnline: true });
}

function readyRow(overrides: Partial<VoiceTwinRow> = {}): Partial<VoiceTwinRow> {
  return {
    state: "ready",
    speech_seconds: 42,
    voice_id: "cloned-voice-1",
    voice_source: "clone",
    voice_created_at: new Date(NOW - HOUR).toISOString(),
    voice_expires_at: new Date(NOW + 23 * HOUR).toISOString(),
    clone_speech_seconds: 42,
    ...overrides,
  };
}

describe("the scam alert's AI Voice Twin section", () => {
  it("no consent: the small set-up link", () => {
    expect(alertTwinSection(null)).toEqual({ kind: "setup" });
    expect(alertTwinSection(customerTwinView(null, SETTINGS, NOW))).toEqual({ kind: "setup" });
    expect(alertTwinSection(view({ voice_twin_consent: false, consent_given_at: null }))).toEqual({ kind: "setup" });
  });

  it("consent, collecting: the progress bar with its label", () => {
    const section = alertTwinSection(bridgeView({ speech_seconds: 18.6 }));
    expect(section).toMatchObject({ kind: "progress", status: "collecting" });
    expect(section.kind === "progress" && section.progress).toMatchObject({ speechSeconds: 18.6, minSeconds: 30, progressLabel: "18s / 30s of your voice" });
  });

  it("consent, being made or failed: the progress component's own states", () => {
    expect(alertTwinSection(view({ state: "cloning", speech_seconds: 31, cloning_started_at: new Date(NOW).toISOString() }))).toMatchObject({
      kind: "progress",
      status: "cloning",
    });
    expect(alertTwinSection(view({ state: "failed", clone_error: "boom" }))).toMatchObject({ kind: "progress", status: "failed" });
  });

  it("ready: the Use my Voice Twin button (also on the fallback voice)", () => {
    expect(alertTwinSection(view(readyRow()))).toEqual({ kind: "ready" });
    expect(alertTwinSection(view(readyRow({ voice_source: "fallback" })))).toEqual({ kind: "ready" });
  });

  it("an expired ready twin is not usable: back to the progress bar from 0 s", () => {
    const expired = view(readyRow({ voice_expires_at: new Date(NOW - 1).toISOString() }));
    expect(alertTwinSection(expired)).toMatchObject({ kind: "progress", status: "collecting", progress: { speechSeconds: 0 } });
  });
});

describe("liveCaptureStatus", () => {
  it("is on or off while collecting or failed, following liveCapture", () => {
    expect(liveCaptureStatus(bridgeView({ speech_seconds: 5 }))).toBe("on");
    expect(liveCaptureStatus(view({ speech_seconds: 5 }))).toBe("off");
    expect(liveCaptureStatus(bridgeView({ state: "failed" }))).toBe("on");
    expect(liveCaptureStatus(view({ state: "failed" }))).toBe("off");
  });

  it("is null when it doesn't apply: no twin, no consent, being made, or usable", () => {
    expect(liveCaptureStatus(null)).toBeNull();
    expect(liveCaptureStatus(undefined)).toBeNull();
    expect(liveCaptureStatus(customerTwinView(null, SETTINGS, NOW, { bridgeOnline: true }))).toBeNull();
    expect(liveCaptureStatus(bridgeView({ state: "cloning", cloning_started_at: new Date(NOW).toISOString() }))).toBeNull();
    expect(liveCaptureStatus(bridgeView(readyRow()))).toBeNull();
  });

  it("uses the agreed wording on the main screen card and Settings", () => {
    expect(LIVE_CAPTURE_TEXT.on).toEqual({
      card: "Recording during calls: on",
      settings: "On: your side of flagged scam calls is added to your AI Voice Twin.",
    });
    expect(LIVE_CAPTURE_TEXT.off).toEqual({
      card: "Recording during calls: off (use Record a sample)",
      settings:
        "Off right now: the Call Guard recording service isn't running, so calls can't add to your AI Voice Twin yet. Use Record a sample now below, or ask for the recording service to be started.",
    });
  });
});

describe("twinProgress", () => {
  it("clamps the fill to the bar and never puts the target before the minimum", () => {
    expect(twinProgress({ speechSeconds: 500, minSeconds: 30, targetSeconds: 60 }).fill).toBe(1);
    expect(twinProgress({ speechSeconds: -3, minSeconds: 30, targetSeconds: 60 })).toMatchObject({ fill: 0, progressLabel: "0s / 30s of your voice" });
    const odd = twinProgress({ speechSeconds: 10, minSeconds: 40, targetSeconds: 20 });
    expect(odd.targetSeconds).toBe(40);
    expect(odd.targetMark).toBeCloseTo(1 / 1.2, 10);
    expect(odd.minMark).toBeCloseTo(1 / 1.2, 10);
  });

  it("floors the label so it never claims more than was captured", () => {
    expect(twinProgress({ speechSeconds: 29.97, minSeconds: 30, targetSeconds: 60 }).progressLabel).toBe("29s / 30s of your voice");
  });
});

describe("twinExpiryLabel", () => {
  const now = new Date(2026, 10, 6, 12, 0).getTime(); // local time, so the test holds in any time zone

  it("shows a time today, 'tomorrow', or a date further out", () => {
    expect(twinExpiryLabel(new Date(2026, 10, 6, 14, 5).toISOString(), now)).toBe("14:05");
    expect(twinExpiryLabel(new Date(2026, 10, 7, 9, 30).toISOString(), now)).toBe("09:30 tomorrow");
    expect(twinExpiryLabel(new Date(2026, 10, 9, 9, 30).toISOString(), now)).toMatch(/^09:30 on /);
  });

  it("is empty for a missing or unreadable time", () => {
    expect(twinExpiryLabel(null, now)).toBe("");
    expect(twinExpiryLabel("not a date", now)).toBe("");
  });
});
