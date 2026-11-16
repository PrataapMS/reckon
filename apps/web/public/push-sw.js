// Web Push handler, imported into the generated service worker (vite.config.ts, workbox.importScripts).
// Payloads are { title, body, path } from the server's outbox (spec §1.5: the fallback channel).
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Reckon', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { path: data.path || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.path || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      if (open) return open.navigate(url).then((w) => (w || open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
