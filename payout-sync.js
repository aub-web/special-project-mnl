// Sessions synced from the "Studio Payout Summary" Google Sheet (the hours sheet the team still edits).
//
// Every sync re-reads the whole workbook and replaces the sessions that came from it (source = tab name).
// Sessions logged in the app (source = 'web') are never touched, and neither are payments or periods.
//
// What is read, so nothing is counted twice:
//   MM/DD/YYYY daily tabs  → Studio sessions (Excel export drops the slashes: "08142026")
//   HOME … tabs            → Home Shift, per shift; or the "WebApp (Uploaded) in hours" total if no shifts are filled
//   Summary tabs           → only for dates that have no daily tab with hours (e.g. 09/18–10/04).
//                            Locations come from notes like "Mt Moriah (3-12)" written under the table.
//   OT Staff               → OT sessions
import express from 'express';
import * as XLSX from 'xlsx';
import { q, tx, getSettings, resolveRecorder, addAlias } from './db.js';
import { requireAdmin } from './auth.js';
import { fetchWorkbook } from './businesses.js';

export const router = express.Router();

// Spelling variants the automatic matcher (which ignores middle initials) can't catch.
export const ALIASES = {
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
// HOME tabs whose location is known; any other HOME tab goes under "HOME Airbnb".
const HOME_LOCATIONS = { 'HOME 0824 to 0828': 'HOME Airbnb (Cainta)', 'HOME 0901 to 0905': 'HOME Airbnb (Pasig)' };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[₱$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const isTotal = (s) => /^total$/i.test(clean(s));
const pad = (n) => String(n).padStart(2, '0');
const bizKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header cell → ISO date. Cells are Excel date serials or "MM/DD/YYYY" text. */
function cellDate(v) {
  if (typeof v === 'number' && v > 40000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  }
  const m = clean(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
}

/** Workbook → list of sessions { who, where, date, hours, category, shift, notes, source } plus app account numbers. */
export function parsePayoutWorkbook(wb) {
  const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: true });
  const sessions = [];
  const appAccounts = [];
  const add = (s) => { if (s.hours > 0 && clean(s.who)) sessions.push({ ...s, who: clean(s.who) }); };

  // 1. Daily tabs. A date only counts as "covered" if its tab actually has hours (09/18 exists but is empty).
  const covered = new Set();
  let year = new Date().getFullYear();
  for (const name of wb.SheetNames) {
    const m = name.match(/^(\d{2})\/?(\d{2})\/?(\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${m[1]}-${m[2]}`;
    year = Number(m[3]);
    for (const r of rows(name).slice(1)) {
      if (clean(r[0]) && num(r[3]) > 0) {
        add({ who: r[0], where: clean(r[1]), date, hours: num(r[3]), category: 'Studio', notes: clean(r[7]) || null, source: name });
        covered.add(date);
      }
    }
  }

  // 2. HOME tabs
  for (const name of wb.SheetNames.filter((n) => /^HOME\b/i.test(n))) {
    const data = rows(name);
    const h = data.findIndex((r) => /recorder's name/i.test(clean(r[0])));
    if (h < 0) continue;
    const hdr = data[h].map(clean);
    const where = HOME_LOCATIONS[name] || 'HOME Airbnb';
    const shiftCols = [];
    hdr.forEach((x, i) => {
      const m = x.match(/^([a-z]{3})[a-z]*\.?\s*(\d{1,2})\s*-\s*(\d{1,2}(?:am|pm)).*?(\d{1,2}(?:am|pm))\s*$/i);
      if (m && MONTHS[m[1].toLowerCase()]) {
        shiftCols.push({ i, date: `${year}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`, shift: `${clean(data[h - 1]?.[i])} (${m[3]}–${m[4]})`.trim() });
      }
    });
    const totalCol = hdr.findIndex((x) => /webapp/i.test(x));
    const phCol = hdr.findIndex((x) => /ph conv/i.test(x));
    for (const r of data.slice(h + 1)) {
      if (!clean(r[0]) || isTotal(r[0])) continue;
      if (/^\d+$/.test(clean(r[1]))) appAccounts.push({ who: clean(r[0]), account: clean(r[1]) });
      const perShift = shiftCols.filter((c) => num(r[c.i]) > 0);
      if (perShift.length) {
        for (const c of perShift) add({ who: r[0], where, date: c.date, hours: num(r[c.i]), category: 'Home Shift', shift: c.shift, notes: null, source: name });
      } else if (totalCol >= 0 && shiftCols.length) {
        add({ who: r[0], where, date: shiftCols[0].date, hours: num(r[totalCol]), category: 'Home Shift',
          shift: `Period total (${name.replace(/^HOME\s*/i, '')})`, notes: phCol >= 0 ? clean(r[phCol + 1]) || null : null, source: name });
      }
    }
  }

  // 3. Summary tabs, only for dates with no daily tab. Earlier tabs win if two summaries share a date.
  const fromSummary = new Set();
  for (const name of wb.SheetNames) {
    const data = rows(name);
    const h = data.findIndex((r) => /name of recorder/i.test(clean(r[0])));
    if (h < 0) continue;
    const dateCols = data[h].map((x, i) => ({ i, date: cellDate(x) }))
      .filter((c) => c.date && !covered.has(c.date) && !fromSummary.has(c.date));
    if (!dateCols.length) continue;

    // Notes under the table: "Mt Moriah (3-12)" → rows 3–12; "Business Name: | X" (no range) → every row.
    const totalIdx = data.findIndex((r, i) => i > h && isTotal(r[0]));
    const ranges = [];
    let fallback = null;
    const notesByDate = {};
    for (const r of data.slice(totalIdx > 0 ? totalIdx + 1 : data.length)) {
      r.forEach((cell, ci) => {
        const t = clean(cell);
        if (!t) return;
        const m = t.match(/^(.*?)\s*\((\d+)\s*-\s*(\d+)\)$/);
        if (m && m[1]) ranges.push({ name: clean(m[1].replace(/^business name:?/i, '')), from: Number(m[2]), to: Number(m[3]) });
        else if (/^business name:?$/i.test(t)) {
          // "Business Name: | X" applies to every row — unless X has its own "(a-b)" range (handled above).
          const next = clean(r.slice(ci + 1).find((x) => clean(x)) || '');
          if (next && !/\(\d+\s*-\s*\d+\)$/.test(next)) fallback = next;
        }
        else {
          const dc = dateCols.find((c) => c.i === ci);
          if (dc && isNaN(Number(t))) notesByDate[dc.date] = t;
        }
      });
    }
    const whereFor = (sheetRow) => ranges.find((x) => sheetRow >= x.from && sheetRow <= x.to)?.name || fallback || 'Unassigned';

    for (let idx = h + 1; idx < data.length; idx++) {
      if (totalIdx > 0 && idx >= totalIdx) break;
      const r = data[idx];
      if (!clean(r[0]) || isTotal(r[0])) continue;
      for (const c of dateCols) {
        add({ who: r[0], where: whereFor(idx + 1), date: c.date, hours: num(r[c.i]), category: 'Studio', notes: notesByDate[c.date] || null, source: name });
      }
    }
    dateCols.forEach((c) => fromSummary.add(c.date));
  }

  // 4. OT Staff: blocks of "title row / Name header / rows / Total"
  for (const name of wb.SheetNames.filter((n) => /^OT\b/i.test(n))) {
    let block = '', cols = [];
    for (const r of rows(name)) {
      const a = clean(r[0]);
      if (a && r.slice(1).every((v) => !clean(v))) { block = a; continue; }
      if (/^name$/i.test(a)) {
        cols = [];
        r.forEach((x, i) => {
          const m = clean(x).match(/^(\d{1,2})\/(\d{1,2})/);
          if (i > 0 && m) cols.push({ i, date: `${year}-${pad(m[1])}-${pad(m[2])}`, label: clean(x) });
        });
        continue;
      }
      if (!a || isTotal(a)) continue;
      for (const c of cols) {
        add({ who: a, where: 'Office (OT)', date: c.date, hours: num(r[c.i]), category: 'OT',
          notes: `${block}${c.label.includes('to') ? ` · ${c.label}` : ''}` || null, source: name });
      }
    }
  }
  return { sessions, appAccounts };
}

/**
 * Replace all sheet-sourced sessions with what the workbook says now. Returns a summary of what changed.
 * `c` is a transaction client.
 */
export async function applyPayoutSessions(c, wb, { rate_php }) {
  const { sessions, appAccounts } = parsePayoutWorkbook(wb);
  if (!sessions.length) throw Object.assign(new Error('No hours found in this file. Is it the Studio Payout Summary sheet?'), { status: 400 });

  const recCache = new Map();
  const recorder = async (raw) => {
    if (recCache.has(raw)) return recCache.get(raw);
    const canonical = ALIASES[raw];
    const id = await resolveRecorder(canonical || raw, { fuzzy: true, db: c });
    if (canonical) await addAlias(raw, id, c);
    recCache.set(raw, id);
    return id;
  };
  // Locations match ignoring punctuation, so "Mt Moriah" finds "Mt. Moriah".
  const locs = new Map((await q('SELECT id, name FROM locations', [], c)).map((l) => [bizKey(l.name), l.id]));
  const location = async (name) => {
    const key = bizKey(name);
    if (!key) return null;
    if (!locs.has(key)) locs.set(key, (await q('INSERT INTO locations (name) VALUES ($1) RETURNING id', [clean(name)], c))[0].id);
    return locs.get(key);
  };

  const keyOf = (s) => `${s.recorder_id}|${s.date}|${Number(s.hours)}|${s.category}|${s.location_id ?? ''}`;
  const before = await q(`SELECT s.recorder_id, s.date, s.hours, s.category, s.location_id, r.name, l.name AS location
    FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.source IS NOT NULL AND s.source <> 'web'`, [], c);
  await q(`DELETE FROM sessions WHERE source IS NOT NULL AND source <> 'web'`, [], c);

  const after = [];
  for (const s of sessions) {
    const row = { recorder_id: await recorder(s.who), location_id: await location(s.where), date: s.date, hours: s.hours, category: s.category };
    await q(`INSERT INTO sessions (recorder_id, location_id, date, hours, category, shift, rate_php, notes, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.recorder_id, row.location_id, s.date, s.hours, s.category, s.shift || null, rate_php, s.notes, s.source], c);
    after.push({ ...row, name: s.who, location: s.where });
  }
  for (const a of appAccounts) {
    await q('UPDATE recorders SET app_account = COALESCE(app_account, $1) WHERE id = $2', [a.account, await recorder(a.who)], c);
  }

  // Multiset diff so the admin sees exactly what the sync changed.
  const count = (list) => list.reduce((m, s) => m.set(keyOf(s), (m.get(keyOf(s)) || 0) + 1), new Map());
  const b = count(before), a = count(after);
  const describe = (s) => `${s.date} · ${s.name} · ${Number(s.hours)} h · ${s.location || '—'}`;
  const added = after.filter((s) => { const k = keyOf(s); if ((b.get(k) || 0) > 0) { b.set(k, b.get(k) - 1); return false; } return true; });
  const removed = before.filter((s) => { const k = keyOf(s); if ((a.get(k) || 0) > 0) { a.set(k, a.get(k) - 1); return false; } return true; });
  return {
    sessions: after.length,
    hours: Math.round(after.reduce((t, s) => t + s.hours, 0) * 100) / 100,
    added: added.map(describe),
    removed: removed.map(describe),
  };
}

async function runSync(wb) {
  const settings = await getSettings();
  const once = () => tx(async (c) => {
    // Lock out concurrent syncs up front so two admins clicking at once queue instead of deadlocking.
    await q('LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE', [], c);
    const result = await applyPayoutSessions(c, wb, settings);
    const at = new Date().toISOString();
    await q(`INSERT INTO settings (key, value) VALUES ('payout_synced_at', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [at], c);
    return { ...result, synced_at: at };
  });
  // The whole sync is one transaction, so retrying after a deadlock (40P01) is safe.
  for (let attempt = 1; ; attempt++) {
    try { return await once(); }
    catch (e) { if (e.code !== '40P01' || attempt >= 3) throw e; }
  }
}

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 400).json({ error: e.message }); }
};

// Pull straight from Google Sheets (needs "Anyone with the link can view").
router.post('/payout/sync', requireAdmin, wrap(async () => {
  const { payout_sheet_id } = await getSettings();
  let wb;
  try { wb = await fetchWorkbook(String(payout_sheet_id)); }
  catch (e) {
    throw Object.assign(new Error('Could not read the Studio Payout Summary sheet. Share it as "Anyone with the link can view", or use Upload .xlsx instead.'), { status: 400 });
  }
  return runSync(wb);
}));

// Or upload an .xlsx downloaded from Google Sheets (File → Download → Microsoft Excel). Keeps the sheet private.
router.post('/payout/upload', requireAdmin, wrap(async (req) => {
  const b64 = String(req.body?.file || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw Object.assign(new Error('No file received'), { status: 400 });
  let wb;
  try { wb = XLSX.read(Buffer.from(b64, 'base64'), { type: 'buffer' }); }
  catch { throw Object.assign(new Error("That file isn't a readable .xlsx spreadsheet"), { status: 400 }); }
  return runSync(wb);
}));
