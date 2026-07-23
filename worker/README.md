# Kamloops bus positions — Cloudflare Worker

Serves BC Transit's live Kamloops vehicle positions as JSON with CORS headers.

## Why it's needed

The upstream feed can't be used directly from a static page:

1. **No CORS headers** — browser JS is blocked from reading the response.
2. **Protobuf, not JSON** — it's GTFS-Realtime binary.

This Worker fetches it server-side (where CORS doesn't apply), decodes it, and
re-serves JSON. It has **no dependencies** — the protobuf reader is hand-rolled —
so you can also just paste `worker.js` into the Cloudflare dashboard editor.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Wrangler prints a URL like `https://kamloops-buses.<subdomain>.workers.dev`.

Then open `index.html`, find this line near the top of the `<script>`, and paste
your URL in:

```js
const BUS_API = "";   // -> "https://kamloops-buses.<subdomain>.workers.dev/"
```

Commit and push. The Transit card lights up and becomes clickable.

## Verify

```bash
curl https://kamloops-buses.<subdomain>.workers.dev/ | head -c 400
```

Expect `{"updated":...,"feed_time":...,"count":34,"routes":["1-KAM",...],"vehicles":[...]}`.

## Response shape

| Field | Meaning |
|---|---|
| `updated` | Unix seconds when the Worker built this response |
| `feed_time` | Newest GPS fix in the batch (Unix seconds) |
| `count` | Number of vehicles in service |
| `routes` | Distinct route ids, e.g. `9-KAM` |
| `vehicles[]` | `route`, `lat`, `lon`, `bearing`, `speed` (m/s), `vehicle`, `trip`, `stop`, `ts`, `dir` |

## Notes

- **Caching**: responses are cached at the edge for `CACHE_SECONDS` (15s), so a
  hundred viewers still cost one upstream fetch. Raise it to be gentler on
  BC Transit; lower it for fresher data.
- **Service hours**: outside operating hours the feed legitimately returns 0
  vehicles. That's not a bug.
- **Terms**: BC Transit publishes this free and as-is, and asks that you respect
  their Terms of Use. The 15s cache keeps request volume low.
- **Cost**: comfortably inside the Workers free tier (100k requests/day).
