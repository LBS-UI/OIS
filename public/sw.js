/* NextGen Smart Classroom — app shell service worker */
const CACHE = 'ngsc-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/offline-db.js',
  '/qrcode.min.js',
  '/styles.css',
  '/nextgen.jpg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) =>
        // Cache shell files individually so one failure does not break install
        Promise.all(
          SHELL.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] skip cache', url, err && err.message ? err.message : err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function canCacheResponse(req, res) {
  if (!res || !res.ok) return false;
  // Cache API rejects partial responses (HTTP 206) — common for audio/video range requests
  if (res.status === 206) return false;
  if (res.type === 'opaque') return false;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  // Avoid caching media that browsers often request with Range headers
  if (/\.(mp3|mp4|wav|ogg|webm)$/i.test(url.pathname)) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept API calls
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for navigation
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (canCacheResponse(req, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for same-origin static assets (except media)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (canCacheResponse(req, res)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy).catch(() => {}));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Focus or open the dashboard when a local notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (client.navigate && targetUrl) {
            try { client.navigate(targetUrl); } catch (_) {}
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
