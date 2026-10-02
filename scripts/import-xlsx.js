// One-time import of "Studio Payout Summary.xlsx" into the Postgres database.
// Usage: npm run import -- [path/to/file.xlsx] [--reset]
//   --reset  wipes sessions, recorders, locations, periods, payments and follow-ups first
//            (logins and settings are kept).
//
// Sources used (chosen so nothing is counted twice):
//   MM/DD/YYYY daily sheets        -> Studio sessions
//   HOME 08/24 to 08/28            -> Home Shift (period total only, no per-shift breakdown)
//   HOME 09/01 to 09/05            -> Home Shift, one session per shift
//   Summary 09/18 - 09/27          -> Studio sessions (no daily sheets exist for these days)
//   Copy of Summary 09/28 - 10/04  -> Studio sessions (same reason)
//   OT Staff                       -> OT sessions
//   Follow - up                    -> followups
// Other Summary sheets are only used to cross-check the daily sheets.
// Note: Excel's export drops "/" from tab names, so "08/14/2026" arrives as "08142026".
import * as XLSX from 'xlsx';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, one, tx, migrate, resolveRecorder, resolveLocation, addAlias, nameKey, getSettings } from '../db.js';

XLSX.set_fs(fs);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || join(root, 'data', 'Studio Payout Summary.xlsx');

await migrate();
if (args.includes('--reset')) {
  await q('TRUNCATE sessions, payments, followups, periods, recorder_aliases, recorders, locations RESTART IDENTITY CASCADE');
} else if ((await one('SELECT COUNT(*)::int n FROM sessions')).n > 0) {
  console.error('Database already has sessions. Re-run with --reset to start over.');
  process.exit(1);
}

const YEAR = 2026;
const { rate_usd: RATE, fx_rate: FX } = await getSettings();

// Spelling variants that the automatic matcher (which ignores middle initials) can't catch.
const ALIASES = {
  'Sean Calnea': 'Cedrick Sean Calnea',
  'Kier Melvar': 'Kier John S. Milvar',
  'Kier John Milvar': 'Kier John S. Milvar',
  'Lorenz Rudas': 'John Lorenz Rudas',
  'Diane Cristel A, Matias': 'Diane Cristyl Matias',
  'Pfiser Diaz': 'Pfiser Bon Diaz',
  'Jerome Bernardo': 'Jerome Bernardo Muñez',
  'Cyrhus Sison': 'Cyrhus Enrhic Sison',
  'Mark Axel Arusto': 'Mark Axel Asurto',
  'John Zedric Carpon': 'John Cedric Carpon',
  'Mark Jhon Paul Bono': 'Mark John Paul Bono',
};

const wb = XLSX.readFile(file);
const rows = (name) => {
  if (!wb.Sheets[name]) throw new Error(`Sheet "${name}" not found in ${file}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
};
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[₱$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const iso = (m, d) => `${YEAR}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const isTotal = (s) => /^total$/i.test(clean(s));
const headerRow = (data, re) => data.findIndex((r) => re.test(clean(r[0])));
// Header cell -> ISO date. Cells are either Excel date serials or "MM/DD/YYYY" text.
const cellDate = (v) => {
  if (typeof v === 'number' && v > 40000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = clean(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

const counts = {};
const bump = (k, n) => (counts[k] = (counts[k] || 0) + n);

await tx(async (c) => {
  // Cache lookups: each one is a network round trip to the database.
  const recCache = new Map(), locCache = new Map();
  const recorder = async (raw) => {
    const name = clean(raw);
    if (!name) return null;
    if (recCache.has(name)) return recCache.get(name);
    const canonical = ALIASES[name];
    const id = await resolveRecorder(canonical || name, { fuzzy: true, db: c });
    if (canonical) await addAlias(name, id, c);
    recCache.set(name, id);
    return id;
  };
  const location = async (where) => {
    if (!locCache.has(where)) locCache.set(where, await resolveLocation(where, c));
    return locCache.get(where);
  };
  const setAppAccount = async (rid, acct) => {
    if (/^\d+$/.test(clean(acct))) await q('UPDATE recorders SET app_account = COALESCE(app_account, $1) WHERE id = $2', [clean(acct), rid], c);
  };
  const session = async ({ who, where, date, hours, category = 'Studio', shift = null, notes = null, source }) => {
    if (!(hours > 0)) return 0;
    const rid = await recorder(who);
    if (!rid) return 0;
    await q(`INSERT INTO sessions (recorder_id, location_id, date, hours, category, shift, rate_usd, fx_rate, notes, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [rid, await location(where), date, hours, category, shift, RATE, FX, notes || null, source], c);
    return 1;
  };

  // 0. Seed canonical names from the most complete roster first so they win over short variants.
  for (const r of rows('Summary 0901 - 0905').slice(2)) if (clean(r[0]) && !isTotal(r[0])) await recorder(r[0]);

  // 1. Daily sheets
  for (const name of wb.SheetNames) {
    const m = name.match(/^(\d{2})\/?(\d{2})\/?(\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${m[1]}-${m[2]}`;
    for (const r of rows(name).slice(1)) {
      bump('Daily sheets', await session({ who: r[0], where: clean(r[1]), date, hours: num(r[3]), notes: clean(r[7]), source: name }));
    }
  }

  // 2. HOME 08/24 to 08/28 — only period totals ("WebApp (Uploaded) in hours")
  {
    const sheet = 'HOME 0824 to 0828';
    const data = rows(sheet);
    const h = headerRow(data, /recorder's name/i);
    const hCol = data[h].map(clean).findIndex((x) => /webapp/i.test(x));
    for (const r of data.slice(h + 1)) {
      if (!clean(r[0]) || isTotal(r[0])) continue;
      await setAppAccount(await recorder(r[0]), r[1]);
      bump(sheet, await session({
        who: r[0], where: 'HOME Airbnb (Cainta)', date: iso(8, 24), hours: num(r[hCol]), category: 'Home Shift',
        shift: 'Period total 08/24–08/28', notes: clean(r[hCol + 4]), source: sheet,
      }));
    }
  }

  // 3. HOME 09/01 to 09/05 — per shift
  {
    const sheet = 'HOME 0901 to 0905';
    const data = rows(sheet);
    const h = headerRow(data, /recorder's name/i);
    const shiftCols = [];
    data[h].forEach((x, i) => {
      const m = clean(x).match(/Sept?\.?\s*(\d{1,2})\s*-\s*(\d{1,2}(?:am|pm)).*?(\d{1,2}(?:am|pm))\s*$/i);
      if (m) shiftCols.push({ i, date: iso(9, m[1]), shift: `${clean(data[h - 1][i])} (${m[2]}–${m[3]})` });
    });
    for (const r of data.slice(h + 1)) {
      if (!clean(r[0]) || isTotal(r[0])) continue;
      await setAppAccount(await recorder(r[0]), r[1]);
      for (const col of shiftCols) {
        bump(sheet, await session({ who: r[0], where: 'HOME Airbnb (Pasig)', date: col.date, hours: num(r[col.i]), category: 'Home Shift', shift: col.shift, source: sheet }));
      }
    }
  }

  // 4 & 5. Summary sheets that have no daily sheets behind them.
  //   locationByRow uses the 1-based sheet row ranges written at the bottom of each summary.
  const fromSummary = async (sheet, locationByRow, notesByDate = {}) => {
    const data = rows(sheet);
    const h = headerRow(data, /name of recorder/i);
    const dateCols = [];
    data[h].forEach((x, i) => {
      const date = cellDate(x);
      if (date) dateCols.push({ i, date });
    });
    for (let idx = h + 2; idx < data.length; idx++) {
      const r = data[idx];
      if (!clean(r[0]) || isTotal(r[0])) continue;
      for (const col of dateCols) {
        bump(sheet, await session({ who: r[0], where: locationByRow(idx + 1), date: col.date, hours: num(r[col.i]), notes: notesByDate[col.date], source: sheet }));
      }
    }
  };
  const noPaper = 'No paper yet (recorded via GC)';
  await fromSummary(
    'Summary 0918 - 0927',
    (row) => (row >= 3 && row <= 12 ? 'Mt. Moriah' : row >= 17 && row <= 19 ? 'ERS Sip Up Cafe' : 'Unassigned'),
    { '2026-09-23': noPaper, '2026-09-24': noPaper, '2026-09-25': noPaper },
  );
  await fromSummary('Copy of Summary 0928 - 1004', (row) => (row >= 3 && row <= 5 ? 'Oh Mama Maginhawa Branch' : 'Unassigned'));

  // 6. OT Staff — several blocks, each "title row / Name header / rows / Total"
  {
    const sheet = 'OT Staff';
    let block = null, cols = [];
    for (const r of rows(sheet)) {
      const a = clean(r[0]);
      if (a && r.slice(1).every((v) => !clean(v))) { block = a; continue; }
      if (/^name$/i.test(a)) {
        cols = [];
        r.forEach((h, i) => {
          const m = clean(h).match(/^(\d{1,2})\/(\d{1,2})/);
          if (i > 0 && m) cols.push({ i, date: iso(m[1], m[2]), label: clean(h) });
        });
        continue;
      }
      if (!a || isTotal(a)) continue;
      for (const col of cols) {
        bump(sheet, await session({
          who: a, where: 'Office (OT)', date: col.date, hours: num(r[col.i]), category: 'OT',
          notes: `${block}${col.label.includes('to') ? ` · ${col.label}` : ''}`, source: sheet,
        }));
      }
    }
  }

  // 7. Follow-up
  for (const r of rows('Follow - up').slice(2)) {
    if (!clean(r[0]) || r.slice(1).every((v) => !clean(v))) continue;
    const expected = num(r[1]) + num(r[2]);
    await q(`INSERT INTO followups (recorder_id, description, expected_php, received_php,
      old_account_no, old_account_name, new_account_no, new_account_name, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [await recorder(r[0]), 'Payout for Aug 14–27', expected || null, clean(r[3]) ? num(r[3]) : null,
        clean(r[6]), clean(r[7]), clean(r[8]), clean(r[9]), clean(r[10])], c);
    bump('Follow - up', 1);
  }

  // 8. Pay periods (taken from the Summary sheet names)
  for (const p of [
    ['Aug 14 – Aug 21', iso(8, 14), iso(8, 21), 'Closed', 'Antel Global (NARUTO Office)'],
    ['Aug 24 – Aug 28', iso(8, 24), iso(8, 28), 'Closed', 'NARUTO Airbnb + HOME Airbnb (Cainta)'],
    ['Sep 01 – Sep 05', iso(9, 1), iso(9, 5), 'Closed', 'HOME Airbnb (Pasig) + Antel Global'],
    ['Sep 08 – Sep 11', iso(9, 8), iso(9, 11), 'Closed', 'Bam Bam Chicken'],
    ['Sep 14 – Sep 20', iso(9, 14), iso(9, 20), 'Closed', 'Tone Tower + Mt. Moriah'],
    ['Sep 21 – Sep 27', iso(9, 21), iso(9, 27), 'Closed', 'Mt. Moriah + ERS Sip Up Cafe'],
    ['Sep 28 – Oct 04', iso(9, 28), iso(10, 4), 'Open', 'Oh Mama Maginhawa + others'],
  ]) await q('INSERT INTO periods (name, start_date, end_date, status, notes) VALUES ($1,$2,$3,$4,$5)', p, c);
});

// Cross-check: daily sheets vs the Summary sheets built from them.
const mismatches = [];
for (const [sheet, from, to] of [
  ['Summary 0814 - 0821', iso(8, 14), iso(8, 21)],
  ['Summary 0824 - 0827', iso(8, 24), iso(8, 27)],
  ['Summary 0908 - 0911', iso(9, 8), iso(9, 11)],
  ['Summary 0915 - 0916', iso(9, 15), iso(9, 16)],
]) {
  const data = rows(sheet);
  const totalCol = data[0].findIndex((h) => /total in hours/i.test(clean(h)));
  for (const r of data.slice(2)) {
    if (!clean(r[0]) || isTotal(r[0])) continue;
    const rid = await resolveRecorder(ALIASES[clean(r[0])] || clean(r[0]), { create: false, fuzzy: true });
    const got = rid
      ? (await one(`SELECT COALESCE(SUM(hours),0) h FROM sessions WHERE recorder_id=$1 AND category='Studio' AND date BETWEEN $2 AND $3`, [rid, from, to])).h
      : 0;
    const want = num(r[totalCol]);
    if (Math.abs(got - want) > 0.01) mismatches.push(`${sheet}: ${clean(r[0])} summary=${want} daily=${got}`);
  }
}

const stats = await one(`SELECT (SELECT COUNT(*)::int FROM recorders) recorders, (SELECT COUNT(*)::int FROM locations) locations,
  (SELECT ROUND(SUM(hours)::numeric, 2)::float8 FROM sessions) hours`);
console.log('Imported sessions:', counts);
console.log(`Recorders: ${stats.recorders} | Locations: ${stats.locations} | Total hours: ${stats.hours}`);
console.log(mismatches.length
  ? `Summary cross-check differences (${mismatches.length}) — OT staff rows and known sheet quirks are expected:\n  ` + mismatches.join('\n  ')
  : 'Summary cross-check: all daily sheets match their summaries.');

// Flag names that might still be the same person (same first + last word).
const all = await q('SELECT id, name FROM recorders ORDER BY name');
const near = [];
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
  const a = nameKey(all[i].name).split(' '), b = nameKey(all[j].name).split(' ');
  if (a.at(-1) === b.at(-1) && a[0] === b[0]) near.push(`${all[i].name}  ~  ${all[j].name}`);
}
if (near.length) console.log('Possible duplicates to review (use Merge in the Recorders page):\n  ' + near.join('\n  '));
await pool.end();
