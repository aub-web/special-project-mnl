// Recorder profiles (address, contact, payment account, ID, contract) synced from the recorder Google Sheet.
import express from 'express';
import * as XLSX from 'xlsx';
import { q, tx, getSettings, resolveRecorder } from './db.js';
import { requireAdmin } from './auth.js';
import { fetchWorkbook } from './businesses.js';

export const router = express.Router();

const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
/** Phone/GCash numbers stored as numbers lose their leading 0 (9171234567 → 09171234567). */
const phone = (v) => {
  const s = clean(v).replace(/^'/, '');
  return /^9\d{9}$/.test(s) ? '0' + s : s;
};

// Header text → recorder column. Matched loosely so renamed/reordered columns still work.
const COLUMNS = [
  [/e-?mail/i, 'email', (v) => clean(v).toLowerCase()],   // before "address" so "Email Address" lands here
  [/address/i, 'address', clean],
  [/contact/i, 'contact', phone],
  [/payment method/i, 'payment_method', (v) => ({ gcash: 'GCash', paymaya: 'PayMaya', maya: 'PayMaya', gotyme: 'GoTyme' })[clean(v).toLowerCase()] || clean(v)],
  [/account/i, 'payout_account_no', phone],
  [/^id$/i, 'id_document', clean],
  [/hard copy/i, 'contract_hard_copy', clean],
  [/contract/i, 'contract', clean],
];

/** Exported for testing: workbook → [{ name, fields }] */
export function parseRecorderWorkbook(wb) {
  const out = [];
  for (const n of wb.SheetNames) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
    const h = data.findIndex((r) => r.some((c) => /address/i.test(clean(c))) && r.some((c) => /payment/i.test(clean(c))));
    if (h < 0) continue;
    const map = [];
    data[h].forEach((c, i) => {
      const col = COLUMNS.find(([re, key]) => re.test(clean(c)) && !map.some((m) => m.key === key));
      if (col) map.push({ i, key: col[1], fn: col[2] });
    });
    for (const r of data.slice(h + 1)) {
      const name = clean(r[0]);
      if (!name) continue;
      const fields = {};
      for (const m of map) {
        const v = m.fn(r[m.i]);
        if (v) fields[m.key] = v;
      }
      out.push({ name, fields });
    }
  }
  return out;
}

export async function syncRecorders() {
  const settings = await getSettings();
  const people = parseRecorderWorkbook(await fetchWorkbook(String(settings.recorder_sheet_id)));
  if (!people.length) throw Object.assign(new Error('No recorder rows found. The sheet needs a header row with Address and Payment Method columns.'), { status: 400 });
  return tx(async (c) => {
    let updated = 0;
    const created = [];
    for (const p of people) {
      // Fuzzy: the sheet often spells names with/without middle initials.
      let id = await resolveRecorder(p.name, { create: false, fuzzy: true, db: c });
      if (id) updated++;
      else { id = await resolveRecorder(p.name, { db: c }); created.push(p.name); }
      const keys = Object.keys(p.fields);
      // Only filled cells overwrite; a blank cell in the sheet keeps what the app has.
      if (keys.length) {
        await q(`UPDATE recorders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => p.fields[k])], c);
      }
    }
    const at = new Date().toISOString();
    await q(`INSERT INTO settings (key, value) VALUES ('recorder_synced_at', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [at], c);
    return { rows: people.length, updated, created, synced_at: at };
  });
}

router.post('/recorders/sync', requireAdmin, async (req, res) => {
  try { res.json(await syncRecorders()); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 400).json({ error: e.message }); }
});
