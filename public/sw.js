/* SoundPointer – Service Worker
 *
 * Strategie: NETWORK-FIRST. Online wird immer die frische Datei vom Server
 * geladen (verhindert, dass nach einem Deploy eine veraltete index.html auf
 * nicht mehr passende, gehashte JS/CSS-Dateien zeigt). Der Cache dient nur als
 * Offline-Fallback. Beim Aktivieren werden alle alten Caches gelöscht. */
const CACHE = 'soundpointer-m1-v3';

self.addEventListener('install', () => {
  // Sofort übernehmen, nicht auf das Schließen aller Tabs warten.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k)))) // alle alten Caches weg
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req)) // offline: aus dem Cache bedienen
  );
});
