import type { VoiceTwinState } from "@/lib/types";
import { progressLabel, type CustomerTwinView } from "@/lib/voice-twin/view";

/**
 * The scam alert's AI Voice Twin section as a pure model, so the rules are testable and the component only renders.
 * Client-safe: no env, no I/O.
 *
 *  - no consent → a small "Set up Voice Twin" link;
 *  - consent, twin not usable yet → the progress bar ("18s / 30s of your voice"), or "Making…" / "Couldn't be made";
 *  - twin usable → a single "Use my Voice Twin" button.
 * Below it, always, the one "Use AI voice" button (the voice is matched to the customer automatically).
 */

/** The progress bar's numbers. The scale runs 0…targetSeconds×1.2, so the "good quality" mark sits inside the bar. */
export interface TwinProgress {
  speechSeconds: number;
  minSeconds: number;
  targetSeconds: number;
  /** Fractions of the bar in [0, 1]. */
  fill: number;
  minMark: number;
  targetMark: number;
  /** "18s / 30s of your voice". */
  progressLabel: string;
}

/** Whether calls are adding the customer's voice to their AI Voice Twin right now. */
export type LiveCaptureStatus = "on" | "off";

/** The wording for "Recording during calls" on the main screen card and Settings. */
export const LIVE_CAPTURE_TEXT: Record<LiveCaptureStatus, { card: string; settings: string }> = {
  on: {
    card: "Recording during calls: on",
    settings: "On: your side of flagged scam calls is added to your AI Voice Twin.",
  },
  off: {
    card: "Recording during calls: off (use Record a sample)",
    settings:
      "Off right now: the Call Guard recording service isn't running, so calls can't add to your AI Voice Twin yet. Use Record a sample now below, or ask for the recording service to be started.",
  },
};

/**
 * "on" or "off" while the twin can still take in the customer's voice (consent given, not usable, collecting or
 * failed: the same states live capture and "Record a sample now" work in), otherwise null: no consent, the twin is
 * usable (nothing more to collect) or being made (it already has enough).
 */
export function liveCaptureStatus(
  twin: Pick<CustomerTwinView, "consent" | "usable" | "state" | "liveCapture"> | null | undefined,
): LiveCaptureStatus | null {
  if (!twin?.consent || twin.usable) return null;
  if (twin.state !== "collecting" && twin.state !== "failed") return null;
  return twin.liveCapture ? "on" : "off";
}

/** How far past the "good quality" mark the bar runs. */
const BAR_HEADROOM = 1.2;

function fraction(value: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / scale));
}

/** The progress bar for a twin view (also used by the main screen's card and Settings). */
export function twinProgress(twin: Pick<CustomerTwinView, "speechSeconds" | "minSeconds" | "targetSeconds">): TwinProgress {
  const minSeconds = Math.max(0, twin.minSeconds);
  const targetSeconds = Math.max(twin.targetSeconds, minSeconds);
  const speechSeconds = Math.max(0, Number.isFinite(twin.speechSeconds) ? twin.speechSeconds : 0);
  const scale = Math.max(targetSeconds, 1) * BAR_HEADROOM;
  return {
    speechSeconds,
    minSeconds,
    targetSeconds,
    fill: fraction(speechSeconds, scale),
    minMark: fraction(minSeconds, scale),
    targetMark: fraction(targetSeconds, scale),
    progressLabel: progressLabel(speechSeconds, minSeconds),
  };
}

/** The scam alert's AI Voice Twin section. */
export type AlertTwinSection =
  | { kind: "setup" }
  | { kind: "progress"; progress: TwinProgress; status: VoiceTwinState }
  | { kind: "ready" };

/** What the alert shows for the twin: the set-up link, its progress, or the "Use my Voice Twin" button. */
export function alertTwinSection(twin: CustomerTwinView | null | undefined): AlertTwinSection {
  if (!twin?.consent) return { kind: "setup" };
  if (twin.usable) return { kind: "ready" };
  // A 'ready' row that reads as not usable (its voice just expired) is collecting again.
  return { kind: "progress", progress: twinProgress(twin), status: twin.state === "ready" ? "collecting" : twin.state };
}

/**
 * "14:05" today, "14:05 tomorrow", or a date further out, for "Ready until …" (the viewer's local time).
 * Empty when the time is missing or unreadable.
 */
export function twinExpiryLabel(expiresAt: string | null | undefined, now: number): string {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const when = new Date(at);
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (when.toDateString() === today.toDateString()) return time;
  if (when.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${time} on ${when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
}
