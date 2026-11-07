/*
 * Northgate Call Guard service worker (scope /protect). Shows the takeover alert; works alongside the live page.
 * Served publicly (proxy.ts): nothing private here, and browsers may fetch or update it without cookies.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  if (!data || typeof data !== "object") data = {}; // e.g. a "null" payload: still show the alert
  // "Send a test alert" on /protect: a plain notification with no handover actions.
  if (data.type === "test") {
    event.waitUntil(
      self.registration.showNotification(data.title || "Call Guard test alert", {
        body: data.body || "Alerts are working on this phone.",
        tag: data.tag || "call-guard-test",
        renotify: true,
        icon: data.icon,
        badge: data.badge,
        data: { callId: null, url: data.url || "/protect", twinReady: false, test: true },
      }),
    );
    return;
  }
  const title = data.title || "Suspected scam";
  // With the AI Voice Twin ready the customer chooses on /protect ("Use my Voice Twin" or "Use AI voice"), so the
  // notification only opens the page. Otherwise it offers the one-tap handover to the AI voice (matched automatically).
  const twinReady = data.twinReady === true;
  const actions = twinReady
    ? [
        { action: "choose", title: "Open the alert" },
        { action: "dismiss", title: "Dismiss" },
      ]
    : [
        { action: "handover", title: "Use AI voice" },
        { action: "dismiss", title: "Dismiss" },
      ];
  // Every push must show a notification (Safari revokes permission otherwise).
  event.waitUntil(
    self.registration.showNotification(title, {
      body:
        data.body || (twinReady ? "Open Call Guard to choose who takes this call." : "Open Call Guard to hand this call to the AI voice."),
      tag: data.callId ? `offer-${data.callId}` : "call-guard",
      renotify: true,
      requireInteraction: true,
      icon: data.icon,
      badge: data.badge,
      data: { callId: data.callId || null, url: data.url || "/protect", twinReady },
      actions,
    }),
  );
});

async function focusOrOpen(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).pathname.startsWith("/protect")) {
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  notification.close();
  if (event.action === "dismiss") return;
  const { callId, url, twinReady } = notification.data || {};
  // Send the handover first, then open /protect straight away (opening a window must happen while the click still
  // counts as a user gesture; the takeover itself can take several seconds). The page shows the outcome live.
  // With the AI Voice Twin ready there is no automatic handover: the click only opens /protect to choose.
  const handover =
    event.action === "handover" && callId && !twinReady
      ? fetch("/api/protect/takeover", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId }),
        }).catch(() => undefined)
      : Promise.resolve();
  event.waitUntil(Promise.all([focusOrOpen(url || "/protect").catch(() => undefined), handover]));
});
