/* Renowise Locator — service worker (PRD §12 / Appendix D)
   - install: precache the app shell + postcode GeoJSON + Leaflet + icons
   - fetch: OSM tiles → CacheFirst into a capped tiles cache
            same-origin → CacheFirst, falling back to network
   Selection works fully offline; only unseen tiles need the network. */

const VERSION = 'v10';
const SHELL_CACHE = 'renowise-shell-' + VERSION;
const TILE_CACHE = 'renowise-tiles-' + VERSION;
const TILE_CAP = 1500;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './i18n.js',
  './provinces.js',
  './manifest.webmanifest',
  './data/be_postcodes.geojson',
  './data/localities.json',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './vendor/images/layers.png',
  './vendor/images/layers-2x.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.png'
];

function isTileRequest(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) ||
         /(^|\.)tile\.osm\.org$/.test(url.hostname);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Tolerant precache: one missing asset (e.g. an icon still being generated)
    // must not abort the whole install.
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== SHELL_CACHE && k !== TILE_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

async function trimCache(cacheName, cap) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= cap) return;
  // keys() preserves insertion order → delete the oldest overflow.
  const overflow = keys.length - cap;
  for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // OSM tiles → CacheFirst into a capped tiles cache.
  if (isTileRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) {
          await cache.put(req, resp.clone());
          trimCache(TILE_CACHE, TILE_CAP); // fire-and-forget
        }
        return resp;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  // Same-origin → CacheFirst, fall back to network (and cache navigations/shell).
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: false });
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp && resp.ok && resp.type === 'basic') {
          cache.put(req, resp.clone());
        }
        return resp;
      } catch (_) {
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      }
    })());
    return;
  }
});
