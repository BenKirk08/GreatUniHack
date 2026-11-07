import webpush, { WebPushError } from "web-push";
import badge from "@/app/protect/_assets/badge-96.png";
import icon from "@/app/protect/_assets/icon-192.png";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { SCAM_TYPE_PLAIN } from "@/lib/persona-meta";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CallRisk } from "@/lib/types";

/** What /api/protect/subscribe accepts: a browser PushSubscription.toJSON(). */
/** Browser push services (Chrome/Edge via FCM, Firefox, Apple, Windows). The server never POSTs anywhere else. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  return (
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com")
  );
}

/** At most this many devices get alerts (the newest ones). */
export const MAX_PUSH_DEVICES = 5;

export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000).refine(isPushServiceEndpoint, "Unsupported push service"),
  expirationTime: z.number().nullish(),
  keys: z.object({
    p256dh: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+=*$/),
    auth: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+=*$/),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** What /api/protect/test-alert accepts: this device's subscription endpoint, and nothing else. */
export const testAlertSchema = z.object({ endpoint: pushSubscriptionSchema.shape.endpoint }).strict();

let configured = false;
function configure() {
  if (configured) return;
  const env = serverEnv();
  webpush.setVapidDetails(`mailto:${env.REPORT_TO_EMAIL}`, env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
}

export interface OfferPushPayload {
  type: "offer";
  callId: string;
  title: string;
  body: string;
  url: string;
  icon: string;
  badge: string;
  /**
   * The customer's AI Voice Twin can take the call. The notification then only opens /protect so they choose ("Use my
   * Voice Twin" or "Use AI voice"), instead of offering the one-tap "Use AI voice" handover.
   */
  twinReady: boolean;
}

export interface OfferPushOptions {
  twinReady?: boolean;
}

/** The push message for a takeover offer (read by public/sw.js). */
export function offerPayload(callId: string, risk: Pick<CallRisk, "scam_type" | "reason">, opts: OfferPushOptions = {}): OfferPushPayload {
  return {
    type: "offer",
    callId,
    title: "Suspected scam",
    body: `${SCAM_TYPE_PLAIN[risk.scam_type] ?? SCAM_TYPE_PLAIN.unknown}. ${risk.reason}`.slice(0, 300),
    url: "/protect",
    icon: icon.src,
    badge: badge.src,
    twinReady: opts.twinReady === true,
  };
}

/**
 * Send the takeover offer to every subscribed device. Expired subscriptions (404/410) are deleted.
 * Never throws: the /protect page also shows the alert live, so push is best-effort.
 */
export async function sendOfferPush(
  callId: string,
  risk: Pick<CallRisk, "scam_type" | "reason">,
  opts: OfferPushOptions = {},
): Promise<{ sent: number; failed: number }> {
  const db = supabaseAdmin();
  try {
    configure();
    const { data, error } = await db
      .from("push_subscriptions")
      .select("id, endpoint, keys")
      .order("created_at", { ascending: false })
      .limit(MAX_PUSH_DEVICES);
    if (error) throw new Error(error.message);
    const payload = JSON.stringify(offerPayload(callId, risk, opts));
    let sent = 0;
    let failed = 0;
    await Promise.all(
      (data ?? []).map(async (sub: { id: string; endpoint: string; keys: { p256dh: string; auth: string } }) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 120, urgency: "high", timeout: 8_000 });
          sent++;
          await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString() }).eq("id", sub.id);
        } catch (err) {
          failed++;
          if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            await db.from("push_subscriptions").delete().eq("id", sub.id);
            console.info(`push: removed expired subscription ${sub.id}`);
          } else {
            console.warn(`push: send to ${sub.id} failed`, err instanceof WebPushError ? `${err.statusCode} ${err.body}` : err);
          }
        }
      }),
    );
    console.info(`push: offer for ${callId} sent to ${sent} device(s)${failed ? `, ${failed} failed` : ""}`);
    return { sent, failed };
  } catch (error) {
    console.error(`push: offer for ${callId} failed`, error);
    return { sent: 0, failed: 0 };
  }
}

/** The push message for "Send a test alert" on /protect: a plain notification, with no handover (public/sw.js). */
export interface TestPushPayload {
  type: "test";
  title: string;
  body: string;
  tag: string;
  url: string;
  icon: string;
  badge: string;
}

export function testPayload(): TestPushPayload {
  return {
    type: "test",
    title: "Call Guard test alert",
    body: "Alerts are working on this phone.",
    tag: "call-guard-test",
    url: "/protect",
    icon: icon.src,
    badge: badge.src,
  };
}

/**
 * - sent: the push service accepted it.
 * - not_found: that endpoint isn't signed up (turn alerts on again).
 * - expired: the push service says it's gone (404/410); it has been deleted (turn alerts on again).
 * - failed: the push service refused it for another reason, or didn't answer.
 */
export type TestPushOutcome = "sent" | "not_found" | "expired" | "failed";

/**
 * Send one test alert to one signed-up device. The endpoint must already be in push_subscriptions, so this never
 * POSTs anywhere the customer's own "Turn on alerts" didn't sign up. Throws only if the database can't be read.
 */
export async function sendTestPush(endpoint: string): Promise<{ outcome: TestPushOutcome }> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("push_subscriptions").select("id, endpoint, keys").eq("endpoint", endpoint).maybeSingle();
  if (error) throw new Error(`Could not read the push subscription: ${error.message}`);
  const sub = data as { id: string; endpoint: string; keys: { p256dh: string; auth: string } } | null;
  if (!sub || sub.endpoint !== endpoint) return { outcome: "not_found" };
  try {
    configure();
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(testPayload()), {
      TTL: 60,
      urgency: "high",
      timeout: 8_000,
    });
    await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString() }).eq("id", sub.id);
    console.info(`push: test alert sent to ${sub.id}`);
    return { outcome: "sent" };
  } catch (err) {
    if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
      await db.from("push_subscriptions").delete().eq("id", sub.id);
      console.info(`push: removed expired subscription ${sub.id} (test alert)`);
      return { outcome: "expired" };
    }
    console.warn(`push: test alert to ${sub.id} failed`, err instanceof WebPushError ? `${err.statusCode} ${err.body}` : err);
    return { outcome: "failed" };
  }
}

export async function saveSubscription(sub: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("push_subscriptions")
    .upsert({ endpoint: sub.endpoint, keys: sub.keys, user_agent: userAgent?.slice(0, 300) ?? null }, { onConflict: "endpoint" });
  if (error) throw new Error(`Could not save the push subscription: ${error.message}`);
  // Keep only the newest few devices.
  const { data: extra } = await supabaseAdmin()
    .from("push_subscriptions")
    .select("id")
    .order("created_at", { ascending: false })
    .range(MAX_PUSH_DEVICES, MAX_PUSH_DEVICES + 50);
  if (extra?.length) await supabaseAdmin().from("push_subscriptions").delete().in("id", extra.map((r: { id: string }) => r.id));
}
