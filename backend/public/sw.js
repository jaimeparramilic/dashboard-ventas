// backend/public/sw.js
const VERSION = 'v1.0.0';
const CACHE_NAME = `ventas-cache-${VERSION}`;

// Ajusta tu bucket:
const GCS_BASE = 'https://storage.googleapis.com/ventas-geo-bubbly-vine-471620-h1';

const PRECACHE_URLS = [
  '/',               // index.html
  '/index.html',
  '/script.js',
  '/logo_odds.png',
  `${GCS_BASE}/departamentos.geojson`,
  `${GCS_BASE}/ciudades.geojson`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Estrategia: stale-while-revalidate para GCS y estáticos
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  const isStatic =
    url.origin === self.location.origin ||
    url.href.startsWith(GCS_BASE);

  if (!isStatic || req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((res) => {
      // Sólo guarda 200 OK (o type: 'cors'/'basic')
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached); // offline fallback

    // Respuesta inmediata si hay caché, mientras se revalida
    return cached || fetchPromise;
  })());
});
