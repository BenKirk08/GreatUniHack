import { customerCall } from "@/lib/customer-view";
import { errorJson, json } from "@/lib/http";
import type { TakeoverResult } from "@/lib/takeover";
import { aiVoiceSummary } from "@/lib/voice-match";

/** Shown when the customer picks their AI Voice Twin but it can't take the call (nothing was claimed). */
export const TWIN_UNAVAILABLE_MESSAGE = "Your AI Voice Twin isn't ready right now. Tap Use AI voice instead.";

function conflictMessage(result: Extract<TakeoverResult, { outcome: "conflict" }>): string {
  if (result.call?.handoff_status === "connected") return "Northgate already has this call.";
  if (result.call?.handoff_status === "requested") return "This call is already being handed over.";
  if (result.call?.status === "ended") return "This call has ended.";
  return "This call can't be taken over right now.";
}

/**
 * Dashboard shape of a takeover: 200 connected (the AI voice and why, or null for the twin, plus the takeover kind),
 * 409 conflict, 502 failed (the customer is still on the line). Analysts only ever hand over to the AI voice, so
 * twin_unavailable can't happen here, but it is answered as a 409 like a conflict.
 */
export function takeoverResponse(result: TakeoverResult) {
  switch (result.outcome) {
    case "connected":
      return json({
        ok: true,
        outcome: "connected",
        persona: result.persona,
        aiVoice: result.aiVoice,
        aiVoiceLabel: result.aiVoice ? aiVoiceSummary(result.aiVoice) : null,
        takeover: result.takeover,
        simulated: result.simulated,
        call: result.call,
      });
    case "conflict":
      return json({ ok: false, outcome: "conflict", error: conflictMessage(result), call: result.call }, 409);
    case "twin_unavailable":
      return json({ ok: false, outcome: "twin_unavailable", error: TWIN_UNAVAILABLE_MESSAGE, call: result.call }, 409);
    case "failed":
      return errorJson(502, `Handover failed, so the customer is still on the line: ${result.error}`, { call: result.call });
  }
}

/** The customer's shape: the narrow call projection and plain-language errors (raw errors stay in the logs). */
export function customerTakeoverResponse(result: TakeoverResult) {
  switch (result.outcome) {
    case "connected":
      return json({ ok: true, outcome: "connected", call: customerCall(result.call), takeover: result.takeover });
    case "conflict":
      return json({ ok: false, outcome: "conflict", error: conflictMessage(result), call: customerCall(result.call) }, 409);
    case "twin_unavailable":
      return json({ ok: false, outcome: "twin_unavailable", error: TWIN_UNAVAILABLE_MESSAGE, call: customerCall(result.call) }, 409);
    case "failed":
      return json(
        {
          ok: false,
          outcome: "failed",
          error: "We couldn't take this call over. If you're unsure, hang up and call Northgate on the number on the back of your card.",
          call: customerCall(result.call),
        },
        502,
      );
  }
}
