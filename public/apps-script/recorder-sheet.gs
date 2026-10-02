/**
 * Studio Project Manila → Recorder sheet write-back.
 *
* Served at /apps-script/recorder-sheet.gs (Settings → "Copy script"). Paste into the recorder Google Sheet: Extensions → Apps Script → replace Code.gs with this file.
 * Set SECRET to the value shown in the app (Settings → Sheet write-back), then
 * Deploy → New deployment → type "Web app" → Execute as: Me · Who has access: Anyone → Deploy.
 * Copy the Web app URL into the app's Settings.
 *
 * The app calls this when a recorder is added or a registration is approved. It updates the row with the
 * same name or email, or appends a new row. Requests without the right SECRET are ignored.
 */
const SECRET = 'PASTE_THE_SECRET_FROM_THE_APP_HERE';

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  if (!body || body.secret !== SECRET) return out_({ ok: false, error: 'Unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // one write at a time
  try {
    if (body.action === 'ping') return out_({ ok: true, sheet: SpreadsheetApp.getActive().getName() });
    if (body.action === 'upsertRecorder') return out_(upsertRecorder_(body.recorder || {}));
    return out_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function upsertRecorder_(r) {
  if (!r.name) return { ok: false, error: 'Name is required' };
  const sheet = findRecorderSheet_();
  if (!sheet) return { ok: false, error: 'No tab with Address and Payment Method columns found' };
  const values = sheet.getDataRange().getValues();
  const hRow = values.findIndex((row) => row.some((c) => /address/i.test(c)) && row.some((c) => /payment/i.test(c)));
  const header = values[hRow].map((h) => String(h).trim());
  const col = (re) => header.findIndex((h) => re.test(h));
  const cols = {
    email: col(/e-?mail/i),
    address: header.findIndex((h) => /address/i.test(h) && !/e-?mail/i.test(h)),
    contact: col(/contact/i),
    payment_method: col(/payment method/i),
    account_no: col(/account/i),
    id_note: col(/^id$/i),
  };
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const email = String(r.email || '').toLowerCase();

  // Existing row: same name (ignoring spaces/punctuation) or same email.
  let rowIdx = -1;
  for (let i = hRow + 1; i < values.length; i++) {
    const row = values[i];
    if (!String(row[0]).trim()) continue;
    if (key(row[0]) === key(r.match_name || r.name) || (email && cols.email >= 0 && String(row[cols.email]).toLowerCase().trim() === email)) { rowIdx = i; break; }
  }
  let updated = true;
  if (rowIdx < 0) {
    updated = false;
    let last = hRow;
    for (let i = hRow + 1; i < values.length; i++) if (String(values[i][0]).trim()) last = i;
    rowIdx = last + 1;
    sheet.getRange(rowIdx + 1, 1).setValue(r.name);
  }
  const sheetRow = rowIdx + 1;
  if (updated && r.match_name && r.match_name !== r.name) sheet.getRange(sheetRow, 1).setValue(r.name); // renamed in the app
  for (const [field, c] of Object.entries(cols)) {
    if (c < 0 || r[field] == null || r[field] === '') continue;
    const cell = sheet.getRange(sheetRow, c + 1);
    // ID cells may hold Drive file chips — never overwrite one that already has something in it.
    if (field === 'id_note' && String(cell.getDisplayValue()).trim()) continue;
    if (field === 'contact' || field === 'account_no') cell.setNumberFormat('@'); // keep leading zeros (09…)
    cell.setValue(String(r[field]));
  }
  return { ok: true, row: sheetRow, updated: updated };
}

function findRecorderSheet_() {
  return SpreadsheetApp.getActive().getSheets().find((s) => {
    const top = s.getRange(1, 1, Math.min(5, s.getMaxRows()), Math.min(15, s.getMaxColumns())).getValues();
    return top.some((row) => row.some((c) => /address/i.test(c)) && row.some((c) => /payment/i.test(c)));
  });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
