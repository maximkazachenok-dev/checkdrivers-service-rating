/* PRIMUM service worker — офлайн-оболочка + фоновая досылка ответов. */
const CACHE = 'primum-shell-v11';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './content.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  // материалы раздела «Советы по эко-вождению» — должны быть доступны офлайн
  './eco-what-1.webp',
  './eco-what-2.webp',
  './eco-what-3.webp',
  './eco-what-4.webp',
  './eco-tips.webp'
];

self.addEventListener('install', (e) => {
  // Файлы кладём в кэш ПООДИНОЧКЕ. cache.addAll() атомарен: один недостающий
  // файл (например, не залитый на хостинг) обрушивал установку целиком,
  // из-за чего новый service worker не активировался и устройство
  // продолжало работать на старом коде.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(SHELL.map((url) =>
        c.add(url).catch((err) => {
          console.warn('[PRIMUM SW] Не удалось закэшировать', url, err && err.message);
        })
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Код (HTML/JS/манифест) — network-first: телефон всегда получает свежую версию,
// а кэш служит запасом на случай отсутствия сети. Прежняя схема cache-first
// приводила к тому, что устройство месяцами работало на старом коде.
const NET_FIRST = ['index.html', 'app.js', 'content.js', 'manifest.webmanifest', ''];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Apps Script, шрифты — напрямую в сеть

  const file = url.pathname.split('/').pop();
  const netFirst = req.mode === 'navigate' || NET_FIRST.indexOf(file) !== -1;

  if (netFirst) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    // Картинки и иконки почти не меняются — их быстрее отдавать из кэша.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
  }
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
