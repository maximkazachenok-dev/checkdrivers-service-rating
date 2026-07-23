/* PRIMUM service worker — офлайн-оболочка + фоновая досылка ответов. */
const CACHE = 'primum-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Оболочку отдаём из кэша (cache-first). Запросы к Apps Script (POST/данные) не кэшируем.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // внешние (Apps Script, шрифты) — сеть напрямую
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

// Background Sync: когда сеть вернётся, будим страницу — она досылает очередь из IndexedDB.
self.addEventListener('sync', (e) => {
  if (e.tag === 'primum-flush') {
    e.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'flush-queue' }));
      })
    );
  }
});
