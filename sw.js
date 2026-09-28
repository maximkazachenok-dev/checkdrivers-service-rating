/* PRIMUM service worker — офлайн-оболочка + фоновая досылка ответов. */
const CACHE = 'primum-shell-v21';
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
  './eco-tips.webp',
  // памятки раздела «Информация» — нужны офлайн: инструкция по связи
  // открывается как раз тогда, когда интернета в телефоне нет
  './info/border-1.webp',
  './info/border-2.webp',
  './info/border-3.webp',
  './info/border-4.webp',
  './info/border-5.webp',
  './info/border-6.webp',
  './info/border-7.webp',
  './info/border-8.webp',
  './info/border-qr-1.webp',
  './info/border-qr-2.webp',
  './info/cis-beltoll-proxy.webp',
  './info/cis-beltoll.webp',
  './info/cis-platon-passport.webp',
  './info/cis-platon-proxy.webp',
  './info/cis-platon.webp',
  './info/comm-02.webp',
  './info/comm-03.webp',
  './info/comm-04.webp',
  './info/comm-05.webp',
  './info/comm-06.webp',
  './info/comm-07.webp',
  './info/comm-08.webp',
  './info/comm-09.webp',
  './info/comm-10.webp',
  './info/comm-11.webp',
  './info/comm-13.webp',
  './info/comm-14.webp',
  './info/comm-15.webp',
  './info/comm-16.webp',
  './info/comm-17.webp',
  './info/comm-18.webp',
  './info/comm-19.webp',
  './info/comm-20.webp',
  './info/comm-22.webp',
  './info/comm-23.webp',
  './info/comm-24.webp',
  './info/comm-25.webp',
  './info/comm-26.webp',
  './info/comm-27.webp',
  './info/comm-28.webp',
  './info/comm-29.webp',
  './info/comm-30.webp',
  './info/epi-1.webp',
  './info/epi-2.webp',
  './info/eu-devices.webp',
  './info/stone-map-1.webp',
  './info/stone-map-2.webp',
  './info/stone-map-3.webp',
  './info/tracker-02.webp',
  './info/tracker-03.webp',
  './info/tracker-04.webp',
  './info/tracker-05.webp',
  './info/tracker-06.webp',
  './info/tracker-07.webp',
  './info/tracker-08.webp',
  './info/tracker-09.webp',
  './info/tracker-10.webp',
  './info/tracker-11.webp',
  './info/tracker-12.webp',
  './info/tracker-13.webp',
  './info/tracker-14.webp',
  './info/tracker-15.webp',
  './info/tracker-16.webp',
  './info/tracker-17.webp',
  './info/tracker-18.webp',
  './info/tracker-19.webp',
  './info/tracker-20.webp',
  './info/tracker-21.webp',
  './info/tracker-22.webp',
  './info/tracker-23.webp',
  './info/tracker-24.webp',
  './info/tracker-25.webp',
  './info/tracker-26.webp',
  './info/tracker-27.webp',
  './info/tracker-28.webp'
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
