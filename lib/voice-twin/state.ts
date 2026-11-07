import type { VoiceTwinState } from "@/lib/types";

/**
 * The AI Voice Twin state machine (pure). The database enforces the same transitions atomically
 * (voice_twin_add_audio, voice_twin_claim_clone, the conditional finish/fail updates, voice_twin_expire,
 * voice_twin_revoke in 0009); lib/voice-twin/memory-store.ts uses this function directly.
 *
 *   collecting ──clone_claimed──▶ cloning ──clone_succeeded──────────────▶ ready
 *        ▲                          │      ──clone_failed (fallback set)─▶ ready (voice_source 'fallback')
 *        │                          └────clone_failed (no fallback)────▶ failed ──clone_claimed (retry)──▶ cloning
 *        └──────────── expired (24 h, ready only) / revoked (from any state) ─────────────────────────────┘
 *
 * Audio is only accepted while collecting (or failed, so a retry has more to work with); a stale 'cloning' claim
 * (its run died) may be claimed again.
 */
export type VoiceTwinEvent =
  | { type: "audio_added" }
  | { type: "clone_claimed"; retry?: boolean; stale?: boolean }
  | { type: "clone_succeeded" }
  | { type: "clone_failed"; fallback: boolean }
  | { type: "expired" }
  | { type: "revoked" };

/** The next state, or null when the event isn't allowed in this state. */
export function nextTwinState(state: VoiceTwinState, event: VoiceTwinEvent): VoiceTwinState | null {
  switch (event.type) {
    case "audio_added":
      return state === "collecting" || state === "failed" ? state : null;
    case "clone_claimed":
      if (state === "collecting") return "cloning";
      if (state === "failed" && event.retry) return "cloning";
      if (state === "cloning" && event.stale) return "cloning";
      return null;
    case "clone_succeeded":
      return state === "cloning" ? "ready" : null;
    case "clone_failed":
      return state === "cloning" ? (event.fallback ? "ready" : "failed") : null;
    case "expired":
      return state === "ready" ? "collecting" : null;
    case "revoked":
      return "collecting";
  }
}

/** Does this state accept new audio? */
export function acceptsAudio(state: VoiceTwinState): boolean {
  return nextTwinState(state, { type: "audio_added" }) !== null;
}
