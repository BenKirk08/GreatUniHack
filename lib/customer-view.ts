import type { CallRisk, CallRow, TakeoverKind } from "@/lib/types";

/**
 * What the customer's /protect page may see about a call: no transcripts (only the two caller quotes on the alert),
 * intel, analyst names or raw errors.
 * `failed` replaces handoff_error with a flag.
 */
export interface CustomerCall {
  id: string;
  status: CallRow["status"];
  started_at: string;
  ended_at: string | null;
  caller_masked: string | null;
  /** `quotes`: the caller's two most suspicious lines so far, verbatim (the scam alert shows them). */
  risk: (Pick<CallRisk, "score" | "peak" | "scam_type" | "reason"> & { quotes: string[] }) | null;
  handoff_status: CallRow["handoff_status"];
  handoff_at: string | null;
  handoff_requested_at: string | null;
  persona: CallRow["persona"];
  /** Who took the call over: a persona or the customer's own AI Voice Twin (null before a takeover). */
  takeover_kind: TakeoverKind | null;
}

export const CUSTOMER_COLUMNS =
  "id, status, started_at, ended_at, caller_masked, risk, handoff_status, handoff_at, handoff_requested_at, persona, takeover_kind";

export function customerCall(c: Partial<CallRow> & Pick<CallRow, "id"> | null | undefined): CustomerCall | null {
  if (!c) return null;
  return {
    id: c.id,
    status: c.status ?? "ended",
    started_at: c.started_at ?? new Date(0).toISOString(),
    ended_at: c.ended_at ?? null,
    caller_masked: c.caller_masked ?? null,
    risk: c.risk
      ? {
          score: c.risk.score,
          peak: c.risk.peak,
          scam_type: c.risk.scam_type,
          reason: c.risk.reason,
          quotes: Array.isArray(c.risk.quotes) ? c.risk.quotes.filter((q): q is string => typeof q === "string").slice(0, 2) : [],
        }
      : null,
    handoff_status: c.handoff_status ?? "none",
    handoff_at: c.handoff_at ?? null,
    handoff_requested_at: c.handoff_requested_at ?? null,
    persona: c.persona ?? null,
    takeover_kind: c.takeover_kind ?? null,
  };
}

const URGENCY: Record<CallRow["handoff_status"], number> = { offered: 0, requested: 1, failed: 2, connected: 3, declined: 4, none: 5 };

/**
 * The call /protect should show: the most urgent live call (an open offer first, so a second incoming call can't
 * hide it), else the newest call (for the "Northgate has this call" screen after a takeover, or idle).
 */
export function pickCustomerCall<T extends Pick<CallRow, "status" | "handoff_status" | "started_at">>(live: T[], newest: T | null): T | null {
  const sorted = [...live]
    .filter((c) => c.status === "live")
    .sort((a, b) => URGENCY[a.handoff_status] - URGENCY[b.handoff_status] || Date.parse(b.started_at) - Date.parse(a.started_at));
  return sorted[0] ?? newest ?? null;
}
