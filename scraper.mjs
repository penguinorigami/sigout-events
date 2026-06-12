// SIGOUT daily event scraper
// ---------------------------
// Runs on GitHub Actions. Reads sources.txt, scrapes Instagram via
// Apify and websites via plain fetch, asks Claude to extract
// structured events, then writes everything to events.json.
//
// Settings you might want to change are right here at the top.

import fs from "node:fs";

// ====================== SETTINGS ======================
const IG_EVERY_N_DAYS = 2;        // Instagram runs every N days (websites run daily). Keeps Apify inside its free $5/month.
const MAX_POSTS_PER_ACCOUNT = 5;  // How many recent posts to pull per Instagram account.
const MAX_SITE_CHARS = 8000;      // How much text to read from each website (keeps Claude costs tiny).
const CLAUDE_MODEL = "claude-haiku-4-5"; // Cheapest capable model for extraction.
const APIFY_ACTOR = "apify~instagram-scraper"; // Apify's official Instagram scraper.
const KEEP_UNDATED_DAYS = 21;     // Events with no detectable date are kept this many days, then dropped.
// ======================================================

const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY secret. Aborting.");
  process.exit(1);
}

// "Today" in Singapore time, as YYYY-MM-DD
const sgNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
const TODAY = sgNow.toISOString().slice(0, 10);

const summary = []; // human-readable run report
const log = (msg) => { console.log(msg); summary.push(msg); };

// ---------- 1. Read sources.txt ----------
function parseSources(text) {
  const sources = { instagram: [], aggregators: [], websites: [], webAggregators: [] };
  let section = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || /^-+$/.test(line)) continue;
    if (/^INSTAGRAM AGGREGATORS/i.test(line)) { section = "aggregators"; continue; }
    if (/^INSTAGRAM/i.test(line)) { section = "instagram"; continue; }
    if (/^WEBSITE AGGREGATORS/i.test(line)) { section = "webAggregators"; continue; }
    if (/^WEBSITES/i.test(line)) { section = "websites"; continue; }
    if (/^FACEBOOK/i.test(line)) { section = null; continue; }
    const match = line.match(/https?:\/\/[^\s\)\]]+/);
    if (match && section) {
      // strip tracking junk like ?hl=en from Instagram links
      let url = match[0];
      if (section === "instagram" || section === "aggregators") url = url.split("?")[0];
      sources[section].push(url);
    }
  }
  return sources;
}

// e.g. https://www.instagram.com/weekendculturesg/ -> "weekendculturesg"
function handleFromUrl(url) {
  return url.replace(/\/+$/, "").split("/").pop().toLowerCase();
}

// ---------- 2. Instagram via Apify ----------
async function scrapeInstagram(urls, aggregatorHandles) {
  if (!APIFY_TOKEN) { log("Instagram: skipped (no APIFY_TOKEN secret set)."); return []; }

  // Only run Instagram every N days to stay inside Apify free credits
  const dayOfYear = Math.floor((sgNow - new Date(Date.UTC(sgNow.getUTCFullYear(), 0, 0))) / 86400000);
  if (dayOfYear % IG_EVERY_N_DAYS !== 0) {
    log(`Instagram: skipped today (runs every ${IG_EVERY_N_DAYS} days to stay inside Apify free credits).`);
    return [];
  }

  log(`Instagram: starting Apify run for ${urls.length} accounts...`);
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directUrls: urls,
        resultsType: "posts",
        resultsLimit: MAX_POSTS_PER_ACCOUNT,
        addParentData: false,
      }),
    }
  );
  if (!startRes.ok) {
    log(`Instagram: Apify refused to start the run (HTTP ${startRes.status}). Check your Apify token and plan limits.`);
    return [];
  }
  const run = (await startRes.json()).data;

  // Wait for the run to finish (check every 20s, give up after 25 min)
  let status = run.status, datasetId = run.defaultDatasetId;
  for (let i = 0; i < 75 && ["READY", "RUNNING"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 20000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_TOKEN}`);
    const data = (await poll.json()).data;
    status = data.status;
    datasetId = data.defaultDatasetId;
  }
  if (status !== "SUCCEEDED") {
    log(`Instagram: Apify run ended with status ${status}. Skipping Instagram this time.`);
    return [];
  }

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
  const items = await itemsRes.json();
  const posts = (Array.isArray(items) ? items : [])
    .filter((p) => p.caption)
    .map((p) => {
      const account = p.ownerUsername || "unknown";
      return {
        account,
        isAggregator: aggregatorHandles.has(account.toLowerCase()),
        caption: String(p.caption).slice(0, 1500),
        url: p.url || "",
        posted: p.timestamp || "",
      };
    });
  log(`Instagram: got ${posts.length} posts from Apify.`);
  return posts;
}

// ---------- 3. Websites via plain fetch ----------
function htmlToText(html, baseUrl) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // keep links: <a href="/x">Jazz Night</a> becomes "Jazz Night (https://site.com/x)"
    .replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      let abs = href;
      try { abs = new URL(href, baseUrl).href; } catch { /* keep as-is */ }
      return text ? ` ${text} (${abs}) ` : " ";
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&quot;|&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSite(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; sigout-events/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { url, text: "", note: `HTTP ${res.status}` };
    const text = htmlToText(await res.text(), url).slice(0, MAX_SITE_CHARS);
    return { url, text, note: text.length < 300 ? "very little text (site may need JavaScript)" : "ok" };
  } catch (e) {
    return { url, text: "", note: `failed (${e.name})` };
  }
}

// ---------- 4. Ask Claude to extract events ----------
async function claudeExtract(label, content) {
  const system = `Today is ${TODAY} (Singapore). You extract upcoming public events in Singapore from scraped text.
Return ONLY a JSON array, no other text, no markdown fences. Each item:
{"title": string, "date": "YYYY-MM-DD" or null, "time": string or null, "venue": string or null, "url": string or null, "description": string (max 160 chars), "source": string}
Rules: skip events that already happened before ${TODAY}; skip giveaways, product promos, hiring posts and anything that is not an attendable event; resolve relative dates like "this Saturday" using today's date; if no events are found return [].
Attribution rule: some content is marked AGGREGATOR. Aggregators collate events organised by others. For events found in aggregator content, identify the ORIGINAL organiser (an @mention, a named organiser or venue, or a link next to the event). Set "source" to the original organiser's name or handle, and "url" to the organiser's or event's own page (their Instagram profile, their website, or the event's direct ticketing/listing link). Never use the aggregator account, the aggregator website, or any of its pages as the source or url. If the original organiser cannot be identified, set source and url to null.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: `Source: ${label}\n\n${content}` }],
      }),
    });
    if (!res.ok) {
      log(`Claude: API error ${res.status} while processing ${label}.`);
      return [];
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    log(`Claude: could not parse events for ${label} (${e.message}).`);
    return [];
  }
}

// ---------- 5. Merge, dedupe, save ----------
function dedupeKey(ev) {
  const t = String(ev.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${t}|${ev.date || ""}`;
}

async function main() {
  const sources = parseSources(fs.readFileSync("sources.txt", "utf8"));
  const igUrls = [...sources.instagram, ...sources.aggregators];
  const aggregatorHandles = new Set(sources.aggregators.map(handleFromUrl));
  log(`Sources: ${igUrls.length} Instagram accounts (${sources.aggregators.length} aggregators), ${sources.websites.length + sources.webAggregators.length} websites (${sources.webAggregators.length} aggregators).`);

  const newEvents = [];

  // Instagram
  const posts = await scrapeInstagram(igUrls, aggregatorHandles);
  for (let i = 0; i < posts.length; i += 15) {
    const chunk = posts.slice(i, i + 15);
    const content = chunk
      .map((p) =>
        p.isAggregator
          ? `[@${p.account} — AGGREGATOR: credit the original organiser, never this account]\n${p.caption}`
          : `[@${p.account}] (${p.url})\n${p.caption}`
      )
      .join("\n\n---\n\n");
    const events = await claudeExtract("Instagram posts", content);
    for (const ev of events) newEvents.push(ev);
  }

  // Websites (regular + aggregators)
  let okCount = 0, emptyCount = 0;
  const allSites = [
    ...sources.websites.map((url) => ({ url, isAggregator: false })),
    ...sources.webAggregators.map((url) => ({ url, isAggregator: true })),
  ];
  for (const { url, isAggregator } of allSites) {
    const site = await fetchSite(url);
    if (!site.text) {
      emptyCount++;
      log(`  EMPTY  ${url}  (${site.note})`);
      continue;
    }
    okCount++;
    const label = isAggregator
      ? `${url} — AGGREGATOR WEBSITE: credit the original organiser of each event, never this website`
      : url;
    const events = await claudeExtract(label, site.text);
    for (const ev of events) {
      // for regular sites, fall back to the site itself as source; for aggregators, never
      newEvents.push(isAggregator ? ev : { ...ev, source: ev.source || url });
    }
    if (site.note !== "ok") log(`  NOTE   ${url}  (${site.note})`);
  }
  log(`Websites: ${okCount} fetched, ${emptyCount} returned nothing.`);

  // Load existing events and merge
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync("events.json", "utf8")).events || []; } catch { /* first run */ }

  const merged = new Map();
  for (const ev of existing) merged.set(dedupeKey(ev), ev);
  for (const ev of newEvents) {
    if (!ev.title) continue;
    const key = dedupeKey(ev);
    merged.set(key, { ...merged.get(key), ...ev, firstSeen: merged.get(key)?.firstSeen || TODAY });
  }

  // Drop past events, and undated events that have lingered too long
  const cutoffUndated = new Date(sgNow - KEEP_UNDATED_DAYS * 86400000).toISOString().slice(0, 10);
  const finalEvents = [...merged.values()].filter((ev) => {
    if (ev.date) return ev.date >= TODAY;
    return (ev.firstSeen || TODAY) >= cutoffUndated;
  });

  // Sort: dated events first (soonest first), undated last
  finalEvents.sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  fs.writeFileSync(
    "events.json",
    JSON.stringify({ lastUpdated: new Date().toISOString(), totalEvents: finalEvents.length, events: finalEvents }, null, 2)
  );

  log(`Done. ${newEvents.length} events found this run, ${finalEvents.length} total upcoming events saved.`);
}

main().catch((e) => { console.error("Run failed:", e); process.exit(1); });
