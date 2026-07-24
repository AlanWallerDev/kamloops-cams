# Kamloops Live Dashboard

A single-page local dashboard for Kamloops, BC: **17 working traffic cameras**
streaming simultaneously, plus **9 live data panels** (weather, air quality,
alerts, wildfire, roads, river level, City EOC status, earthquakes, transit).

Everything except the bus map is plain static HTML/JS with **no backend** — one
file, no build step, no dependencies to install.

---

## Quick start

**Locally:** double-click `index.html`. That's it.

**On GitHub Pages:** push the repo, then Settings → Pages → Source =
*Deploy from a branch*, branch `main`, folder `/ (root)`.

> ⚠️ Pages serves `index.html` at a directory URL. If you rename it, the bare
> URL 404s. That's the #1 cause of a "broken" deploy here.

---

## What's on it

### Traffic cameras

18 cameras are configured: 15 live HLS video streams from the City's Wowza
server, plus 3 DriveBC snapshots that refresh every 8 seconds. One of the 15
(`Tranquille & Desmond`) is dead upstream, so **17 actually work**.

- Auto-reconnect with backoff, then a manual **Retry** button
- Click any tile (or ⤢) to expand it into a large player
- Hover a tile → **✕** hides it; hidden cameras are remembered in
  `localStorage` and restored from the **Hidden (N)** menu
- Size slider, **Pause all** (saves CPU/bandwidth), **Reload all**
- **Hide** on the "Traffic cameras" bar collapses the whole grid and stops every
  stream (not just hides them). Remembered, like the data strip.

`Tranquille & Desmond` is permanently offline upstream (its stream 404s) and is
hidden by default — use **Show offline** to reveal it.

### Status summary

A one-line, colour-coded row at the very top answering "is anything wrong right
now?" without scanning nine cards. Each feed publishes its own items:

| Source | Surfaces when |
|---|---|
| Alerts | any active ECCC warning |
| Air quality | AQI > 100 (red above 150), with a trend arrow |
| Fire | danger High/Extreme, any prohibition, a fire within 25 km |
| Roads | one or more closures |
| City EOC | any active closure or evacuation area |
| Weather | always, as a neutral temperature pill; UV only when ≥ 8 |

Shows **"All clear"** when nothing qualifies, **"Checking conditions…"** before
anything has reported, and a feed that errors drops its items rather than
leaving stale ones on screen.

### Data panels

| Panel | Shows | Refresh |
|---|---|---|
| Weather | Temp + 24h trend, conditions, wind, high/low, UV index, sunrise/sunset | 10 min |
| Air quality | US AQI + 24h trend (clearing / worsening), PM2.5, PM10 | 10 min |
| Alerts | ECCC warnings covering Kamloops (heat, smoke, wind) | 5 min |
| Wildfire | Danger rating, campfire bans, active fires within 100 km | 10 min |
| Roads | DriveBC closures/construction near Kamloops | 5 min |
| Thompson River | Level at Kamloops + trend sparkline | 5 min |
| City EOC | Road closures, detours, evacuation areas, sandbag stations | 5 min |
| Earthquakes | Recent M2+ events within 400 km | 10 min |

Alerts, Wildfire, Roads, EOC and Earthquakes are **click-to-expand** for a
detailed list. The strip collapses via **Hide** (also remembered).

### Transit

Its own section with an always-visible live map — no clicking required.

- **Buses** refresh every 20s, drawn in BC Transit's own route colours with the
  official route names (both come from the GTFS feed, not invented).
- A bus between trips reports a position with no route attached; those render
  muted and grey as "Not in service" rather than as a mystery pin.
- **575 bus stops** from `transit-static.json`, toggleable via the checkbox
  (remembered). Drawn with Leaflet's canvas renderer — as DOM nodes they'd be
  sluggish.
- Collapsing the section with **Hide** also stops polling the Worker.

---

## Data sources

All chosen because they're HTTPS, CORS-enabled, and need no API key — the
requirements for a static page.

| Source | Endpoint | Notes |
|---|---|---|
| City of Kamloops cams | `wowza-ap-pv01.kamloops.ca` | HLS via hls.js |
| DriveBC cams | `images.drivebc.ca` | Static JPEG snapshots |
| Weather / air quality | `api.open-meteo.com`, `air-quality-api.open-meteo.com` | No key |
| Alerts + river | `api.weather.gc.ca` (ECCC GeoMet) | River station `08LF023` |
| Roads | `api.open511.gov.bc.ca` | DriveBC Open511 |
| Wildfires | `services6.arcgis.com` (BCWS) | Filtered to `FIRE_STATUS<>'Out'` |
| City EOC | `maps.kamloops.ca/arcgis` | Public ArcGIS server |
| Earthquakes | `earthquake.usgs.gov` | FDSN event query |
| Buses | BC Transit GTFS-RT → your Worker | See below |
| Map tiles | OpenStreetMap | Via Leaflet |

**Deliberately not used:** ECCC's legacy `dd.weather.gc.ca` XML and
`wateroffice.ec.gc.ca` CSV are both CORS-blocked. GeoMet replaces both.

---

## The bus map (Cloudflare Worker)

Live positions are the one feature that can't be done from a static page. BC
Transit's feed is **served without CORS headers** *and* is **protobuf-encoded**,
so browser JS can neither fetch nor read it.

`worker/worker.js` solves both: it fetches the feed server-side, decodes the
protobuf, and re-serves JSON with CORS and a 15-second edge cache. It has **zero
dependencies** (the protobuf reader is hand-rolled), so it can be pasted
straight into the Cloudflare dashboard editor — no build step, no Node version
requirements.

See [`worker/README.md`](worker/README.md) for deploy instructions.

Point the dashboard at your Worker by editing this line in `index.html`:

```js
const BUS_API = "https://kamloops-buses.<subdomain>.workers.dev/";
```

Leave it as `""` to disable the panel — the card then reads "Off" instead of
erroring.

---

## Project structure

```
index.html            the entire dashboard — single source of truth
transit-static.json   575 bus stops + route names/colours (see "Regenerating")
site.webmanifest      name + icons for "Add to Home Screen"
favicon-32.png        browser tab / bookmark icon
apple-touch-icon.png  iOS bookmarks and home screen (180x180)
icon-512.png          Android home screen / install prompt
worker/
  worker.js           Cloudflare Worker: GTFS-RT -> JSON + CORS
  wrangler.toml       deploy config (optional; CLI route)
  README.md           Worker deploy + response shape
```

`index.html` is the only page — edit it directly. (The filename is required:
GitHub Pages serves `index.html` at a directory URL, so renaming it 404s the
site.)

---

## Regenerating transit-static.json

Stop locations and route names/colours change only a few times a year, so they
are baked into `transit-static.json` rather than unzipped at runtime. To refresh
after a BC Transit service change:

```bash
curl -o gtfs.zip "https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=46"
unzip -o gtfs.zip stops.txt routes.txt
```

Then rebuild the JSON as `{generated, source, routes, stops}`, where `routes`
maps `route_id -> {n, name, c, t}` (short name, long name, colour, text colour)
and `stops` is an array of `[stop_code, stop_name, lat, lon]`.

## Configuration

All near the top of the `<script>` block in `index.html`:

| What | Where |
|---|---|
| Bus Worker URL | `const BUS_API = ...` |
| Camera list | `const CAMS = [...]` — add/remove/rename tiles |
| Panel refresh rates | `const FEEDS = [...]` — the `ms` values |
| Kamloops centre point | `const KAM = {lat, lon}` — used for distances |
| Worker cache duration | `CACHE_SECONDS` in `worker/worker.js` |

---

## Troubleshooting

**A camera says "Stream unavailable"** — the City's cameras go down
periodically; the page notes several are known to have issues. Click **Retry**,
or hide the tile with ✕.

**All cameras fail at once** — check your connection, and that
`cdn.jsdelivr.net` (hls.js) isn't blocked.

**A data card says "Unavailable — will retry"** — that source is briefly down;
it retries on its normal interval. Other cards are unaffected by design.

**Transit says "Off"** — `BUS_API` is empty. **"Feed unavailable"** — the Worker
is unreachable; test it directly with
`curl https://<your-worker>.workers.dev/`.

**Empty EOC / wildfire / alerts panels** — usually correct, not broken. Those
are quiet outside an active emergency. Buses likewise stop reporting outside
service hours.

---

## Attribution

Camera feeds are the City of Kamloops' and DriveBC's. Data from Environment and
Climate Change Canada, BC Wildfire Service, DriveBC, USGS, Open-Meteo, and
BC Transit (published free and as-is — respect their Terms of Use). Map tiles
© OpenStreetMap contributors.

This is an unofficial personal viewer and is not affiliated with or endorsed by
any of the above.
