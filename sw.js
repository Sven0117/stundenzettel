// Offline-Betrieb der Web-App (iPhone/PC). Online wird immer die neueste Version geladen,
// ohne Netz kommt die zuletzt gespeicherte aus dem Cache.
const CACHE = 'stundenzettel-v2';
const DATEIEN = ['./', 'index.html', 'app.js', 'logo.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Dropbox-Anfragen nicht anfassen
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const kopie = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, kopie)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
