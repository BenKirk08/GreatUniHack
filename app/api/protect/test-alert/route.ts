import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { sendTestPush, testAlertSchema } from "@/lib/push";

const SIGN_UP_AGAIN = "This phone isn't signed up for alerts any more. Tap Turn on alerts to sign it up again.";

/**
 * "Send a test alert" on /protect: one push to this device only. The endpoint must already be signed up
 * (push_subscriptions); expired ones are deleted, and either way the customer is asked to turn alerts on again.
 */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, testAlertSchema);
  if (!body.ok) return body.response;

  try {
    const { outcome } = await sendTestPush(body.data.endpoint);
    switch (outcome) {
      case "sent":
        return json({ ok: true, outcome });
      case "not_found":
        return json({ ok: false, outcome, error: SIGN_UP_AGAIN }, 404);
      case "expired":
        return json({ ok: false, outcome, error: SIGN_UP_AGAIN }, 410);
      case "failed":
        return json({ ok: false, outcome, error: "This phone's notification service didn't take the test alert. Please try again in a minute." }, 502);
    }
  } catch (error) {
    console.error("protect/test-alert failed", error);
    return errorJson(500, "Couldn't send a test alert. Please try again.");
  }
}
