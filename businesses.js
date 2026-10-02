// Host businesses: profiles, shifts hosted, and sync from the "Studio Business Payout" Google Sheet.
import express from 'express';
import * as XLSX from 'xlsx';
import { q, one, tx, getSettings } from './db.js';
import { requireAdmin } from './auth.js';

export const router = express.Router();

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 400).json({ error: e.message });
  }
};
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const toNull = (v) => (v === '' || v === undefined ? null : v);
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[₱$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** "Oh! Mama" / "Oh Mama" / "OH MAMA " → "ohmama" */
const bizKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => new Set(clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2));

const PAYOUT = '(b.shifts * b.scenes * b.rate_php)';
const RECORDER_PHP = 'ROUND((s.hours * s.rate_php)::numeric, 2)::float8';

// ---------- Google Sheet sync ----------

function cellDate(v) {
  if (typeof v === 'number' && v > 40000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = clean(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/** Parse the workbook into { profiles, shifts }. Exported for testing. */
export function parseBusinessWorkbook(wb) {
  const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });

  const profiles = [];
  if (wb.Sheets['Business Profile']) {
    const data = rows('Business Profile');
    const h = data.findIndex((r) => /name of business/i.test(clean(r[0])));
    for (const r of data.slice(h + 1)) {
      const name = clean(r[0]);
      if (!name) continue;
      profiles.push({
        name, owner_name: clean(r[1]) || null, bank_name: clean(r[2]) || null,
        bank_account_no: clean(r[3]) || null, account_name: clean(r[4]) || null,
        gcash_owner: /^same$/i.test(clean(r[5])) ? clean(r[4]) || null : clean(r[5]) || null,
      });
    }
  }

  // Business summary tabs: header "Name of Business | <dates…> | Total Shift | Scene | Rate | Total".
  // (Copies of the recorder summaries also contain business names but have no "Scene" column — skipped.)
  const shifts = [];
  const tabs = [];
  for (const n of wb.SheetNames) {
    const data = rows(n);
    const h = data.findIndex((r) => /^name of business$/i.test(clean(r[0])));
    if (h < 0) continue;
    const hdr = data[h].map(clean);
    const sceneCol = hdr.findIndex((x) => /^scenes?$/i.test(x));
    const rateCol = hdr.findIndex((x) => /^rate$/i.test(x));
    if (sceneCol < 0) continue;
    const dateCols = data[h].map((x, i) => ({ i, date: cellDate(x) })).filter((c) => c.date);
    tabs.push(n);
    for (const r of data.slice(h + 1)) {
      const name = clean(r[0]);
      if (!name || /^total$/i.test(name)) continue;
      for (const c of dateCols) {
        const count = num(r[c.i]);
        if (count > 0) shifts.push({ name, date: c.date, shifts: count, scenes: num(r[sceneCol]), rate_php: rateCol >= 0 ? num(r[rateCol]) : null, tab: n });
      }
    }
  }
  return { profiles, shifts, tabs };
}

export async function fetchWorkbook(idOrUrl) {
  // Accept a bare ID or a full docs.google.com link.
  const sheetId = String(idOrUrl || '').match(/\/d\/([\w-]{20,})/)?.[1] || String(idOrUrl || '').trim();
  if (!/^[\w-]{20,}$/.test(sheetId)) throw fail('Google Sheet ID is not set (Settings)');
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`, { redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('spreadsheetml')) {
    throw fail('Could not download the Google Sheet. Make sure it is shared as "Anyone with the link can view".');
  }
  return XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
}

/** Link each business to the recorder location with the most words in common (e.g. "Mt. Moriah" ↔ "Mt. Moriah Restaurant"). */
async function autoLinkLocations(c) {
  const locs = await q('SELECT id, name FROM locations', [], c);
  for (const b of await q('SELECT id, name FROM businesses WHERE location_id IS NULL', [], c)) {
    const bw = words(b.name);
    let best = null, bestScore = 0;
    for (const l of locs) {
      const lw = words(l.name);
      // Every word of the location must appear in the business name; the most specific location wins,
      // so "Oh! Mama Branch 2 - Maginhawa" gets "Oh Mama Maginhawa Branch", not plain "Oh! Mama".
      const exact = bizKey(l.name) === bizKey(b.name);
      const covers = lw.size > 0 && [...lw].every((w) => bw.has(w));
      const score = exact ? 99 : covers ? lw.size : 0;
      if (score > bestScore) { best = l; bestScore = score; }
    }
    if (best) await q('UPDATE businesses SET location_id = $1 WHERE id = $2', [best.id, b.id], c);
  }
}

export async function syncBusinesses() {
  const settings = await getSettings();
  const wb = await fetchWorkbook(String(settings.business_sheet_id));
  const { profiles, shifts, tabs } = parseBusinessWorkbook(wb);
  return tx(async (c) => {
    const all = await q('SELECT id, name FROM businesses', [], c);
    const byKey = new Map(all.map((b) => [bizKey(b.name), b.id]));
    let created = 0, updated = 0;
    for (const p of profiles) {
      const id = byKey.get(bizKey(p.name));
      if (id) {
        await q(`UPDATE businesses SET owner_name = $2, bank_name = $3, bank_account_no = $4, account_name = $5, gcash_owner = $6 WHERE id = $1`,
          [id, p.owner_name, p.bank_name, p.bank_account_no, p.account_name, p.gcash_owner], c);
        updated++;
      } else {
        const r = await one(`INSERT INTO businesses (name, owner_name, bank_name, bank_account_no, account_name, gcash_owner)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [p.name, p.owner_name, p.bank_name, p.bank_account_no, p.account_name, p.gcash_owner], c);
        byKey.set(bizKey(p.name), r.id);
        created++;
      }
    }
    // Sheet-sourced shifts are replaced wholesale; shifts entered in the app are kept.
    await q(`DELETE FROM business_shifts WHERE source = 'sheet'`, [], c);
    const unknown = new Set();
    for (const s of shifts) {
      let id = byKey.get(bizKey(s.name));
      if (!id) {
        id = (await one('INSERT INTO businesses (name) VALUES ($1) RETURNING id', [s.name], c)).id;
        byKey.set(bizKey(s.name), id);
        unknown.add(s.name);
      }
      await q(`INSERT INTO business_shifts (business_id, date, shifts, scenes, rate_php, notes, source) VALUES ($1,$2,$3,$4,$5,$6,'sheet')`,
        [id, s.date, s.shifts, s.scenes, s.rate_php || settings.business_rate_php, s.tab], c);
    }
    await autoLinkLocations(c);
    const at = new Date().toISOString();
    await q(`INSERT INTO settings (key, value) VALUES ('business_synced_at', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [at], c);
    return { profiles: profiles.length, created, updated, shifts: shifts.length, tabs, newFromShifts: [...unknown], synced_at: at };
  });
}

router.post('/businesses/sync', requireAdmin, wrap(() => syncBusinesses()));

// ---------- Businesses ----------
const BUSINESS_LIST = `
  SELECT biz.*, l.name AS location,
    COALESCE(bs.shifts, 0) AS shifts, COALESCE(bs.payout, 0) AS payout, bs.first_date, bs.last_date,
    COALESCE(rs.hours, 0) AS recorder_hours, COALESCE(rs.php, 0) AS recorder_php, COALESCE(rs.recorders, 0) AS recorders,
    rs.first_session, rs.last_session
  FROM businesses biz
  LEFT JOIN locations l ON l.id = biz.location_id
  LEFT JOIN LATERAL (SELECT SUM(b.shifts) shifts, SUM(${PAYOUT}) payout, MIN(b.date) first_date, MAX(b.date) last_date
                     FROM business_shifts b WHERE b.business_id = biz.id) bs ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(s.hours) hours, SUM(${RECORDER_PHP}) php, COUNT(DISTINCT s.recorder_id)::int recorders,
                            MIN(s.date) first_session, MAX(s.date) last_session
                     FROM sessions s WHERE s.location_id = biz.location_id) rs ON TRUE`;

router.get('/businesses', wrap(async () => ({
  businesses: await q(`${BUSINESS_LIST} ORDER BY biz.active DESC, GREATEST(bs.last_date, rs.last_session) DESC NULLS LAST, biz.name`),
  synced_at: (await getSettings()).business_synced_at || null,
})));

router.get('/businesses/:id', wrap(async (req) => {
  const b = await one(`${BUSINESS_LIST} WHERE biz.id = $1`, [Number(req.params.id)]);
  if (!b) throw fail('Business not found', 404);
  b.shift_log = await q(`SELECT b.*, ${PAYOUT} AS payout FROM business_shifts b WHERE b.business_id = $1 ORDER BY b.date DESC`, [b.id]);
  b.recorder_log = b.location_id ? await q(`
    SELECT s.date, COUNT(*)::int recorders, SUM(s.hours) hours, SUM(${RECORDER_PHP}) php
    FROM sessions s WHERE s.location_id = $1 GROUP BY s.date ORDER BY s.date DESC`, [b.location_id]) : [];
  return b;
}));

const BIZ_FIELDS = ['name', 'owner_name', 'bank_name', 'bank_account_no', 'account_name', 'gcash_owner', 'location_id', 'active', 'notes'];
router.post('/businesses', wrap(async (req) => {
  if (!clean(req.body.name)) throw fail('Name is required');
  const vals = BIZ_FIELDS.map((k) => toNull(req.body[k]) ?? (k === 'active' ? true : null));
  return one(`INSERT INTO businesses (${BIZ_FIELDS.join(',')}) VALUES (${BIZ_FIELDS.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
}));
router.put('/businesses/:id', wrap(async (req) => {
  const f = BIZ_FIELDS.filter((k) => k in req.body);
  if (!f.length) throw fail('Nothing to update');
  await q(`UPDATE businesses SET ${f.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [Number(req.params.id), ...f.map((k) => toNull(req.body[k]))]);
  return { ok: true };
}));
router.delete('/businesses/:id', requireAdmin, wrap(async (req) => {
  await q('DELETE FROM businesses WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// ---------- Shifts ----------
async function shiftValues(b) {
  const shifts = Number(b.shifts), scenes = Number(b.scenes), rate = Number(b.rate_php ?? (await getSettings()).business_rate_php);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw fail('Date is required');
  if (!(shifts > 0) || !(scenes > 0) || !(rate >= 0)) throw fail('Shifts and scenes must be more than 0');
  return [Number(b.business_id), b.date, shifts, scenes, rate, toNull(b.notes)];
}
router.post('/business-shifts', wrap(async (req) => {
  return one(`INSERT INTO business_shifts (business_id, date, shifts, scenes, rate_php, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    await shiftValues(req.body));
}));
router.put('/business-shifts/:id', wrap(async (req) => {
  const cur = await one('SELECT * FROM business_shifts WHERE id = $1', [Number(req.params.id)]);
  if (!cur) throw fail('Shift not found', 404);
  if (cur.source === 'sheet') throw fail('This row comes from the Google Sheet — change it there and sync.');
  const v = await shiftValues({ ...cur, ...req.body });
  await q('UPDATE business_shifts SET business_id=$1, date=$2, shifts=$3, scenes=$4, rate_php=$5, notes=$6 WHERE id=$7', [...v, cur.id]);
  return { ok: true };
}));
router.delete('/business-shifts/:id', wrap(async (req) => {
  const cur = await one('SELECT source FROM business_shifts WHERE id = $1', [Number(req.params.id)]);
  if (cur?.source === 'sheet') throw fail('This row comes from the Google Sheet — remove it there and sync.');
  await q('DELETE FROM business_shifts WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));
