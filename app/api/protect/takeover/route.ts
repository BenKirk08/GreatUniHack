import { z } from "zod";
import { parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { takeOver, type TakeoverRequest } from "@/lib/takeover";
import { customerTakeoverResponse } from "@/lib/takeover-http";

export const maxDuration = 30;

const bodySchema = z
  .object({
    callId: z.uuid(),
    /**
     * "ai_voice" (omitted, as the notification's action sends it, means the same) or "voice_twin". "auto" is what
     * pages from before the AI voices sent: it means the AI voice too.
     */
    choice: z.enum(["ai_voice", "voice_twin", "auto"]).optional(),
  })
  .strict();

/**
 * The customer's scam alert (the /protect page or the notification's action): "Use AI voice" hands the call to the AI
 * voice matched to them automatically; "Use my Voice Twin" to their own consented AI Voice Twin. An unusable twin
 * answers 409 twin_unavailable without claiming the call.
 */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  const request: TakeoverRequest = body.data.choice === "voice_twin" ? { by: "customer", voiceTwin: true } : { by: "customer" };
  return customerTakeoverResponse(await takeOver(body.data.callId, request));
}
