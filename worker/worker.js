/**
 * Kamloops bus positions — Cloudflare Worker
 *
 * Why this exists: BC Transit's GTFS-Realtime feed is (a) served without CORS
 * headers, so browser JS cannot read it, and (b) protobuf-encoded, not JSON.
 * This Worker fetches it server-side (no CORS restriction), decodes it, and
 * re-serves it as JSON with permissive CORS + a short cache.
 *
 * Zero dependencies: the protobuf reader below is hand-rolled against the
 * GTFS-Realtime wire format, so this file can be pasted straight into the
 * Cloudflare dashboard editor with no build step.
 *
 * Deploy:  npx wrangler deploy      (or paste into dash.cloudflare.com)
 * Test:    curl https://<your-worker>.workers.dev/
 */

const FEED = "https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=46";
const CACHE_SECONDS = 15;      // one upstream fetch serves all viewers for 15s
const UPSTREAM_TIMEOUT_MS = 8000;

/* ---------------- minimal protobuf reader ---------------- */
// Wire types: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32

function makeReader(bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function varint(p){
    let result = 0, shift = 0, byte;
    do {
      if(p >= bytes.length) throw new Error("truncated varint");
      byte = bytes[p++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while(byte & 0x80);
    return [result, p];
  }
  // iterate the fields inside [start,end)
  function* fields(start, end){
    let p = start;
    while(p < end){
      let key; [key, p] = varint(p);
      const f = key >>> 3, wt = key & 7;
      if(wt === 0){ let v; [v, p] = varint(p); yield {f, wt, v}; }
      else if(wt === 2){ let n; [n, p] = varint(p); yield {f, wt, s:p, e:p+n}; p += n; }
      else if(wt === 5){ yield {f, wt, v: dv.getFloat32(p, true)}; p += 4; }
      else if(wt === 1){ yield {f, wt, v: dv.getFloat64(p, true)}; p += 8; }
      else return;  // unknown wire type: stop rather than misparse
    }
  }
  const dec = new TextDecoder();
  const str = (s, e) => dec.decode(bytes.subarray(s, e));
  return {fields, str};
}

/**
 * Decode a GTFS-Realtime FeedMessage into plain vehicle objects.
 * FeedMessage.entity = 2 -> FeedEntity.vehicle = 4 -> VehiclePosition:
 *   1 trip {1 trip_id, 5 route_id, 6 direction_id}
 *   2 position {1 lat, 2 lon, 3 bearing, 5 speed}
 *   4 stop_id   5 timestamp   8 vehicle {1 id, 2 label}
 */
export function decodeFeed(bytes){
  const {fields, str} = makeReader(bytes);
  const out = [];
  for(const ent of fields(0, bytes.length)){
    if(ent.f !== 2 || ent.wt !== 2) continue;          // entity
    const e = {};
    for(const g of fields(ent.s, ent.e)){
      if(g.f === 1 && g.wt === 2) e.id = str(g.s, g.e);
      if(g.f !== 4 || g.wt !== 2) continue;            // vehicle position
      for(const h of fields(g.s, g.e)){
        if(h.f === 1 && h.wt === 2){                   // trip
          for(const i of fields(h.s, h.e)){
            if(i.f === 1 && i.wt === 2) e.trip  = str(i.s, i.e);
            if(i.f === 5 && i.wt === 2) e.route = str(i.s, i.e);
            if(i.f === 6 && i.wt === 0) e.dir   = i.v;
          }
        } else if(h.f === 2 && h.wt === 2){            // position
          for(const i of fields(h.s, h.e)){
            if(i.f === 1 && i.wt === 5) e.lat     = i.v;
            if(i.f === 2 && i.wt === 5) e.lon     = i.v;
            if(i.f === 3 && i.wt === 5) e.bearing = i.v;
            if(i.f === 5 && i.wt === 5) e.speed   = i.v;   // m/s
          }
        } else if(h.f === 8 && h.wt === 2){            // vehicle descriptor
          for(const i of fields(h.s, h.e)){
            if(i.f === 1 && i.wt === 2) e.vehicle = str(i.s, i.e);
          }
        } else if(h.f === 5 && h.wt === 0){ e.ts   = h.v; }
        else if(h.f === 4 && h.wt === 2){ e.stop = str(h.s, h.e); }
      }
    }
    if(typeof e.lat === "number" && typeof e.lon === "number") out.push(e);
  }
  return out;
}

/* ---------------- worker ---------------- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status, extra){
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      ...(extra || {}),
    },
  });
}

export default {
  async fetch(request, env, ctx){
    if(request.method === "OPTIONS") return new Response(null, {headers: CORS});
    if(request.method !== "GET" && request.method !== "HEAD")
      return json({error: "method not allowed"}, 405);

    // edge cache: many viewers -> one upstream fetch per CACHE_SECONDS
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + "/__buses", {method: "GET"});
    const hit = await cache.match(cacheKey);
    if(hit) return hit;

    try{
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream;
      try{
        upstream = await fetch(FEED, {
          signal: ctrl.signal,
          headers: {"User-Agent": "kamloops-dashboard (personal use)"},
          cf: {cacheTtl: CACHE_SECONDS, cacheEverything: true},
        });
      } finally { clearTimeout(timer); }

      if(!upstream.ok) return json({error: `upstream ${upstream.status}`}, 502);

      const bytes = new Uint8Array(await upstream.arrayBuffer());
      const vehicles = decodeFeed(bytes);
      const newest = vehicles.reduce((m, v) => Math.max(m, v.ts || 0), 0);

      const res = json({
        updated: Math.floor(Date.now() / 1000),
        feed_time: newest || null,
        count: vehicles.length,
        routes: [...new Set(vehicles.map(v => v.route).filter(Boolean))].sort(),
        vehicles,
      }, 200);

      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }catch(err){
      const msg = (err && err.name === "AbortError") ? "upstream timeout" : String(err && err.message || err);
      return json({error: msg}, 502);
    }
  },
};
