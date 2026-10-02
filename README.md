# Studio Project Manila

Web app for tracking recording sessions and recorder payouts. It replaces the
"Studio Payout Summary" Google Sheet: daily logs, pay-period summaries, payments and follow-ups.

- **Hosting:** Netlify. Static pages come from `public/`, and the API runs as a Netlify Function (`netlify/functions/api.mjs`).
- **Database:** Postgres on Neon.
- **Login:** email + password. Every API route requires a signed-in user.

## Environment variables

Set these in **Netlify → Site configuration → Environment variables**, and in a local `.env` file (git-ignored):

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (pooled). `NETLIFY_DATABASE_URL` also works. |
| `SESSION_SECRET` | Random string, 32+ characters, used to sign login cookies. Changing it signs everyone out. |

## Run locally

```bash
npm install
npm start                      # http://localhost:3000 (reads .env)
```

Tables are created automatically on first request.

## Logins

Create the first admin from your computer. You'll be asked for the password, so it never goes into shell history:

```bash
npm run add-user -- you@atlascapture.io "Your Name" admin
```

After that, admins add teammates on the **Users** page. Staff can log hours, edit sessions and mark payments.
Admins can also manage users and change rates. Running `add-user` again for an existing email resets that password.

## Import the spreadsheet

```bash
npm run import -- "path/to/Studio Payout Summary.xlsx"          # into an empty database
npm run import -- "path/to/Studio Payout Summary.xlsx" --reset  # wipe sessions/recorders/periods first (keeps logins)
```

Export the Google Sheet as `.xlsx` first. Keep spreadsheet exports out of the repo: `*.xlsx` and `data/` are git-ignored.

What gets imported (chosen so nothing is counted twice):

- **Daily sheets** → Studio sessions
- **HOME 08/24–08/28** → Home Shift (one period-total row per person; the sheet has no per-shift detail)
- **HOME 09/01–09/05** → Home Shift, one session per shift
- **Summary 09/18–09/27** and **Copy of Summary 09/28–10/04** → Studio sessions (no daily sheets exist for those days).
  Locations come from the "Business Name" notes; rows without one go under **Unassigned**.
- **OT Staff** → OT sessions (₱150/h)
- **Follow - up** → follow-ups

The other summary sheets are used only to cross-check the daily sheets. The importer merges spelling variants of names,
either by ignoring middle initials or through the alias list in the script. Day-to-day entry in the app matches only exact names
or known aliases, so two different people are never merged by accident.

## Businesses (synced from Google Sheets)

Business profiles and hosted shifts come from the **Studio Business Payout** Google Sheet. The sheet ID is in Settings.
An admin presses **Businesses → Sync from Google Sheet** to pull the latest:

- **Business Profile** tab → owner, bank, account number, account name, GCash owner (matched by business name)
- **Summary tabs** whose header has `Name of Business … Scene | Rate` → one shift row per business per day.
  Business payout = shifts × scenes × rate (₱850 by default).

Each sync replaces the sheet-sourced shift rows. Shifts added in the app are kept.
Each business is linked automatically to the recorder location with the matching name, so its page also shows recorder hours.
You can change the link in **Edit profile**.

The sheet must be shared as **Anyone with the link can view** for the sync to work.
That also means anyone holding the link can see the bank details in it.

## Pages

| Page | Replaces | What it does |
|---|---|---|
| Dashboard | — | Totals, hours per week, hours by location, top recorders |
| Log hours | the `MM/DD/YYYY` daily sheets | One date + location, many recorders; saves in one go |
| Sessions | — | Filter/search every session; edit or delete |
| Pay periods | `Summary MM/DD - MM/DD` sheets | Recorder × day pivot built from sessions, CSV export, print, mark each person paid |
| Recorders | `Sheet2` roster | Accounts, aliases, merge duplicates (old name kept as alias) |
| Businesses | Studio Business Payout sheet | Owner + bank profile, shifts hosted, business payout, recorder activity; sync from Google Sheet |
| Locations | — | Recording sites, merge duplicates |
| Follow-ups | `Follow - up` sheet | Payment problems: expected vs received, old/new account |
| Settings | — | Default USD rate and PHP exchange rate; change your password |
| Users | — | Admins add, disable or reset logins |

Money is always computed as `hours × rate_usd × fx_rate`. Both rates are stored on each session,
so changing the default rate never rewrites past pay.

## Structure

```
api.js                    Express app with all /api routes (used locally and on Netlify)
auth.js                   Password hashing (scrypt), signed session cookies
db.js                     Postgres pool, schema, name/alias matching
businesses.js             Businesses, shifts, Google Sheet sync
server.js                 Local dev server (API + static files)
netlify/functions/api.mjs Netlify Function wrapper
netlify.toml              Publish dir, /api/* → function redirect, security headers
scripts/import-xlsx.js    Spreadsheet importer
scripts/add-user.js       Create/reset a login
public/                   index.html, app.js (hash-routed SPA), styles.css. No build step.
```
