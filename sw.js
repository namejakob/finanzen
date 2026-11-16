// Service Worker: hält die App offline verfügbar.
// Bei jeder Änderung an einer App-Datei VERSION erhöhen, sonst sieht das Handy die neue Version nicht.
const VERSION = '1.1.0';
const CACHE = 'finanzen-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './js/app.js',
  './js/logic.js',
  './js/store.js',
  './js/sync.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' umgeht den HTTP-Cache, damit wirklich die neuen Dateien landen
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Nur eigene alte Caches löschen (andere Apps auf derselben Domain nicht anfassen)
      await Promise.all(keys.filter((k) => k.startsWith('finanzen-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  // Abgleich mit dem Server nie aus dem Zwischenspeicher
  if (url.pathname.startsWith(scope.pathname + 'api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => (await cache.match('./index.html')) || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(req, { ignoreSearch: true })) || fetch(req)),
  );
});
