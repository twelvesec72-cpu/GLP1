const CACHE_NAME = "glp1-tracker-v4";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try the live page first so you never get stuck on a
// stale copy while online. Only falls back to the cache if the network
// request genuinely fails (actually offline).
//
// IMPORTANT: only intercept requests for this app's own files. Requests to
// the dellcasa backend (backup, photos, reminders — a different origin) must
// pass straight through untouched. Intercepting them here previously caused
// restore-from-backup and other server calls to fail unpredictably.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---------- push notification reminders (weight / photo / shot) ----------
self.addEventListener("push", (event) => {
  let data = { title: "GLP-1 Tracker", body: "You have a reminder." };
  try { if (event.data) data = event.data.json(); } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: data.tag || "reminder",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) { if ("focus" in client) return client.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
