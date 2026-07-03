# Tagalong — Project Notes

A Franklin Square / Nassau NY app: where kids eat free plus free family events, sorted by day, with one-tap calendar add. Live at tagalong-five.vercel.app.

## How it works (architecture)
- Static site on Vercel, repo "Tagalong" on GitHub. No backend server.
- `index.html` is the app. On load it merges two files:
  - `deals.json` = your curated/approved list (managed from the admin page). Wins on conflicts.
  - `scraped.json` = auto-found deals written weekly by the parser. Disposable.
- `parser.mjs` reads verified local sources with Claude, applies the blocklist and a Nassau geo-filter, and writes `scraped.json`. It never touches `deals.json`, so nothing you approved can be overwritten by a refresh.
- `.github/workflows/refresh.yml` runs the parser weekly (Mondays) and commits `scraped.json`. Vercel redeploys on commit.
- `admin.html` is your control panel (passcode-gated). Add/edit/remove/modify spots, then Download `deals.json` and upload it to GitHub to publish.

## Publishing model
Nothing goes live until a file is uploaded to GitHub (your login). The admin page and the parser only generate files. This is what keeps control in your hands.

## Rules (keep these)
- FUN PERKS ONLY. Never add income-based or assistance programs (e.g. USDA/SFSP free summer meals, food assistance), even if useful. They can make parents feel singled out.
- Gut-check for any new spot: would a parent feel proud, not self-conscious, sharing it?
- Verify before publish. Prefer the source's own site. Reputable local guides are OK with a "confirm locally" note. In-person / parent-verified counts as strong.
- Blocklist: names the scrape must always drop (currently: Spaghettini Pizza Trattoria; Smashburger unless it ever comes directly from smashburger.com).

## Current approved spots
Moe's Southwest Grill (Sun), American Beauty Bistro / Bellmore (Sun), Tap Room / Garden City (Tue), Miller's Ale House / Levittown (Tue), Your Mother's House (Tue), IKEA / Hicksville (Wed), Rath Park (event), Kids Bowl Free (event).

## Suggestions (parents -> you)
- "Suggest a spot" sends the details to you for review. Nothing posts automatically.
- CURRENT: uses a `mailto:` link (opens the person's default email app: Outlook, Gmail, Apple Mail, etc.). Set the address on `index.html` line 403.
- DECISION (kept for now): stay with mailto for simplicity.
- KNOWN GAP: people with no email app set up can't submit via mailto.
- FUTURE UPGRADE: switch "Suggest a spot" to a Google Form. Works for everyone in a browser, no email app needed, and all submissions land in one spreadsheet. Create the form, then swap its link into the button.

## Setup lines to personalize
- `index.html` line 403: replace `SET_YOUR_EMAIL_HERE` with your email.
- `admin.html` line 82: replace `SET_YOUR_PASSCODE_HERE` with your passcode. (Leave lines 161 and 164 as-is; they are the "no passcode set" safety check.)

## How suggestions and the admin actually work (READ THIS)
- Suggestions do NOT appear in the admin panel. There is no in-app review queue in this version.
- Parent taps "Suggest a spot" -> it emails YOU the details (mailto). Nothing saves in the app.
- The admin panel (`admin.html`) only shows your PUBLISHED list (deals.json). That is why you see only confirmed spots there.
- To publish a suggestion: read the email, then add it yourself in the admin. Leave "Confirmed" unchecked if you want it to show as "Unconfirmed" with a Verify button. Then Download deals.json and upload to GitHub.
- WANT a real submissions queue in the admin (Approve/Reject, approving publishes it)? That needs a small backend (Supabase, free tier). Bigger build, set aside for now.

## Admin passcode notes
- URL: tagalong-five.vercel.app/admin.html
- Passcode is checked against `ADMIN_PASSCODE` on line 82 of admin.html.
- "Wrong passcode" gotchas: capitalization and spaces count; a trailing space breaks it; make sure the quotes are straight (" ") not curly (" "); and confirm the deployed file has your new passcode (edit local but not uploaded = live site still uses the old one).
- Placeholder still set shows "no passcode set yet", not "wrong passcode".

## Library events (iCal)
- The parser reads the Franklin Square Public Library iCal feed (`LIBRARY_ICAL` in parser.mjs), keeps upcoming KIDS-ONLY programs (teen and adult events are filtered out) for the next ~2 weeks, and writes them into scraped.json as dated event cards.
- No library card needed to attend; some programs ask for free registration (noted on each card).
- CONFIRM THE FEED URL ONCE: open their calendar, click the "iCal" button, copy the real subscribe link, and paste it into `LIBRARY_ICAL`. If it's wrong the parser just skips library events (logs a warning) — restaurants still work.
- The app now supports dated events: shows the real date, hides past ones, and "Add to Calendar" creates a single-date event (not weekly).

## Open ideas / later
- Google Form submission (see above).
- Optional source-tier labels on cards (official site vs local guide vs parent-verified).
- Chick & Tender craft nights: dated, social-media-only. Add via admin when they post the next date. Not scrapeable.
- Real backend (Supabase) only if the app grows enough to need instant publishing or a live moderation queue.
