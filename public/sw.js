// Minimal service worker for Memetic Masters TCG.
// - HTML / navigation requests:  network-first (so updates roll out fast),
//   fall back to cache, then to a cached /index.html shell.
// - All other GETs:               cache-first, refresh in background.
// - API, lobby, and socket.io:    bypass cache entirely (real-time).
// Bump CACHE_VERSION when shipping a breaking change to evict old assets.

const CACHE_VERSION = 'mmtcg-v21';
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try { await cache.add(SHELL_URL); } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // pass-through cross-origin
  // Real-time paths must never be cached.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/games/') ||
    url.pathname.startsWith('/socket.io/')
  ) return;

  // Navigation → network-first.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(SHELL_URL, fresh.clone()).catch(() => {});
        return fresh;
      } catch (_) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match(req)) || (await cache.match(SHELL_URL)) || Response.error();
      }
    })());
    return;
  }

  // Other GETs → cache-first with background refresh.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await fetchPromise) || Response.error();
  })());
});
