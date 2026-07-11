// SIGOUT auto-curator
// -------------------
// Runs on GitHub Actions right after scraper.mjs. Reads taste.md and asks
// Claude to judge every pending event: publish / reject / unsure. Publishes
// straight to events.json (what sigout displays), records every decision with
// its reason in decisions.json, and writes a human-readable curator-report.md.
//
// Jane stays in charge two ways:
//   · edit taste.md — the next run obeys it
//   · /curate on the site — remove a miss or rescue a hold; her edits always win
//
// SHADOW MODE: while shadow is on, the curator only writes decisions.json +
// curator-report.md and leaves pending/events/rejected untouched. It's set in
// curator-config.json ({"shadow": true/false}); a CURATE_SHADOW env var
// overrides it. Missing config = shadow, so the safe mode is the default.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

// ====================== SETTINGS ======================
const CLAUDE_MODEL = "claude-sonnet-5"; // judgment work — worth more than Haiku
const BATCH_SIZE = 20;                  // events judged per API call
const MAX_PUBLISH_PER_RUN = 25;         // flood guard; extras stay pending for next run
const DECISIONS_KEEP = 800;             // decisions.json keeps this many recent entries
// ======================================================

function shadowMode() {
  if (process.env.CURATE_SHADOW) return process.env.CURATE_SHADOW !== "false";
  try { return JSON.parse(fs.readFileSync("curator-config.json", "utf8")).shadow !== false; }
  catch { return true; } // no config → shadow: safe by default
}
const SHADOW = shadowMode();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const sgNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
const TODAY = sgNow.toISOString().slice(0, 10);

const log = (msg) => console.log(msg);
const readJson = (path, fallback) => {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
};

// same key recipe as the scraper and the curate page — do not change one alone
function dedupeKey(ev) {
  const t = String(ev.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${t}|${ev.date || ""}`;
}
const eventKey = (ev) => ev.key || dedupeKey(ev);

// ---------- duplicate collapse ----------
// The scraper's key is title|date, so the same event re-scraped with a
// slightly different title or date slips through as "new". Collapse those
// here: similar titles + compatible dates = one event. Keep the fullest copy.
const normTitle = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const titleWords = (t) => new Set(normTitle(t).split(" ").filter((w) => w.length > 2));

function similarTitles(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = titleWords(a), wb = titleWords(b);
  if (!wa.size || !wb.size) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.7;
}

function datesCompatible(a, b) {
  if ((!a.date && !a.endDate) || (!b.date && !b.endDate)) return true; // undated matches anything similar
  const s1 = a.date || a.endDate, e1 = a.endDate || a.date;
  const s2 = b.date || b.endDate, e2 = b.endDate || b.date;
  return s1 <= e2 && s2 <= e1; // overlapping runs
}

const fullness = (ev) =>
  ["date", "endDate", "time", "venue", "url", "description", "source"].filter((f) => ev[f]).length;

// Collapse pending against itself and against already-published events.
// Returns { survivors, duplicates: [{event, of}] }.
function collapse(pending, approved) {
  const survivors = [];
  const duplicates = [];
  const isDup = (ev, other) => similarTitles(ev.title, other.title) && datesCompatible(ev, other);
  for (const ev of pending) {
    const twin = approved.find((a) => isDup(ev, a));
    if (twin) { duplicates.push({ event: ev, of: `already published: ${twin.title}` }); continue; }
    const prior = survivors.find((s) => isDup(ev, s));
    if (!prior) { survivors.push(ev); continue; }
    if (fullness(ev) > fullness(prior)) {
      duplicates.push({ event: prior, of: ev.title });
      survivors[survivors.indexOf(prior)] = ev;
    } else {
      duplicates.push({ event: ev, of: prior.title });
    }
  }
  return { survivors, duplicates };
}

// ---------- ask Claude to judge a batch ----------
async function judgeBatch(taste, batch, approvedTitles) {
  const system = `You are the curator for sigout, a personal taste-driven Singapore events site.
Judge each event below against the taste profile. Return ONLY a JSON array, no other text, no markdown fences:
[{"i": <index>, "verdict": "publish" | "reject" | "unsure", "reason": "<one short sentence>", "confidence": <0..1>}]
Rules: follow the taste profile exactly, including its posture section. One entry per input index. The reason should say which taste rule drove the verdict.
Already published on sigout — reject anything that is a variant, single session, or per-location instance of these (reason: "covered by published card"):
${approvedTitles.map((t) => `- ${t}`).join("\n") || "- (nothing published yet)"}

TASTE PROFILE
=============
${taste}`;

  const payload = batch.map((ev, i) => ({
    i,
    title: ev.title,
    category: ev.category,
    date: ev.date,
    endDate: ev.endDate,
    venue: ev.venue,
    description: ev.description,
    source: ev.source,
    url: ev.url,
  }));

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
      messages: [{ role: "user", content: JSON.stringify(payload, null, 1) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (!Array.isArray(parsed)) throw new Error("Claude did not return an array");

  // one verdict per event; anything malformed or missing falls back to unsure
  return batch.map((ev, i) => {
    const v = parsed.find((p) => p && p.i === i) || {};
    const verdict = ["publish", "reject", "unsure"].includes(v.verdict) ? v.verdict : "unsure";
    return { verdict, reason: String(v.reason || "no reason returned"), confidence: Number(v.confidence) || 0.5 };
  });
}

// ---------- report ----------
function writeReport({ mode, published, rejected, unsure, duplicates, held }) {
  const line = (d) => `- **${d.event.title}** (${d.event.category || "?"}) — ${d.reason}`;
  const md = `# Curator report — ${TODAY} (${mode})

The most recent auto-curation run. Every decision and its reason. To change
future behaviour, edit taste.md. To overrule any single decision, use /curate.

**${published.length} published · ${rejected.length} rejected · ${unsure.length} left for Jane · ${duplicates.length} duplicates collapsed${held.length ? ` · ${held.length} held by publish cap` : ""}**

## Published to sigout
${published.map(line).join("\n") || "_none_"}

## Rejected
${rejected.map(line).join("\n") || "_none_"}

## Left in pending for Jane (unsure)
${unsure.map(line).join("\n") || "_none_"}
${held.length ? `\n## Held by the ${MAX_PUBLISH_PER_RUN}-per-run publish cap (still pending)\n${held.map(line).join("\n")}\n` : ""}
## Duplicates collapsed
${duplicates.map((d) => `- ${d.event.title} → kept: ${d.of}`).join("\n") || "_none_"}
`;
  fs.writeFileSync("curator-report.md", md);
}

// ---------- main ----------
async function main() {
  if (!fs.existsSync("taste.md")) { log("No taste.md — refusing to curate without a taste profile."); process.exit(1); }
  if (!ANTHROPIC_API_KEY) { log("Missing ANTHROPIC_API_KEY. Aborting."); process.exit(1); }
  const taste = fs.readFileSync("taste.md", "utf8");

  const pendingFile = readJson("pending.json", { events: [] });
  const eventsFile = readJson("events.json", { events: [] });
  const rejectedFile = readJson("rejected.json", { keys: [] });
  const decisionsFile = readJson("decisions.json", { decisions: [] });

  const pending = pendingFile.events || [];
  const approved = eventsFile.events || [];
  if (!pending.length) { log("Nothing pending — nothing to curate."); return; }
  log(`Curating ${pending.length} pending events (${SHADOW ? "SHADOW mode — site untouched" : "LIVE mode"})…`);

  // 1. collapse duplicates
  const { survivors, duplicates } = collapse(pending, approved);
  log(`Duplicates collapsed: ${duplicates.length}. Judging ${survivors.length} events.`);

  // 2. judge in batches
  const judged = [];
  for (let i = 0; i < survivors.length; i += BATCH_SIZE) {
    const batch = survivors.slice(i, i + BATCH_SIZE);
    const verdicts = await judgeBatch(taste, batch, approved.map((a) => a.title));
    batch.forEach((ev, j) => judged.push({ event: ev, ...verdicts[j] }));
    log(`  judged ${Math.min(i + BATCH_SIZE, survivors.length)}/${survivors.length}`);
  }

  // 3. mechanical rails
  for (const d of judged) {
    if (d.verdict === "publish" && !d.event.date && !d.event.endDate) {
      d.verdict = "unsure";
      d.reason = `no date — cannot be placed on the site (was: ${d.reason})`;
    }
  }

  // 4. publish cap: highest-confidence first, the rest stay pending
  let published = judged.filter((d) => d.verdict === "publish").sort((a, b) => b.confidence - a.confidence);
  const held = published.slice(MAX_PUBLISH_PER_RUN);
  published = published.slice(0, MAX_PUBLISH_PER_RUN);
  const rejected = judged.filter((d) => d.verdict === "reject");
  const unsure = judged.filter((d) => d.verdict === "unsure");

  // 5. decisions log — full event kept on reject/duplicate so nothing is lost
  const stamp = new Date().toISOString();
  const entries = [
    ...published.map((d) => ({ at: stamp, actor: "auto", shadow: SHADOW, verdict: "publish", key: eventKey(d.event), title: d.event.title, category: d.event.category, reason: d.reason, confidence: d.confidence })),
    ...rejected.map((d) => ({ at: stamp, actor: "auto", shadow: SHADOW, verdict: "reject", key: eventKey(d.event), title: d.event.title, category: d.event.category, reason: d.reason, confidence: d.confidence, event: d.event })),
    ...unsure.map((d) => ({ at: stamp, actor: "auto", shadow: SHADOW, verdict: "unsure", key: eventKey(d.event), title: d.event.title, category: d.event.category, reason: d.reason, confidence: d.confidence })),
    ...duplicates.map((d) => ({ at: stamp, actor: "auto", shadow: SHADOW, verdict: "duplicate", key: eventKey(d.event), title: d.event.title, category: d.event.category, reason: `duplicate of: ${d.of}`, event: d.event })),
  ];
  const allDecisions = [...(decisionsFile.decisions || []), ...entries].slice(-DECISIONS_KEEP);
  fs.writeFileSync("decisions.json", JSON.stringify({ lastRun: stamp, decisions: allDecisions }, null, 2));

  writeReport({ mode: SHADOW ? "shadow" : "live", published, rejected, unsure, duplicates, held });

  if (SHADOW) {
    log(`SHADOW: would publish ${published.length}, reject ${rejected.length}, hold ${unsure.length + held.length}. See curator-report.md.`);
    persistInActions();
    return;
  }

  // 6. LIVE — apply the decisions to the three files
  const publishedKeys = new Set(published.map((d) => eventKey(d.event)));
  const rejectedNewKeys = [...rejected, ...duplicates.map((d) => ({ event: d.event }))].map((d) => eventKey(d.event));
  const stillPending = pending.filter((ev) => {
    const k = eventKey(ev);
    return !publishedKeys.has(k) && !rejectedNewKeys.includes(k);
  });
  const newApproved = [...approved, ...published.map((d) => ({ ...d.event, key: eventKey(d.event) }))];

  const byDate = (a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : 0);
  newApproved.sort(byDate);
  stillPending.sort(byDate);

  fs.writeFileSync("events.json", JSON.stringify({ lastUpdated: stamp, totalEvents: newApproved.length, events: newApproved }, null, 2));
  fs.writeFileSync("pending.json", JSON.stringify({ lastUpdated: stamp, count: stillPending.length, events: stillPending }, null, 2));
  fs.writeFileSync("rejected.json", JSON.stringify({ keys: [...(rejectedFile.keys || []), ...rejectedNewKeys] }, null, 2));

  log(`LIVE: published ${published.length} → sigout now lists ${newApproved.length}. Rejected ${rejected.length}, collapsed ${duplicates.length} duplicates, ${stillPending.length} left pending.`);
  persistInActions();
}

// In GitHub Actions the workflow's save step only stages the scraper's three
// files, so the curator commits its own outputs too (checkout's credentials
// are already on the remote). A failed push must not fail the scrape — the
// save step still picks up events/pending/rejected.
function persistInActions() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const git = (...args) => spawnSync("git", args, { stdio: "inherit" });
  git("config", "user.name", "sigout-bot");
  git("config", "user.email", "sigout-bot@users.noreply.github.com");
  git("add", "-A");
  if (spawnSync("git", ["diff", "--cached", "--quiet"]).status !== 0) {
    git("commit", "-m", "Auto-curation");
    const push = spawnSync("git", ["push"], { stdio: "inherit" });
    if (push.status !== 0) log("Curator: push failed — the workflow's save step will still save the event files.");
  }
}

main().catch((e) => { console.error("Curator run failed:", e); process.exit(1); });
