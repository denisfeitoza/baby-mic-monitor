const CACHE_NAME = 'baby-monitor-v1';
const PRECACHE = ['/', '/index.html', '/style.css', '/main.js', '/yamnet.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for API/model, cache-first for static
  if (e.request.url.includes('tfhub.dev') || e.request.url.includes('cdn.jsdelivr')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(e.request).then(resp => { cache.put(e.request, resp.clone()); return resp; })
          .catch(() => cache.match(e.request))
      )
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
