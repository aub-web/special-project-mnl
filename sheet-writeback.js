// App → Google Sheet write-back through a small Apps Script web app attached to the recorder sheet
// (google-apps-script/recorder-sheet.gs). Keeps the sheet in step with recorders added or edited in the app,
// so the 10-minute sheet → app sync doesn't undo app-side changes.
import express from 'express';
import { one, getSettings } from './db.js';
import { requireAdmin } from './auth.js';

export const router = express.Router();

// Only Apps Script web-app URLs are ever called (the URL comes from Settings).
const isScriptUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(u || '').trim());

async function callScript(payload) {
  const s = await getSettings();
  const url = String(s.recorder_sheet_webhook || '').trim();
  if (!url) return { ok: false, skipped: true, error: 'Sheet write-back is not set up (Settings).' };
  if (!isScriptUrl(url)) return { ok: false, error: 'The write-back URL must be an Apps Script web app URL ending in /exec.' };
  try {
    // Apps Script answers with a redirect to googleusercontent.com; fetch follows it.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ...payload, secret: s.sheets_webhook_secret }),
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

router.post('/sheets/test', requireAdmin, async (req, res) => res.json(await callScript({ action: 'ping' })));
router.post('/recorders/:id/push-to-sheet', requireAdmin, async (req, res) => res.json(await pushRecorderToSheet(Number(req.params.id))));
