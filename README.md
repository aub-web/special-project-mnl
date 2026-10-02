# Studio Payout

Web app for tracking recording sessions and recorder payouts. It replaces the
"Studio Payout Summary" Google Sheet: daily logs, pay-period summaries, payments and follow-ups.

## Run it

```bash
npm install
npm run import -- "path/to/Studio Payout Summary.xlsx" --reset   # first time only
npm start                                                         # http://localhost:3000
```

Requires Node 22.13+ (uses the built-in `node:sqlite`). Data lives in `data/spl.db`
and is git-ignored, so payout data and account numbers never end up in the repo.

## Pages

| Page | Replaces | What it does |
|---|---|---|
| Dashboard | — | Totals, hours per week, hours by location, top recorders |
| Log hours | the `MM/DD/YYYY` daily sheets | One date + location, many recorders; saves in one go |
| Sessions | — | Filter/search every session; edit or delete |
| Pay periods | `Summary MM/DD - MM/DD` sheets | Recorder × day pivot built from sessions, CSV export, print, mark each person paid |
| Recorders | `Sheet2` roster | Accounts, aliases, **merge duplicates** (old name kept as alias) |
| Locations | — | Sites/businesses, merge duplicates |
| Follow-ups | `Follow - up` sheet | Payment problems: expected vs received, old/new account |
| Settings | — | Default USD rate and PHP exchange rate |

Money is always computed as `hours × rate_usd × fx_rate`. Both rates are stored
on each session, so changing the default rate never rewrites past pay.

## How the sheet was imported

`scripts/import-xlsx.js` reads an `.xlsx` export of the Google Sheet:

- **Daily sheets** → Studio sessions
- **HOME 08/24–08/28** → Home Shift (one period-total row per person; the sheet has no per-shift detail)
- **HOME 09/01–09/05** → Home Shift, one session per shift
- **Summary 09/18–09/27** and **Copy of Summary 09/28–10/04** → Studio sessions (no daily sheets exist for those days).
  Locations come from the "Business Name" notes; rows without one are put under **Unassigned**.
- **OT Staff** → OT sessions (₱150/h)
- **Follow - up** → follow-ups

The other summary sheets are used only to cross-check the daily sheets. Spelling variants of
names are merged automatically, either by ignoring middle initials or through the alias list in the script.

## Structure

```
server.js            Express API
db.js                SQLite schema + helpers (name matching, aliases)
scripts/import-xlsx.js
public/              index.html, app.js (hash-routed SPA), styles.css. No build step.
```
