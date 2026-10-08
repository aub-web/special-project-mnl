// Host businesses: profiles, shifts hosted, and sync from the "Studio Business Payout" Google Sheet.
import express from 'express';
import * as XLSX from 'xlsx';
import { q, one, tx, getSettings } from './db.js';
import { requireAdmin } from './auth.js';
import { pushBusinessToSheet } from './sheet-writeback.js';

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
  const ws = wb.Sheets['Business Profile'];
  if (ws) {
    const data = rows('Business Profile');
    const h = data.findIndex((r) => /name of business/i.test(clean(r[0])));
    // Columns are found by their header text, so inserting or moving a column in the sheet doesn't shift data.
    const hdr = data[h].map(clean);
    const col = (re, not) => hdr.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const c = {
      address: col(/address/i), owner: col(/owner'?s? name|^owner$/i), bank: col(/bank name|^bank$/i),
      account: col(/acct|account/i, /name/i), ownerId: col(/owner'?s id/i), gcash: col(/gcash/i), status: col(/status/i),
    };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const link = (i, ci) => {
      const t = ci >= 0 ? ws[XLSX.utils.encode_cell({ r: range.s.r + i, c: range.s.c + ci })]?.l?.Target : null;
      return /^https:\/\/(drive|docs)\.google\.com\//.test(t || '') ? t : null;
    };
    const val = (r, ci) => (ci >= 0 ? clean(r[ci]) || null : null);
    data.forEach((r, i) => {
      if (i <= h) return;
      const name = clean(r[0]);
      if (!name) return;
      const ownerIdText = val(r, c.ownerId), gcashText = val(r, c.gcash);
      const sameAsOwner = /^same$/i.test(gcashText || '');
      profiles.push({
        name, address: val(r, c.address), owner_name: val(r, c.owner), bank_name: val(r, c.bank),
        bank_account_no: val(r, c.account), account_name: ownerIdText, status: val(r, c.status),
        gcash_owner: sameAsOwner ? ownerIdText : gcashText,
        owner_id_url: link(i, c.ownerId), gcash_owner_id_url: sameAsOwner ? link(i, c.ownerId) : link(i, c.gcash),
      });
    });
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
        // Sheet values win for these fields; ID links are only filled in when the app has none.
        await q(`UPDATE businesses SET owner_name = $2, bank_name = $3, bank_account_no = $4, account_name = $5, gcash_owner = $6,
            address = COALESCE($7, address), status = $8,
            owner_id_url = COALESCE(owner_id_url, $9), gcash_owner_id_url = COALESCE(gcash_owner_id_url, $10) WHERE id = $1`,
          [id, p.owner_name, p.bank_name, p.bank_account_no, p.account_name, p.gcash_owner, p.address, p.status, p.owner_id_url, p.gcash_owner_id_url], c);
        updated++;
      } else {
        const r = await one(`INSERT INTO businesses (name, owner_name, bank_name, bank_account_no, account_name, gcash_owner, address, status, owner_id_url, gcash_owner_id_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [p.name, p.owner_name, p.bank_name, p.bank_account_no, p.account_name, p.gcash_owner, p.address, p.status, p.owner_id_url, p.gcash_owner_id_url], c);
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
    COALESCE(rs.hours, 0) AS recorder_hours, COALESCE(rs.php, 0) AS recorder_php,
    (SELECT COUNT(*)::int FROM (SELECT recorder_id FROM business_recorders br WHERE br.business_id = biz.id
       UNION SELECT recorder_id FROM sessions s2 WHERE biz.location_id IS NOT NULL AND s2.location_id = biz.location_id) t) AS recorders,
    rs.first_session, rs.last_session
  FROM businesses biz
  LEFT JOIN locations l ON l.id = biz.location_id
  LEFT JOIN LATERAL (SELECT SUM(b.shifts) shifts, SUM(${PAYOUT}) payout, MIN(b.date) first_date, MAX(b.date) last_date
                     FROM business_shifts b WHERE b.business_id = biz.id) bs ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(s.hours) hours, SUM(${RECORDER_PHP}) php,
                            MIN(s.date) first_session, MAX(s.date) last_session
                     FROM sessions s WHERE s.location_id = biz.location_id) rs ON TRUE`;

// Recorder hours and the pay derived from them are for admins and set directors only — not SDRs.
const RECORDER_FIELDS = ['recorder_hours', 'recorder_php', 'first_session', 'last_session'];
const forRole = (req, b) => {
  if (req.user.role !== 'sdr') return b;
  for (const k of RECORDER_FIELDS) delete b[k];
  if (b.recorder_log) b.recorder_log = [];
  if (b.team) b.team = b.team.map(({ hours, last_date, ...rest }) => rest);
  return b;
};

router.get('/businesses', wrap(async (req) => ({
  businesses: (await q(`${BUSINESS_LIST} ORDER BY biz.active DESC, GREATEST(bs.last_date, rs.last_session) DESC NULLS LAST, biz.name`)).map((b) => forRole(req, b)),
  synced_at: (await getSettings()).business_synced_at || null,
})));

// Names only, for the "Add recorder" picker (SDRs can't list full recorder profiles).
router.get('/businesses/recorder-options', wrap(() => q('SELECT id, name FROM recorders WHERE active ORDER BY name')));

router.get('/businesses/:id', wrap(async (req) => {
  const b = await one(`${BUSINESS_LIST} WHERE biz.id = $1`, [Number(req.params.id)]);
  if (!b) throw fail('Business not found', 404);
  b.shift_log = await q(`SELECT b.*, ${PAYOUT} AS payout FROM business_shifts b WHERE b.business_id = $1 ORDER BY b.date DESC`, [b.id]);
  b.recorder_log = b.location_id ? await q(`
    SELECT s.date, COUNT(*)::int recorders, SUM(s.hours) hours, SUM(${RECORDER_PHP}) php
    FROM sessions s WHERE s.location_id = $1 GROUP BY s.date ORDER BY s.date DESC`, [b.location_id]) : [];
  // Team: recorders added to this business, plus anyone who logged hours at its location.
  b.team = await q(`
    SELECT r.id, r.name, r.contact, bool_or(t.assigned) AS assigned,
           COALESCE((SELECT SUM(s.hours) FROM sessions s WHERE s.recorder_id = r.id AND s.location_id = $2), 0) AS hours,
           (SELECT MAX(s.date) FROM sessions s WHERE s.recorder_id = r.id AND s.location_id = $2) AS last_date
    FROM (SELECT recorder_id, TRUE AS assigned FROM business_recorders WHERE business_id = $1
          UNION ALL SELECT DISTINCT recorder_id, FALSE FROM sessions WHERE $2::int IS NOT NULL AND location_id = $2) t
    JOIN recorders r ON r.id = t.recorder_id
    GROUP BY r.id ORDER BY bool_or(t.assigned) DESC, r.name`, [b.id, b.location_id]);
  return forRole(req, b);
}));

// Add a recorder to a business: an existing one (recorder_id) or a new one by name.
router.post('/businesses/:id/recorders', wrap(async (req) => {
  const bid = Number(req.params.id);
  if (!(await one('SELECT 1 FROM businesses WHERE id = $1', [bid]))) throw fail('Business not found', 404);
  let rid = req.body.recorder_id ? Number(req.body.recorder_id) : null;
  let created = false;
  if (!rid) {
    const name = clean(req.body.name);
    if (name.length < 3) throw fail("Enter the recorder's full name");
    const existing = await one('SELECT id FROM recorders WHERE lower(name) = lower($1)', [name]);
    if (existing) rid = existing.id;
    else { rid = (await one('INSERT INTO recorders (name) VALUES ($1) RETURNING id', [name])).id; created = true; }
  }
  await q('INSERT INTO business_recorders (business_id, recorder_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [bid, rid]);
  // A brand-new recorder also goes into the recorder sheet (when write-back is set up).
  const sheet = created ? await (await import('./sheet-writeback.js')).pushRecorderToSheet(rid) : null;
  return { ok: true, recorder_id: rid, created, sheet };
}));
router.delete('/businesses/:id/recorders/:rid', wrap(async (req) => {
  await q('DELETE FROM business_recorders WHERE business_id = $1 AND recorder_id = $2', [Number(req.params.id), Number(req.params.rid)]);
  return { ok: true };
}));

const BIZ_FIELDS = ['name', 'address', 'owner_name', 'bank_name', 'bank_account_no', 'account_name', 'gcash_owner', 'owner_id_url', 'gcash_owner_id_url',
  'default_scenes', 'rate_php', 'status', 'location_id', 'active', 'notes'];
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
const driveLinkOk = (b) => ['owner_id_url', 'gcash_owner_id_url'].every((k) => !b[k] || /^https:\/\/(drive|docs)\.google\.com\//.test(b[k]));
router.post('/businesses', wrap(async (req) => {
  if (!clean(req.body.name)) throw fail('Business name is required');
  if (!driveLinkOk(req.body)) throw fail('ID links must be Google Drive links');
  if (await one('SELECT 1 FROM businesses WHERE lower(name) = lower($1)', [clean(req.body.name)])) throw fail('A business with this name already exists');
  for (const k of ['default_scenes', 'rate_php']) {
    if (req.body[k] !== undefined && req.body[k] !== '' && !(Number(req.body[k]) >= 0)) throw fail('Scene and payout must be numbers');
  }
  const vals = BIZ_FIELDS.map((k) => (['default_scenes', 'rate_php'].includes(k) ? numOrNull(req.body[k]) : toNull(req.body[k]) ?? (k === 'active' ? true : null)));
  const b = await one(`INSERT INTO businesses (${BIZ_FIELDS.join(',')}) VALUES (${BIZ_FIELDS.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
  return { ...b, sheet: await pushBusinessToSheet(b.id) }; // add it to the Business Profile tab too
}));
router.put('/businesses/:id', wrap(async (req) => {
  if (!driveLinkOk(req.body)) throw fail('ID links must be Google Drive links');
  const before = await one('SELECT name FROM businesses WHERE id = $1', [Number(req.params.id)]);
  const f = BIZ_FIELDS.filter((k) => k in req.body);
  if (!f.length) throw fail('Nothing to update');
  await q(`UPDATE businesses SET ${f.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [Number(req.params.id), ...f.map((k) => (['default_scenes', 'rate_php'].includes(k) ? numOrNull(req.body[k]) : toNull(req.body[k])))]);
  // Keep the Business Profile tab in step (or the 10-minute sync would undo these edits).
  const profile = ['name', 'address', 'owner_name', 'bank_name', 'bank_account_no', 'status'];
  return { ok: true, sheet: profile.some((k) => k in req.body) ? await pushBusinessToSheet(Number(req.params.id), { previousName: before?.name }) : null };
}));
router.delete('/businesses/:id', requireAdmin, wrap(async (req) => {
  await q('DELETE FROM businesses WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// ---------- Shifts ----------
async function shiftValues(b) {
  const biz = await one('SELECT default_scenes, rate_php FROM businesses WHERE id = $1', [Number(b.business_id)]);
  const shifts = Number(b.shifts), scenes = Number(b.scenes ?? biz?.default_scenes);
  const rate = Number(b.rate_php ?? biz?.rate_php ?? (await getSettings()).business_rate_php);
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
