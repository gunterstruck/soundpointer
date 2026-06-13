/* SoundPointer – Service Worker (Cache für Offline-/PWA-Betrieb)
 *
 * Hinweis: Die App wird mit Vite gebaut; JS/CSS erhalten dabei gehashte
 * Dateinamen (z. B. /assets/index-ab12cd.js). Diese können hier nicht fest
 * gelistet werden – daher werden nur die stabilen Dateien vorab gecacht und
 * alle übrigen GET-Anfragen zur Laufzeit per "cache-first" gespeichert. */
const CACHE = 'soundpointer-m1-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Cache-first; neue Assets (inkl. gehashter Build-Dateien) werden ergänzt.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
