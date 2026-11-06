/* NextGen Smart Classroom — app shell service worker
 * Network-first for HTML/JS/CSS so deploys apply without a manual hard refresh.
 */
const CACHE = 'ngsc-shell-v4';
const SHELL = [
  '/',
  '/index.html',
  '/offline-db.js',
  '/qrcode.min.js',
  '/nextgen.jpg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) =>
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
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function canCacheResponse(req, res) {
  if (!res || !res.ok) return false;
  if (res.status === 206) return false;
  if (res.type === 'opaque') return false;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  if (/\.(mp3|mp4|wav|ogg|webm)$/i.test(url.pathname)) return false;
  return true;
}

/** App shell scripts/styles: always try network first so updates land without hard refresh */
function isVolatileAsset(url) {
  return (
    url.pathname === '/app.js' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/index.html' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) return;

  // Navigations + volatile assets: network-first, fall back to cache offline
  if (req.mode === 'navigate' || isVolatileAsset(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (canCacheResponse(req, res)) {
            const copy = res.clone();
            const key = req.mode === 'navigate' ? '/' : req;
            caches.open(CACHE).then((cache) => cache.put(key, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((c) => c || caches.match('/') || caches.match('/index.html'))
        )
    );
    return;
  }

  // Other static assets: cache-first
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

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
