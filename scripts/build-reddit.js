/**
 * Build reddit.json from r/Kamloops' public RSS feed.
 *
 * Reddit blocks CORS and its old .json endpoints return 403 to non-browsers,
 * but the RSS feed still serves cleanly server-side. This runs in GitHub
 * Actions (whose IPs Reddit is far less likely to block than a datacenter
 * proxy's) on a schedule and commits the result, which the dashboard then
 * reads same-origin — no CORS, no live backend.
 *
 * Usage:
 *   node scripts/build-reddit.js              # fetch live, write reddit.json
 *   node scripts/build-reddit.js feed.rss     # parse a local file (testing)
 *
 * Zero dependencies. Node 18+ (global fetch).
 */
const fs = require("fs");

const SUB = "Kamloops";
const SORT = "hot";                 // "hot" = what the community is engaging with
const LIMIT = 15;
const OUT = "reddit.json";
const FEED = `https://www.reddit.com/r/${SUB}/${SORT}.rss?limit=${LIMIT}`;
// Reddit asks for a descriptive, unique User-Agent. Generic bot UAs get 403.
const UA = "github-actions:kamloops-dashboard:1.1 (community feed, read-only)";

const decode = s => String(s || "")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");            // amp last, so we don't double-decode

const tag = (s, t) => {
  const m = s.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + t + ">"));
  return m ? m[1] : null;
};

function parse(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  return entries.map(e => {
    const link = e.match(/<link[^>]*href="([^"]+)"/);
    return {
      title:     decode(tag(e, "title") || "").trim(),
      author:    (tag(e, "name") || "").replace(/^\/u\//, ""),   // "/u/x" -> "x"
      url:       link ? link[1] : null,
      id:        tag(e, "id"),
      published: tag(e, "published") || tag(e, "updated") || null,
    };
  }).filter(p => p.title && p.url);
}

async function main() {
  const localFile = process.argv[2];
  let xml;
  if (localFile) {
    xml = fs.readFileSync(localFile, "utf8");
  } else {
    const r = await fetch(FEED, { headers: { "User-Agent": UA, "Accept": "application/atom+xml" } });
    if (!r.ok) {
      // Fail loudly so a Reddit block is visible in the Actions log, and leave
      // the previously-committed reddit.json untouched rather than clobbering it.
      console.error(`Reddit returned HTTP ${r.status}. Feed NOT updated.`);
      process.exit(1);
    }
    xml = await r.text();
  }

  const posts = parse(xml);
  if (!posts.length) {
    console.error("Parsed 0 posts — refusing to overwrite with an empty feed.");
    process.exit(1);
  }

  const out = {
    generated: new Date().toISOString(),
    subreddit: SUB,
    sort: SORT,
    url: `https://www.reddit.com/r/${SUB}/`,
    posts,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: ${posts.length} posts from r/${SUB}/${SORT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
