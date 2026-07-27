# Renowise Locator

An offline-capable map tool for recording a subcontractor's coverage area in Belgium.
Tap postcode areas on the map; the panel builds a self-documenting list (name, date,
count, provinces) that is ready to screenshot, copy, or export.

**Live:** https://theyugito.github.io/renowise-locator/

Open it on a phone or iPad and use **Share → Add to Home Screen**. It then launches
full-screen and works offline — the postcode data ships with the app, and map tiles
are cached as you view them.

## What it does

- Tap postcode areas to select them, up to a limit (default 10, adjustable by tapping the counter).
- Search by postcode, town, **or village** — "Maransart" finds 1380 Lasne. Accent-insensitive.
- Each row shows its province code; the panel summarises the provinces covered.
- **Copy / Share** as text, **Save** named selections on-device, **Export** CSV + JSON.
- **EN / NL / FR** interface. Map labels use each region's own language.
- Works in portrait (draggable bottom sheet) and landscape (fixed side panel).

Nothing leaves the device: no backend, no accounts, no analytics. Saved names and
postcodes live in the browser's local storage only.

## Running it locally

No build step, no dependencies:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Note the service worker (offline + install) only
activates over HTTPS or on `localhost` — over a plain LAN IP everything works
*except* offline caching.

## Layout

```
index.html · styles.css · app.js · i18n.js · provinces.js · sw.js
data/be_postcodes.topojson   1,185 areas / 1,147 postcodes (~164 KB gzipped)
data/localities.json         2,218 village aliases for search
vendor/                      Leaflet + topojson-client, bundled for offline use
tools/                       data pipeline and verification (node tools/verify.js)
```

The map data is not a plain dump of its source — it is rebuilt to close gaps in
rural areas and to remove phantom overlaps in cities. `tools/build_postcodes.js`
documents and reproduces that; `tools/verify.js` checks the result.

## Data sources

- Postcode and municipality boundaries — [OpenDataSoft / bpost & Statbel](https://public.opendatasoft.com/explore/dataset/georef-belgium-postal-codes/)
- Village names — [GeoNames](https://www.geonames.org/) (CC BY 4.0)
- Map tiles — [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
