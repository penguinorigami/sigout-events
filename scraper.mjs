// SIGOUT daily event scraper
// ---------------------------
// Runs on GitHub Actions. Reads sources.txt, scrapes Instagram via
// Apify and websites via plain fetch, asks Claude to extract
// structured events, then writes everything to events.json.
//
// Settings you might want to change are right here at the top.

import fs from "node:fs";

// ====================== SETTINGS ======================
const IG_EVERY_N_DAYS = 1;        // Instagram runs on every scheduled run (now Mon & Fri).
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
{"title": string, "category": one of ["festival","exhibition","music","workshop","market","theatre","event"], "date": "YYYY-MM-DD" or null, "endDate": "YYYY-MM-DD" or null, "time": string or null, "venue": string or null, "url": string or null, "description": string (max 160 chars), "source": string}
Category guide: festival = multi-day or large-scale celebrations; exhibition = gallery/museum shows on view over a period; music = gigs, raves, DJ sets, concerts; workshop = hands-on classes you sign up for (craft, flowers, sound baths); market = fairs, flea/pop-up/vintage/craft markets; theatre = staged plays and dance; event = anything else attendable (talks, book clubs, meetups, gatherings). Pick the single best fit; use "event" only when none of the others clearly apply.
Use "date" for the start day and "endDate" for the last day of multi-day events; set endDate to null for single-day events.
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

  // ----- Curation flow: three files -----
  // pending.json  = newly scraped, waiting for Jane's review (site never shows these)
  // events.json   = approved events, what sigout displays (Jane's edits always win)
  // rejected.json = keys of events Jane said no to (never resurface)

  const readJson = (path, fallback) => {
    try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
  };
  const approved = readJson("events.json", { events: [] }).events || [];
  const pending = readJson("pending.json", { events: [] }).events || [];
  const rejectedKeys = new Set(readJson("rejected.json", { keys: [] }).keys || []);

  const eventKey = (ev) => ev.key || dedupeKey(ev);

  // Every key the robot has already seen a decision (or non-decision) on
  const knownKeys = new Set([
    ...approved.map(eventKey),
    ...pending.map(eventKey),
    ...rejectedKeys,
  ]);

  // Only genuinely new events go to pending
  let addedCount = 0;
  for (const ev of newEvents) {
    if (!ev.title) continue;
    const key = dedupeKey(ev);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    pending.push({ ...ev, key, firstSeen: TODAY });
    addedCount++;
  }

  // Housekeeping: drop past events everywhere, and stale undated pending events.
  // An event counts as past only once its LAST day (endDate, else date) is before today.
  const cutoffUndated = new Date(sgNow - KEEP_UNDATED_DAYS * 86400000).toISOString().slice(0, 10);
  const lastDay = (ev) => ev.endDate || ev.date;
  const notPast = (ev) => !lastDay(ev) || lastDay(ev) >= TODAY;
  const freshPending = pending.filter((ev) =>
    lastDay(ev) ? lastDay(ev) >= TODAY : (ev.firstSeen || TODAY) >= cutoffUndated
  );
  const liveApproved = approved.filter(notPast);

  // Sort: dated events first (soonest first), undated last
  const byDate = (a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  };
  freshPending.sort(byDate);
  liveApproved.sort(byDate);

  fs.writeFileSync(
    "pending.json",
    JSON.stringify({ lastUpdated: new Date().toISOString(), count: freshPending.length, events: freshPending }, null, 2)
  );
  fs.writeFileSync(
    "events.json",
    JSON.stringify({ lastUpdated: new Date().toISOString(), totalEvents: liveApproved.length, events: liveApproved }, null, 2)
  );
  if (!fs.existsSync("rejected.json")) {
    fs.writeFileSync("rejected.json", JSON.stringify({ keys: [] }, null, 2));
  }

  log(`Done. ${newEvents.length} events found this run, ${addedCount} new ones added for review. Now: ${freshPending.length} pending, ${liveApproved.length} live on sigout.`);

  // ---------- 6. Hand off to the curator ----------
  // curate.mjs judges everything pending against taste.md and publishes /
  // rejects / holds (shadow switch lives in curator-config.json). It runs as
  // a separate process so a curator failure can never lose the scrape.
  if (fs.existsSync("curate.mjs")) {
    const { spawnSync } = await import("node:child_process");
    log("Handing off to the curator (curate.mjs)…");
    const run = spawnSync("node", ["curate.mjs"], { stdio: "inherit" });
    if (run.status !== 0) log(`Curator exited with status ${run.status} — scrape results are kept regardless.`);
  }
}

main().catch((e) => { console.error("Run failed:", e); process.exit(1); });
