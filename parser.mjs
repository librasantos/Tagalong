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
  // Only allow Smashburger if it ever comes directly from smashburger.com,
  // not from aggregators. Blocked here so "call to confirm" listings stay out.
  "smashburger",
];

// Franklin Square is central-west Nassau. Keep deals in/near these towns.
const TARGET_AREA =
  "Franklin Square, Garden City, West Hempstead, Elmont, Mineola, Levittown, " +
  "Bellmore, Malverne, Valley Stream, Hempstead, East Meadow, New Hyde Park, " +
  "Uniondale, Westbury (all in Nassau County, NY). Reject anything clearly far " +
  "(Suffolk County, the Hamptons, NYC boroughs, upstate).";

// Franklin Square Public Library — structured iCal feed of programs (one calendar,
// cid=20873, all audiences). We keep KIDS events only (parser filter below;
// their "Kids" audience id is 9128). If nothing appears, open their calendar,
// click "iCal", and paste the real subscribe link here.
const LIBRARY_ICAL = "https://franklinsquarepl.libcal.com/ical_subscribe.php?cid=20873";

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
// Library iCal: read the structured feed, keep upcoming KIDS/family programs.
// ---------------------------------------------------------------------------
function icalUnescape(s){ return (s||"").replace(/\\n/gi,"\n").replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\\\/g,"\\").trim(); }
function icalProp(block, name){
  const re = new RegExp("^"+name+"(;[^:\\n]*)?:(.*)$","mi");
  const m = block.match(re); return m ? m[2].trim() : "";
}
function icalDate(val){
  // Handles 20260708T100000, 20260708T140000Z, or 20260708 (all-day)
  const m = (val||"").match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if(!m) return null;
  return { y:+m[1], mo:+m[2], d:+m[3], h:m[4]?+m[4]:null, mi:m[5]?+m[5]:0 };
}
const KID_WORDS = ["story","storytime","kids","child","children","toddler","baby","infant","preschool","pre-k","pre k","craft","lego","sing","puppet","summer reading","read to","music and movement","stem","nursery","chess club","rising grades","grades k","grade k","grades 1","grades 2","grades 3","grades 4","grades 5","grades 6","ages 0","ages 1","ages 2","ages 3","ages 4","ages 5","ages 6","ages 7","ages 8","ages 9","ages 10","ages 11","ages 12"];

async function getLibraryEvents(){
  try{
    const res = await fetch(LIBRARY_ICAL, { headers:{ "User-Agent":"Mozilla/5.0 (Tagalong/1.0)" }});
    if(!res.ok) throw new Error("ical "+res.status);
    let txt = await res.text();
    txt = txt.replace(/\r?\n[ \t]/g, ""); // unfold folded lines
    const blocks = txt.split("BEGIN:VEVENT").slice(1).map(b=>b.split("END:VEVENT")[0]);
    const now = new Date(); const horizon = new Date(Date.now()+21*864e5);
    const out = [];
    for(const b of blocks){
      const summary = icalUnescape(icalProp(b,"SUMMARY"));
      if(!summary) continue;
      const desc = icalUnescape(icalProp(b,"DESCRIPTION"));
      const hay = (summary+" "+desc).toLowerCase();
      if(!KID_WORDS.some(w=>hay.includes(w))) continue;      // keep kids programs only
      if(/\bteens?\b|adults? only|senior|55\+|18\+|21\+/i.test(hay)) continue; // drop teen/adult
      const s = icalDate(icalProp(b,"DTSTART")); const e = icalDate(icalProp(b,"DTEND"));
      if(!s || s.h===null) continue;                          // need a real start time
      const start = new Date(s.y, s.mo-1, s.d, s.h, s.mi);
      if(start < now || start > horizon) continue;            // upcoming, next 3 weeks
      const pad=n=>String(n).padStart(2,"0");
      const date = `${s.y}-${pad(s.mo)}-${pad(s.d)}`;
      const startHM = `${pad(s.h)}:${pad(s.mi)}`;
      const endHM = (e && e.h!==null) ? `${pad(e.h)}:${pad(e.mi)}` : "";
      const url = icalProp(b,"URL") || "https://franklinsquarepl.libcal.com/calendar";
      const shortDesc = desc.split("\n")[0].slice(0,150).trim();
      out.push({
        id: "lib-"+date+"-"+summary.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,28),
        type:"event", name:summary, deal:"Free kids program at the library",
        day: start.getDay(), date, start:startHM, end:endHM,
        loc:"Franklin Square Public Library, 19 Lincoln Rd",
        note:(shortDesc?shortDesc+" ":"")+"Free to attend; some programs ask you to register.",
        url, conf:true, src:"fslibrary.org", lastChecked:new Date().toISOString().slice(0,10)
      });
    }
    console.log(`Library: kept ${out.length} upcoming kids events`);
    return out;
  }catch(err){
    console.warn("Library feed failed (skipped):", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");
  const merged = new Map();

  // Your curated/approved list lives in deals.json and is managed from the
  // admin page. The parser NEVER touches it. It only writes scraped.json, so
  // nothing you approved can be overwritten by a weekly refresh.
  for (const s of SOURCES) {
    try {
      console.log("Reading", s.url);
      const text = await fetchText(s.url);
      const raw = await extract(text, s.type);
      for (const d of normalize(raw, s.url)) {
        if (!d.name || !d.deal) continue;
        if (BLOCKLIST.includes(d.name.toLowerCase().trim())) continue; // dropped on purpose
        // First verified source wins; otherwise keep what we have.
        const existing = merged.get(keyOf(d));
        if (!existing || (d.conf && !existing.conf)) merged.set(keyOf(d), d);
      }
    } catch (e) {
      console.warn("Source failed (kept previous data):", s.url, e.message);
    }
  }

  const scraped = [...merged.values()];
  const library = await getLibraryEvents();

  // Combine restaurant scrape + library events, dedupe (date-aware), sort.
  const seen = new Set(); const combined = [];
  for (const d of [...scraped, ...library]) {
    const k = (d.name||"").toLowerCase()+"|"+d.day+"|"+(d.date||"")+"|"+d.type;
    if (seen.has(k)) continue; seen.add(k); combined.push(d);
  }
  const deals = combined.sort((a, b) => {
    const av = a.day === "varies" ? 9 : a.day;
    const bv = b.day === "varies" ? 9 : b.day;
    return av - bv;
  });

  await fs.writeFile(
    "scraped.json",
    JSON.stringify({ updated: new Date().toISOString(), deals }, null, 2)
  );
  console.log(`Wrote ${deals.length} auto-found deals to scraped.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
