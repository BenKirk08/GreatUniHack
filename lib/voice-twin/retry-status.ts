import type { VoiceTwinState } from "@/lib/types";
import type { CustomerTwinView } from "@/lib/voice-twin/view";

/**
 * Settings' "Try again" after a failed clone, as a pure reducer (client-safe).
 *
 * The retry route answers before the clone starts (it runs in after()), so the twin still reads 'failed' at first,
 * and a clone that fails again quickly can go failed → cloning → failed between two reads. So a 'failed' snapshot
 * only counts as "it failed again" when there is evidence the twin changed since the tap: it was seen to leave
 * 'failed', or the snapshot was read after a voice_twins change signal that arrived after the tap (the claim or the
 * failure itself). RETRY_PENDING_MS is only the backstop for when neither shows up (Realtime down and the polls
 * missed the clone, or the server didn't start one).
 */

/** "Trying again…" stays up at most this long without any sign of the clone. */
export const RETRY_PENDING_MS = 45_000;

export type RetryPhase =
  /** No retry being followed. */
  | "idle"
  /** Tapped; the clone hasn't visibly started (the request may still be out). */
  | "pending"
  /** The twin left 'failed': the progress view takes over until it ends. */
  | "cloning"
  /** It came back to 'failed': tell the customer it still didn't work. */
  | "failed_again";

export interface RetryState {
  phase: RetryPhase;
  /** When "Try again" was tapped (ms since the epoch). */
  since: number;
  /** voice_twins change signals the page had seen when "Try again" was tapped. */
  signalsAtStart: number;
}

export const RETRY_IDLE: RetryState = Object.freeze({ phase: "idle", since: 0, signalsAtStart: 0 });

export type RetryEvent =
  /** "Try again" tapped; `signals` is the count of voice_twins change signals seen so far. */
  | { type: "requested"; at: number; signals: number }
  /** The retry request itself failed (the page shows that error). */
  | { type: "request_failed" }
  /**
   * A twin snapshot. `signalsAtRead` is the signal count when its read started, or null when its freshness relative
   * to the signals is unknown (e.g. a twin carried in a sample upload's reply), which never counts as evidence.
   */
  | { type: "snapshot"; twin: Pick<CustomerTwinView, "consent" | "state">; signalsAtRead: number | null }
  /** Revoked, or otherwise no longer relevant. */
  | { type: "dismissed" };

export function retryReducer(state: RetryState, event: RetryEvent): RetryState {
  switch (event.type) {
    case "requested":
      return { phase: "pending", since: event.at, signalsAtStart: event.signals };
    case "request_failed":
      return state.phase === "pending" ? RETRY_IDLE : state;
    case "dismissed":
      return state.phase === "idle" ? state : RETRY_IDLE;
    case "snapshot": {
      if (state.phase === "idle") return state;
      const { twin, signalsAtRead } = event;
      if (!twin.consent) return RETRY_IDLE;
      if (twin.state === "cloning") return state.phase === "cloning" ? state : { ...state, phase: "cloning" };
      // Ready (or reset to collecting): the retry is over and the page says so itself.
      if (twin.state !== "failed") return RETRY_IDLE;
      if (state.phase === "cloning") return { ...state, phase: "failed_again" };
      if (state.phase === "pending" && signalsAtRead !== null && signalsAtRead > state.signalsAtStart) {
        return { ...state, phase: "failed_again" };
      }
      return state;
    }
  }
}

export interface RetryView {
  /** "Trying again…": spinner on the button, button disabled. */
  retrying: boolean;
  /** "We still couldn't make your AI Voice Twin". */
  failedAgain: boolean;
}

/** What the failed section shows, given the latest twin state and the clock. */
export function retryView(state: RetryState, twinState: VoiceTwinState | null | undefined, now: number): RetryView {
  if (twinState !== "failed") return { retrying: false, failedAgain: false };
  const timedOut = state.phase === "pending" && now - state.since >= RETRY_PENDING_MS;
  return { retrying: state.phase === "pending" && !timedOut, failedAgain: state.phase === "failed_again" || timedOut };
}

/** The heading every failure message starts with ("We couldn't make your AI Voice Twin…"), and what follows it. */
const HEADING_PREFIX = /^we couldn['’]t make your ai voice twin\b\s*(.*)$/i;
/** Points to Settings, where the customer already is. */
const TRY_FROM_SETTINGS = /^you can try again from settings\.?$/i;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One sentence of the error as Settings shows it under its own heading, or null when it only restates that heading. */
function detailSentence(sentence: string): string | null {
  if (TRY_FROM_SETTINGS.test(sentence)) return null;
  let text = sentence;
  const heading = HEADING_PREFIX.exec(sentence);
  if (heading) {
    const rest = heading[1].trim();
    // "We couldn't make your AI Voice Twin." / "… this time.": nothing but the heading.
    if (/^(this time)?\s*[.!]?$/i.test(rest)) return null;
    // "We couldn't make your AI Voice Twin: the ElevenLabs voice limit is full." → "The ElevenLabs voice limit is full."
    if (rest.startsWith(":")) text = rest.slice(1).trim();
    else {
      // "We couldn't make your AI Voice Twin from the speech we had." → "The speech we had wasn't enough."
      const from = /^from\s+(.+?)([.!?]?)$/i.exec(rest);
      if (from) text = `${from[1]} wasn't enough${from[2] || "."}`;
      // Anything else keeps the whole sentence rather than show a fragment.
    }
  }
  if (!text) return null;
  // Settings is this page: the sample recorder is the section below.
  return capitalise(text.replace(/\bin Settings\b/g, "below"));
}

/**
 * The plain reason to show on Settings under its own "We couldn't make your AI Voice Twin" heading (a first failure
 * or "We still couldn't…" after Try again), from CustomerTwinView.error (friendlyCloneError): the repeated heading
 * and the pointer to Settings are dropped. Null when the error adds nothing to the heading.
 */
export function twinFailureDetail(error: string | null | undefined): string | null {
  const sentences = (error ?? "")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(detailSentence)
    .filter((s): s is string => s !== null);
  return sentences.length ? sentences.join(" ") : null;
}
