/**
 * The service worker that shows notification pushes. At the root so its scope covers the dashboard,
 * and public (see src/proxy.ts): the browser re-fetches it to check for updates, session or not,
 * and a redirect to /login fails that check.
 */

// Plain ES2017 so every browser that has Push can run it. Only this origin is ever opened: the
// payload's URL is the configured public one, which may not be where this browser signed in.
const WORKER = `"use strict";
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || self.location.host, {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/api/branding/favicon",
      data: { url: data.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = self.location.origin + "/";
  try {
    const url = new URL(event.notification.data.url, self.location.origin);
    if (url.origin === self.location.origin) target = url.href;
  } catch (error) {}
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
`;

export function GET() {
  return new Response(WORKER, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Browsers cap a worker's HTTP cache at a day anyway; this makes an upgrade land at once.
      "cache-control": "no-cache",
    },
  });
}
