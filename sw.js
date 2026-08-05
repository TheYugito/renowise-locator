/* Renowise Locator — service worker (PRD §12 / Appendix D)
   - install: precache the app shell + postcode GeoJSON + Leaflet + icons
   - fetch: OSM tiles → CacheFirst into a capped tiles cache
            same-origin → CacheFirst, falling back to network
   Selection works fully offline; only unseen tiles need the network. */

const VERSION = 'v17';
const SHELL_CACHE = 'renowise-shell-' + VERSION;
// Deliberately NOT versioned. It used to be 'renowise-tiles-' + VERSION, so every
// app update threw away up to 1,500 map tiles the operator had cached in the
// field — update the app, go offline, get a blank grey map. Bump this only if
// the tile source or scheme changes.
const TILE_CACHE = 'renowise-tiles-v1';
const TILE_CAP = 1500;

// Small shell files get stale-while-revalidate so a deploy that forgets to bump
// VERSION still lands on the next load instead of freezing an install forever
// (the SW intercepts reloads too, so there is otherwise no way out). The big
// data/vendor/icon assets stay strictly cache-first — re-fetching a 380 KB
// GeoJSON on every launch would be wasteful on exactly the flaky connections
// this app exists for.
const REVALIDATE = /(^|\/)(index\.html|app\.js|styles\.css|i18n\.js|provinces\.js|manifest\.webmanifest)$|\/$/;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './i18n.js',
  './provinces.js',
  './manifest.webmanifest',
  './data/be_postcodes.topojson',
  './data/localities.json',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/topojson-client.min.js',
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
          // Best-effort, and deliberately NOT awaited inside this try: opaque
          // tiles carry a padded quota cost, and a QuotaExceededError from put()
          // must not discard a tile the network already delivered (it used to
          // fall through to the catch below and render as a hole in the map).
          cache.put(req, resp.clone())
            .then(() => trimCache(TILE_CACHE, TILE_CAP))
            .catch(() => {});
        }
        return resp;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  // Same-origin → cache-first for speed and offline; the small shell files also
  // revalidate in the background so an update can never get permanently stuck.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: false });
      const refresh = REVALIDATE.test(url.pathname);

      const fromNetwork = (hit && !refresh) ? null : fetch(req)
        .then((resp) => {
          if (resp && resp.ok && resp.type === 'basic') cache.put(req, resp.clone()).catch(() => {});
          return resp;
        })
        .catch(() => null);

      if (hit) return hit;                 // instant; any refresh lands next load
      const resp = await fromNetwork;
      if (resp) return resp;
      try {
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }
});
