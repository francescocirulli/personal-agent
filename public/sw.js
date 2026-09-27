const CACHE = 'personal-agent-shell-v14';
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', '/icon-192.png', '/icon-512.png'])),
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache chat content, audio, credentials, or requests to external services.
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              void caches.open(CACHE).then((cache) => cache.put(event.request, clone));
            }
            return res;
          }),
      ),
    );
  }
});
async function updateBadge(count) {
  if (!Number.isInteger(count) || count < 0) return;
  try {
    if (count) await self.navigator.setAppBadge?.(count);
    else await self.navigator.clearAppBadge?.();
  } catch {
    /* Badges may be disabled by the operating system. */
  }
}
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Personal Agent', {
        body: data.body || 'La risposta è pronta.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || 'agent',
        data: { url: data.url || '/' },
      }),
      updateBadge(data.unreadCount),
    ]),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client =
        clients.find(
          (c) => new URL(c.url).searchParams.get('chat') === url.searchParams.get('chat'),
        ) || clients[0];
      if (client) {
        await client.navigate(url.href);
        return client.focus();
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
