/**
 * Build feeds.json from Kamloops RSS/Atom sources.
 *
 * Reddit blocks CORS and 403s its .json endpoints for non-browsers, and the
 * other feeds are cross-origin too — so none can be fetched from the static
 * page. This runs in GitHub Actions (whose IPs the sources rarely block),
 * parses each feed, and commits feeds.json, which the dashboard reads
 * same-origin. Read-only: every item links out to its source.
 *
 * Usage:
 *   node scripts/build-feeds.js              # fetch live, write feeds.json
 *   node scripts/build-feeds.js ./local      # parse ./local/<key>.xml (testing)
 *
 * Zero dependencies. Node 18+ (global fetch).
 */
const fs = require("fs");

const UA = "github-actions:kamloops-dashboard:1.2 (community/news feeds, read-only)";

const SOURCES = [
  { key: "reddit", label: "r/Kamloops", kind: "community", format: "atom", limit: 12,
    url: "https://www.reddit.com/r/Kamloops/hot.rss?limit=15",
    site: "https://www.reddit.com/r/Kamloops/" },
  { key: "radionl", label: "Radio NL", kind: "news", format: "rss", limit: 8,
    url: "https://www.radionl.com/feed/",
    site: "https://www.radionl.com/" },
  // BC Wildfire's feed is province-wide; keep only Kamloops-relevant bulletins.
  { key: "bcwildfire", label: "BC Wildfire", kind: "news", format: "rss", limit: 6,
    url: "https://blog.gov.bc.ca/bcwildfire/feed/",
    site: "https://blog.gov.bc.ca/bcwildfire/",
    keep: e => /kamloops/i.test(e._raw) || /\bKFC\b/.test(e._cats) },
];

const dec = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&");            // amp last

const tag = (s, t) => {
  const m = s.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">"));
  return m ? m[1] : null;
};
const iso = d => { const t = Date.parse(d || ""); return isFinite(t) ? new Date(t).toISOString() : null; };

function parseAtom(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]).map(e => {
    const link = e.match(/<link[^>]*href="([^"]+)"/);
    return {
      title:     dec(tag(e, "title") || "").trim(),
      author:    dec((tag(e, "name") || "").replace(/^\/u\//, "")) || null,
      url:       link ? link[1] : null,
      published: iso(tag(e, "published") || tag(e, "updated")),
    };
  });
}

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]).map(e => {
    const cats = [...e.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map(m => dec(m[1])).join(", ");
    return {
      title:     dec(tag(e, "title") || "").trim(),
      author:    dec(tag(e, "dc:creator") || "").trim() || null,
      url:       (tag(e, "link") || "").trim() || null,
      published: iso(tag(e, "pubDate")),
      _cats:     cats,                                   // internal, for filtering
      _raw:      (tag(e, "title") || "") + " " + (tag(e, "description") || "") + " " + cats,
    };
  });
}

function build(src, xml) {
  let items = src.format === "atom" ? parseAtom(xml) : parseRss(xml);
  if (src.keep) items = items.filter(src.keep);
  return items
    .filter(p => p.title && p.url)
    .slice(0, src.limit)
    .map(({ _cats, _raw, ...p }) => p);                  // drop internal fields
}

async function main() {
  const localDir = process.argv[2];
  const sources = {};
  const errors = [];

  for (const src of SOURCES) {
    try {
      let xml;
      if (localDir) {
        xml = fs.readFileSync(`${localDir}/${src.key}.xml`, "utf8");
      } else {
        const r = await fetch(src.url, { headers: {
          "User-Agent": UA,
          "Accept": "application/rss+xml, application/atom+xml, application/xml",
        } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        xml = await r.text();
      }
      const items = build(src, xml);
      sources[src.key] = { label: src.label, kind: src.kind, site: src.site, items };
      console.log(`${src.key}: ${items.length} items`);
    } catch (e) {
      errors.push(`${src.key}: ${e.message}`);
      console.error(`WARN ${src.key}: ${e.message}`);
    }
  }

  if (!Object.keys(sources).length) {
    console.error("All feeds failed — leaving feeds.json untouched.\n" + errors.join("\n"));
    process.exit(1);
  }

  // Preserve the last good data for any source that failed this run, so one
  // flaky feed doesn't blank a whole section.
  let prev = {};
  try { prev = (JSON.parse(fs.readFileSync("feeds.json", "utf8")).sources) || {}; } catch (e) {}
  for (const src of SOURCES) {
    if (!sources[src.key] && prev[src.key]) sources[src.key] = prev[src.key];
  }

  fs.writeFileSync("feeds.json", JSON.stringify({ generated: new Date().toISOString(), sources }));
  console.log(`Wrote feeds.json (${Object.keys(sources).length} sources)`);
}

main().catch(e => { console.error(e); process.exit(1); });
