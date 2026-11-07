import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { pushSubscriptionSchema, saveSubscription } from "@/lib/push";

/** Save this device's Web Push subscription (from "Turn on alerts" on /protect). */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, pushSubscriptionSchema);
  if (!body.ok) return body.response;
  try {
    await saveSubscription(body.data, req.headers.get("user-agent"));
    return json({ ok: true });
  } catch (error) {
    console.error("protect/subscribe failed", error);
    return errorJson(500, "Could not turn on alerts.");
  }
}
