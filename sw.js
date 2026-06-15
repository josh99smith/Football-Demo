// Service worker: installable + offline play after first load.
// IMPORTANT: code (HTML/CSS/JS) is NETWORK-FIRST so deployed fixes reach players
// immediately when online (the old cache-first SW served stale code forever and
// updates never landed). Large static assets (GLB / textures / fonts / vendor /
// manifest) stay CACHE-FIRST for speed + offline. Bump CACHE to roll the cache.
const CACHE = '7v7-v3';
const CODE = /\.(?:html|css|js|mjs)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); // purge stale code
  await self.clients.claim();
})()));

async function cachePut(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    (await caches.open(CACHE)).put(req, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCode = req.mode === 'navigate' || CODE.test(url.pathname);
  if (isCode) {
    // Network-first: always try fresh code; fall back to cache when offline.
    e.respondWith((async () => {
      try { return await cachePut(req, await fetch(req)); }
      catch (err) { return (await caches.match(req)) || Response.error(); }
    })());
  } else {
    // Cache-first: the big GLB/texture assets rarely change and are large.
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try { return await cachePut(req, await fetch(req)); }
      catch (err) { return cached || Response.error(); }
    })());
  }
});
