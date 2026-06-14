// Minimal service worker: makes the game installable and playable offline after
// the first load. Runtime cache-first for same-origin GETs (the GLB assets are
// large, so we cache them as they're fetched rather than precaching upfront).
const CACHE = '7v7-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        (await caches.open(CACHE)).put(req, copy);
      }
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
