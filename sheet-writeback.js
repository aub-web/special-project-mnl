// App → Google Sheet write-back through a small Apps Script web app attached to the recorder sheet
// (google-apps-script/recorder-sheet.gs). Keeps the sheet in step with recorders added or edited in the app,
// so the 10-minute sheet → app sync doesn't undo app-side changes.
import express from 'express';
import { pool, q, one, getSettings } from './db.js';
import { requireAdmin } from './auth.js';

export const router = express.Router();

// Only Apps Script web-app URLs are ever called (the URL comes from Settings).
const isScriptUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(u || '').trim());

async function callScript(payload) {
  const s = await getSettings();
  // SHEETS_WEBHOOK_TEST_URL: local testing only (points at a simulated script); never set on Netlify.
  const testUrl = process.env.NETLIFY ? '' : process.env.SHEETS_WEBHOOK_TEST_URL || '';
  const url = testUrl || String(s.recorder_sheet_webhook || '').trim();
  if (!url) return { ok: false, skipped: true, error: 'Sheet write-back is not set up (Settings).' };
  if (!testUrl && !isScriptUrl(url)) return { ok: false, error: 'The write-back URL must be an Apps Script web app URL ending in /exec.' };
  try {
    // Apps Script answers with a redirect to googleusercontent.com; fetch follows it.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      // The recorder sheet's ID lets the script work from any Apps Script project, attached to a sheet or standalone.
      body: JSON.stringify({ ...payload, recorderSpreadsheetId: sheetId(s.recorder_sheet_id), secret: s.sheets_webhook_secret }),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: `Unexpected reply from Apps Script (HTTP ${res.status}). Is it deployed with access "Anyone"?` }; }
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'Apps Script did not answer in time.' : e.message };
  }
}

/** Push one recorder's profile to the sheet (update their row, or append one). Never throws. */
export async function pushRecorderToSheet(recorderId, { previousName } = {}) {
  const r = await one(`SELECT r.name, r.email, r.contact, r.address, r.payment_method, r.payout_account_no,
      (SELECT COUNT(*)::int FROM recorder_files f WHERE f.recorder_id = r.id AND f.kind = 'id') AS id_files
    FROM recorders r WHERE r.id = $1`, [recorderId]);
  if (!r) return { ok: false, error: 'Recorder not found' };
  return callScript({
    action: 'upsertRecorder',
    recorder: {
      name: r.name, match_name: previousName || r.name, email: r.email, contact: r.contact, address: r.address,
      payment_method: r.payment_method, account_no: r.payout_account_no,
      id_note: r.id_files ? `${r.id_files} ID file(s) in WebApp` : '',
    },
  });
}

const sheetId = (v) => String(v || '').match(/[\w-]{20,}/)?.[0] || '';

/** Push a business's profile to the business sheet's "Business Profile" tab. Never throws. */
export async function pushBusinessToSheet(businessId, { previousName } = {}) {
  const b = await one('SELECT name, address, owner_name, bank_name, bank_account_no, status FROM businesses WHERE id = $1', [businessId]);
  if (!b) return { ok: false, error: 'Business not found' };
  const s = await getSettings();
  return callScript({ action: 'upsertBusiness', spreadsheetId: sheetId(s.business_sheet_id), business: { ...b, match_name: previousName || b.name } });
}

// ---------------------------------------------------------------- hours → Studio Payout Summary
//
// A session is "in the sheet" when its source is a weekly Summary tab (it came from the sheet, or the app
// wrote it there). Those are changed by sending the *difference* in hours to the same cell, so app and sheet
// stay equal and the 10-minute sheet → app sync never double counts. Only Studio hours on weekdays fit the
// weekly tabs; anything else stays in the app.

export const inSheet = (source) => /summary/i.test(String(source || ''));
export const fromOtherTab = (source) => !!source && source !== 'web' && !inSheet(source);
const weekday = (date) => { const d = new Date(date + 'T12:00:00Z').getUTCDay(); return d >= 1 && d <= 5; };
export const fitsSheet = (s) => s.category === 'Studio' && weekday(s.date);

export async function sessionInfo(ids, db = pool) {
  return q(`SELECT s.id, s.date, s.hours, s.category, s.source, r.name, l.name AS location
    FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.id = ANY($1)`, [ids], db);
}

/** Send hour changes [{ id, date, name, location, delta }] to the hours sheet. Returns the script's per-item results. */
export async function pushHours(items) {
  if (!items.length) return { ok: true, results: [] };
  const s = await getSettings();
  return callScript({ action: 'addHoursBatch', spreadsheetId: sheetId(s.payout_sheet_id), items });
}

/**
 * Newly logged sessions → add their hours to the sheet and mark them as in the sheet.
 * Returns { sent, notSent: [{ name, date, reason }], skipped?, error? } for the UI.
 */
export async function writeNewSessions(ids) {
  const rows = (await sessionInfo(ids)).filter((r) => !inSheet(r.source));
  const fit = rows.filter(fitsSheet);
  const notSent = rows.filter((r) => !fitsSheet(r)).map((r) => ({ name: r.name, date: r.date,
    reason: r.category !== 'Studio' ? `${r.category} hours aren't in the weekly tabs` : 'weekend dates have no column in the weekly tabs' }));
  if (!fit.length) return { sent: 0, notSent };
  const res = await pushHours(fit.map((r) => ({ id: r.id, date: r.date, name: r.name, location: r.location, delta: r.hours })));
  if (!res.ok) return { sent: 0, notSent, skipped: res.skipped, error: res.error };
  let sent = 0;
  for (const x of res.results || []) {
    if (x.ok) { await q('UPDATE sessions SET source = $1 WHERE id = $2', [x.tab, x.id]); sent++; }
    else notSent.push({ ...fit.find((r) => r.id === x.id), reason: x.error });
  }
  return { sent, notSent, created_tab: (res.results || []).find((x) => x.created_tab)?.created_tab };
}

router.post('/sheets/test', requireAdmin, async (req, res) => res.json(await callScript({ action: 'ping' })));

// Hours logged in the app that aren't in the sheet yet (e.g. logged before write-back existed).
router.get('/payout/pending', requireAdmin, async (req, res) => {
  const rows = await q(`SELECT COUNT(*)::int n FROM sessions WHERE (source IS NULL OR source = 'web') AND category = 'Studio'
    AND EXTRACT(ISODOW FROM date::date) BETWEEN 1 AND 5`);
  res.json({ n: rows[0].n });
});
router.post('/payout/push-pending', requireAdmin, async (req, res) => {
  const ids = (await q(`SELECT id FROM sessions WHERE (source IS NULL OR source = 'web') AND category = 'Studio'
    AND EXTRACT(ISODOW FROM date::date) BETWEEN 1 AND 5 ORDER BY date`)).map((r) => r.id);
  res.json(await writeNewSessions(ids));
});
router.post('/recorders/:id/push-to-sheet', requireAdmin, async (req, res) => res.json(await pushRecorderToSheet(Number(req.params.id))));
