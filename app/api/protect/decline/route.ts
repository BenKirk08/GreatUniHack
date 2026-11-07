import { z } from "zod";
import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { customerCall } from "@/lib/customer-view";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CallRow } from "@/lib/types";

const bodySchema = z.object({ callId: z.uuid() }).strict();

/**
 * "I know this caller": decline the offer. Remembers the score at decline; the call is only offered again if the
 * score rises 15+ points above it (see record_risk_score).
 */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  const { data, error } = await supabaseAdmin().rpc("decline_offer", { p_call_id: body.data.callId });
  if (error) {
    console.error("protect/decline failed", error);
    return errorJson(500, "Could not save that.");
  }
  const call = ((Array.isArray(data) ? data : data ? [data] : []) as CallRow[])[0];
  if (!call) return errorJson(409, "There's no alert to dismiss on this call.");
  return json({ ok: true, call: customerCall(call) });
}
