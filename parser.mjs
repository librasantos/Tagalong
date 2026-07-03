// ============================================================================
// Freebie Square — AI deal parser
// ----------------------------------------------------------------------------
// Idea 1: harvest sources that already did the human verification.
// Idea 2: don't scrape with brittle selectors — hand the page text to Claude
//         and let it READ the deals into structured JSON. Survives redesigns.
//
// Run this on a schedule (Vercel Cron or a GitHub Action, weekly is plenty).
// It writes public/deals.json, which the app reads. No manual upkeep.
//
// Setup:
//   1. npm i           (only needs Node 18+ for built-in fetch)
//   2. set env var ANTHROPIC_API_KEY
//   3. node parser.mjs
// ============================================================================

import fs from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
// Set this to the current Sonnet string from docs.claude.com. Sonnet is the
// right tier here: strong reading, cheap enough to run weekly across sources.
const MODEL = "claude-sonnet-5";

// BLOCKLIST: names to always drop from scraped results, even if a source
// lists them. Add anything you don't want to appear. Case-insensitive.
const BLOCKLIST = [
  "spaghettini pizza trattoria",
];

// Franklin Square is central-west Nassau. Keep deals in/near these towns.
const TARGET_AREA =
  "Franklin Square, Garden City, West Hempstead, Elmont, Mineola, Levittown, " +
  "Bellmore, Malverne, Valley Stream, Hempstead, East Meadow, New Hyde Park, " +
  "Uniondale, Westbury (all in Nassau County, NY). Reject anything clearly far " +
  "(Suffolk County, the Hamptons, NYC boroughs, upstate).";

// Curated sources. These are content pages that already verify deals — not
// bot-walled restaurant sites. Add or drop URLs here; that's the only upkeep.
const SOURCES = [
  { url: "https://mommypoppins.com/newyorkcitykids/where-kids-can-eat-free", type: "food" },
  { url: "https://www.longisland.com/articles/08-28-24/long-islands-best-kid-friendly-dining-where-kids-eat-free.html", type: "food" },
  { url: "https://www.iloveny.com/blog/post/kids-eat-free-deals-new-york-state/", type: "food" },
  { url: "https://www.njfamily.com/places-kids-eat-free-in-nj/", type: "food" },
  // Events feed (library storytimes, museum days, free community stuff):
  { url: "https://mommypoppins.com/long-island-kids", type: "events" },
];

// PINNED: hand-verified local spots that ALWAYS appear, no matter what the
// weekly scrape returns. This is your safety net — add a deal here once you've
// confirmed it in person and it will never get dropped by a refresh.
const PINNED = [
  { type:"food", name:"Moe's Southwest Grill", deal:"Kids eat free with an adult meal, all day",
    day:0, start:"", end:"", loc:"Nassau County locations", note:"Most Nassau/Suffolk Moe's. Dine-in.", conf:true },
  { type:"food", name:"Tap Room", deal:"Kids 12 & under free with a $15+ food item, all day",
    day:2, start:"", end:"", loc:"Garden City (9 LI locations)", note:"Limit two kids per table.", conf:true },
  { type:"food", name:"Miller's Ale House", deal:"Kids eat free with a $10 purchase",
    day:2, start:"", end:"", loc:"Levittown", note:"Limit two kids per adult.", conf:true },
  { type:"food", name:"IKEA Restaurant", deal:"Kids eat free Wednesdays: 2 kids' meals with an adult entrée",
    day:3, start:"", end:"", loc:"Broadway Mall, Hicksville",
    url:"https://www.ikea.com/us/en/offers/family-offers/",
    note:"Requires a free IKEA Family membership. Ages 12 & under. In the in-store Swedish Restaurant.", conf:true },
  { type:"event", name:"Rath Park", deal:"Playground, wading pool & sports fields",
    day:"varies", start:"", end:"", loc:"849 Fenworth Blvd, Franklin Square",
    note:"Town of Hempstead park. Seasonal wading pool. District residency may apply.", conf:true },
  { type:"event", name:"Kids Bowl Free", deal:"2 free bowling games every day, all summer",
    day:"varies", start:"", end:"", loc:"Register for your local center (zip 11010)",
    url:"https://www.kidsbowlfree.com/",
    note:"Sign up once at kidsbowlfree.com. Most centers Mon–Sat, ~May to Sept. Ages vary (often up to 15). Shoe rental not included.", conf:true },
  { type:"event", name:"Free Summer Meals", deal:"Free breakfast & lunch for all kids 18 & under, all summer",
    day:"varies", start:"", end:"", loc:"Find your nearest site (zip 11010)",
    url:"https://www.fna.usda.gov/sfsp/sitefinder",
    note:"USDA program, run on Long Island by Island Harvest. No sign-up, ID, or income check. Runs through early Sept. Enter your zip to find a nearby park, library, or school site.", conf:true },
];

// ---------------------------------------------------------------------------
// 1. Fetch a page and reduce it to readable text (cheap HTML strip).
// ---------------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (FreebieSquare/1.0; local parents' guide)" },
  });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 45000); // keep the request lean
}

// ---------------------------------------------------------------------------
// 2. The heart: let Claude read the page into structured deals.
// ---------------------------------------------------------------------------
function extractionPrompt(pageText, type) {
  const kind =
    type === "events"
      ? "free or low-cost kids/family EVENTS (library storytimes, museum free days, community festivals, movie nights)"
      : "restaurant KIDS-EAT-FREE or deeply discounted kids-meal deals";

  return `You are reading a parenting webpage. Pull out every ${kind}.

Return ONLY a JSON array. No prose, no markdown fences. Each object:
{
  "type": "${type === "events" ? "event" : "food"}",
  "name": "place or event name",
  "deal": "one short line: what's free and any key condition (e.g. 'Kids free with $15+ purchase, limit 2')",
  "day": 0-6 for a fixed weekday (0=Sunday ... 6=Saturday), or "varies" if it changes or isn't stated,
  "start": "HH:MM 24h if a start time is given, else ''",
  "end": "HH:MM 24h if an end time is given, else ''",
  "loc": "town or address if given",
  "note": "age limit, dine-in only, 'call to confirm', etc. Keep it short.",
  "conf": true if this page states it verified/confirmed the deal, otherwise false
}

Rules:
- ONLY include items in or near: ${TARGET_AREA}
- If a chain lists many locations, keep it once and put the nearest relevant town in "loc".
- "all day" means no start/end time — leave them "".
- Paraphrase. Do not copy sentences from the page.
- If nothing qualifies, return [].

PAGE TEXT:
${pageText}`;
}

async function extract(pageText, type) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: extractionPrompt(pageText, type) }],
    }),
  });
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    console.warn("Could not parse model output; skipping this source.");
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3. Normalize, tag, dedupe.
// ---------------------------------------------------------------------------
function keyOf(d) {
  return (d.name || "").toLowerCase().trim() + "|" + d.day + "|" + d.type;
}

function normalize(list, sourceUrl) {
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  return (list || []).map((d) => ({
    id: "auto-" + keyOf(d).replace(/[^a-z0-9]+/g, "-").slice(0, 40),
    type: d.type === "event" ? "event" : "food",
    name: (d.name || "").trim(),
    deal: (d.deal || "").trim(),
    day: d.day === "varies" ? "varies" : Number(d.day),
    start: d.start || "",
    end: d.end || "",
    loc: (d.loc || "").trim(),
    note: (d.note || "").trim(),
    url: (d.url || "").trim(),
    conf: !!d.conf,
    src: host,
    lastChecked: new Date().toISOString().slice(0, 10),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");
  const merged = new Map();

  // Pinned deals go in first and are protected from being overwritten.
  for (const d of normalize(PINNED, "https://tagalong.local")) {
    d.src = "verified locally";
    merged.set(keyOf(d), d);
  }
  const pinnedKeys = new Set(merged.keys());

  for (const s of SOURCES) {
    try {
      console.log("Reading", s.url);
      const text = await fetchText(s.url);
      const raw = await extract(text, s.type);
      for (const d of normalize(raw, s.url)) {
        if (!d.name || !d.deal) continue;
        if (BLOCKLIST.includes(d.name.toLowerCase().trim())) continue; // dropped on purpose
        if (pinnedKeys.has(keyOf(d))) continue; // never override a pinned deal
        // First verified source wins; otherwise keep what we have.
        const existing = merged.get(keyOf(d));
        if (!existing || (d.conf && !existing.conf)) merged.set(keyOf(d), d);
      }
    } catch (e) {
      console.warn("Source failed (kept previous data):", s.url, e.message);
    }
  }

  const deals = [...merged.values()].sort((a, b) => {
    const av = a.day === "varies" ? 9 : a.day;
    const bv = b.day === "varies" ? 9 : b.day;
    return av - bv;
  });

  await fs.writeFile(
    "deals.json",
    JSON.stringify({ updated: new Date().toISOString(), deals }, null, 2)
  );
  console.log(`Wrote ${deals.length} deals to deals.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
