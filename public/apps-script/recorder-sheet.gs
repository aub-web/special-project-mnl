/**
 * Studio Project Manila → Google Sheets write-back (version 2).
 *
 * Served at /apps-script/recorder-sheet.gs (Settings → "Copy script", which fills in SECRET for you).
 * Works from any Apps Script project (attached to a sheet or standalone at script.google.com): replace Code.gs → Save.
 * First time: Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → Deploy, copy the URL into Settings.
 * Updating: Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy (the URL stays the same).
 *
 * What it writes (requests without the right SECRET are ignored):
 *   upsertRecorder  → this recorder sheet: update the row with the same name/email, or add one
 *   upsertBusiness  → the business sheet's "Business Profile" tab
 *   addHoursBatch   → the hours sheet (Studio Payout Summary): adds hours into the weekly "Summary" tab
 *                     (recorder row × date column); creates the week's tab from the latest one if missing
 * The account that deploys this needs edit access to all three sheets.
 */
const SECRET = 'PASTE_THE_SECRET_FROM_THE_APP_HERE';
const SCRIPT_VERSION = 3;

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  if (!body || body.secret !== SECRET) return out_({ ok: false, error: 'Unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // one write at a time
  try {
    if (body.action === 'ping') return out_({ ok: true, sheet: recorderBook_(body.recorderSpreadsheetId).getName(), version: SCRIPT_VERSION });
    if (body.action === 'upsertRecorder') return out_(upsertRecorder_(body.recorder || {}, body.recorderSpreadsheetId));
    if (body.action === 'upsertBusiness') return out_(upsertBusiness_(body.spreadsheetId, body.business || {}));
    if (body.action === 'addHoursBatch') return out_(addHoursBatch_(body.spreadsheetId, body.items || []));
    return out_({ ok: false, error: 'Unknown action (update the Apps Script to the latest version)' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

const key_ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------- recorders

/** The recorder sheet: by ID (sent by the app), or the sheet this script is attached to. */
function recorderBook_(id) {
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (!active) throw new Error('Recorder sheet ID missing — set it in the app (Settings → Recorder Google Sheet)');
  return active;
}

function upsertRecorder_(r, recorderSpreadsheetId) {
  if (!r.name) return { ok: false, error: 'Name is required' };
  const sheet = findRecorderSheet_(recorderBook_(recorderSpreadsheetId));
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
  const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const email = String(r.email || '').toLowerCase();

  let rowIdx = -1;
  for (let i = hRow + 1; i < values.length; i++) {
    const row = values[i];
    if (!String(row[0]).trim()) continue;
    if (nameKey(row[0]) === nameKey(r.match_name || r.name) || (email && cols.email >= 0 && String(row[cols.email]).toLowerCase().trim() === email)) { rowIdx = i; break; }
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
    if (field === 'id_note' && String(cell.getDisplayValue()).trim()) continue; // never overwrite an ID file chip
    if (field === 'contact' || field === 'account_no') cell.setNumberFormat('@'); // keep leading zeros (09…)
    cell.setValue(String(r[field]));
  }
  return { ok: true, row: sheetRow, updated: updated };
}

function findRecorderSheet_(book) {
  return book.getSheets().find((s) => {
    const top = s.getRange(1, 1, Math.min(5, s.getMaxRows()), Math.min(15, s.getMaxColumns())).getValues();
    return top.some((row) => row.some((c) => /address/i.test(c)) && row.some((c) => /payment/i.test(c)));
  });
}

// ---------------------------------------------------------------- businesses

function upsertBusiness_(spreadsheetId, b) {
  if (!spreadsheetId) return { ok: false, error: 'Business sheet not set' };
  if (!b.name) return { ok: false, error: 'Name is required' };
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName('Business Profile') || ss.getSheets().find((s) => /name of business/i.test(String(s.getRange(1, 1).getValue())));
  if (!sheet) return { ok: false, error: 'No "Business Profile" tab found' };
  const values = sheet.getDataRange().getValues();
  const hRow = values.findIndex((row) => /name of business/i.test(String(row[0])));
  const header = values[hRow].map((h) => String(h).trim());
  const col = (re, not) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const cols = {
    address: col(/address/i), owner_name: col(/owner'?s? name|^owner$/i), bank_name: col(/bank name|^bank$/i),
    bank_account_no: col(/acct|account/i, /name/i), status: col(/status/i),
  };
  let rowIdx = -1, last = hRow;
  for (let i = hRow + 1; i < values.length; i++) {
    if (!String(values[i][0]).trim()) continue;
    last = i;
    if (rowIdx < 0 && key_(values[i][0]) === key_(b.match_name || b.name)) rowIdx = i;
  }
  const updated = rowIdx >= 0;
  if (!updated) rowIdx = last + 1;
  const sheetRow = rowIdx + 1;
  sheet.getRange(sheetRow, 1).setValue(b.name);
  for (const [field, c] of Object.entries(cols)) {
    if (c < 0 || b[field] == null || b[field] === '') continue;
    const cell = sheet.getRange(sheetRow, c + 1);
    if (field === 'bank_account_no') cell.setNumberFormat('@');
    cell.setValue(String(b[field]));
  }
  return { ok: true, row: sheetRow, updated: updated };
}

// ---------------------------------------------------------------- hours

/** items: [{ id, date: 'YYYY-MM-DD', name, location, delta }] → { ok, results: [{ id, ok, tab, row, value, error }] } */
function addHoursBatch_(spreadsheetId, items) {
  if (!spreadsheetId) return { ok: false, error: 'Hours sheet not set' };
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const results = items.map((it) => {
    try { return Object.assign({ id: it.id }, addHours_(ss, it)); }
    catch (err) { return { id: it.id, ok: false, error: String(err) }; }
  });
  return { ok: true, results: results };
}

function addHours_(ss, it) {
  const tz = ss.getSpreadsheetTimeZone();
  const fmt = (d) => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  let tab = findWeekTab_(ss, it.date, fmt);
  let createdTab = null;
  if (!tab) {
    tab = createWeekTab_(ss, it.date, fmt);
    if (tab.error) return { ok: false, error: tab.error };
    createdTab = tab.sheet.getName();
  }
  const { sheet, h, dateCol } = tab;
  const values = sheet.getDataRange().getValues();
  const header = values[h].map((x) => String(x).trim());
  const locCol = header.findIndex((x) => /^location$/i.test(x));
  const dateCols = values[h].map((c, i) => ((c instanceof Date || parseDate_(c)) ? i : -1)).filter((i) => i > 0);
  let totalRow = values.findIndex((r, i) => i > h && /^total$/i.test(String(r[0]).trim()));
  if (totalRow < 0) totalRow = values.length;

  // Row for this recorder at this location (blank location counts as a match and gets filled in).
  let rowIdx = -1;
  for (let i = h + 2; i < totalRow; i++) {
    if (key_(values[i][0]) !== key_(it.name)) continue;
    const loc = locCol >= 0 ? String(values[i][locCol]).trim() : '';
    if (locCol < 0 || !loc || !it.location || key_(loc) === key_(it.location)) { rowIdx = i; break; }
  }
  if (rowIdx < 0 && it.delta <= 0) return { ok: false, error: 'Row not found in the sheet' };
  if (rowIdx < 0) {
    for (let i = h + 2; i < totalRow; i++) if (!String(values[i][0]).trim()) { rowIdx = i; break; }
    if (rowIdx < 0) {
      // No empty row: insert one inside the table (above the last data row, so the Total formulas' ranges
      // grow to include it), copy formats/formulas from the row above, then blank it.
      // totalRow is 0-based, so 1-based rows: last data row = totalRow, row above it = totalRow - 1.
      sheet.insertRowAfter(totalRow - 1);            // new blank row is now 1-based row `totalRow`
      const lastCol = sheet.getLastColumn();
      sheet.getRange(totalRow - 1, 1, 1, lastCol).copyTo(sheet.getRange(totalRow, 1, 1, lastCol));
      rowIdx = totalRow - 1;                          // 0-based index of the new row
      clearDataCells_(sheet, totalRow, header, locCol, dateCols);
    }
    sheet.getRange(rowIdx + 1, 1).setValue(it.name);
  }
  if (locCol >= 0 && it.location && !String(sheet.getRange(rowIdx + 1, locCol + 1).getValue()).trim()) {
    sheet.getRange(rowIdx + 1, locCol + 1).setValue(it.location);
  }
  const cell = sheet.getRange(rowIdx + 1, dateCol + 1);
  const value = Math.max(0, Math.round(((Number(cell.getValue()) || 0) + Number(it.delta)) * 100) / 100);
  cell.setValue(value);
  return { ok: true, tab: sheet.getName(), row: rowIdx + 1, value: value, created_tab: createdTab };
}

/** The weekly summary tab that has a column for this date: { sheet, h (header row index), dateCol } */
function findWeekTab_(ss, date, fmt) {
  for (const sheet of ss.getSheets()) {
    const top = sheet.getRange(1, 1, Math.min(6, sheet.getMaxRows()), Math.min(20, sheet.getMaxColumns())).getValues();
    const h = top.findIndex((r) => /name of recorder/i.test(String(r[0])));
    if (h < 0) continue;
    const dateCol = top[h].findIndex((c) => (c instanceof Date ? fmt(c) : parseDate_(c)) === date);
    if (dateCol > 0) return { sheet: sheet, h: h, dateCol: dateCol };
  }
  return null;
}

/** New week: copy the most recent summary tab, set Mon–Fri dates, clear names/hours/locations. */
function createWeekTab_(ss, date, fmt) {
  const d = new Date(date + 'T12:00:00');
  const dow = d.getDay(); // 0 Sun … 6 Sat
  if (dow === 0 || dow === 6) return { error: 'Weekly tabs only have Monday–Friday columns' };
  const monday = new Date(d); monday.setDate(d.getDate() - (dow - 1));
  let template = null, latest = '';
  for (const sheet of ss.getSheets()) {
    const top = sheet.getRange(1, 1, Math.min(6, sheet.getMaxRows()), Math.min(20, sheet.getMaxColumns())).getValues();
    const h = top.findIndex((r) => /name of recorder/i.test(String(r[0])));
    if (h < 0) continue;
    const dates = top[h].map((c) => (c instanceof Date ? fmt(c) : parseDate_(c))).filter(Boolean).sort();
    if (dates.length && dates[dates.length - 1] > latest) { latest = dates[dates.length - 1]; template = { sheet: sheet, h: h }; }
  }
  if (!template) return { error: 'No weekly Summary tab to copy' };
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const md = (x) => Utilities.formatDate(x, Session.getScriptTimeZone(), 'MM/dd');
  const sheet = template.sheet.copyTo(ss).setName(`Summary ${md(monday)} - ${md(sunday)}`);
  ss.setActiveSheet(sheet); ss.moveActiveSheet(ss.getNumSheets());
  const values = sheet.getDataRange().getValues();
  const h = template.h;
  const header = values[h].map((x) => String(x).trim());
  const dateCols = values[h].map((c, i) => ((c instanceof Date || parseDate_(c)) ? i : -1)).filter((i) => i > 0);
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  dateCols.slice(0, 5).forEach((ci, n) => {
    const day = new Date(monday); day.setDate(monday.getDate() + n);
    sheet.getRange(h + 1, ci + 1).setValue(day);
    const below = sheet.getRange(h + 2, ci + 1);
    if (!below.getFormula()) below.setValue(days[n]);
  });
  const locCol = header.findIndex((x) => /^location$/i.test(x));
  let totalRow = values.findIndex((r, i) => i > h && /^total$/i.test(String(r[0]).trim()));
  if (totalRow < 0) totalRow = values.length;
  for (let i = h + 2; i < totalRow; i++) clearDataCells_(sheet, i + 1, header, locCol, dateCols);
  const wanted = fmt(d);
  const dateCol = dateCols.find((ci) => { const v = sheet.getRange(h + 1, ci + 1).getValue(); return (v instanceof Date ? fmt(v) : parseDate_(v)) === wanted; });
  if (dateCol == null) return { error: 'Could not set up the new week tab' };
  return { sheet: sheet, h: h, dateCol: dateCol };
}

/** Empty a data row: name, hours (0), ID and LOCATION. Formula cells (totals) are left alone. */
function clearDataCells_(sheet, sheetRow, header, locCol, dateCols) {
  const cols = dateCols || header.map((x, i) => i).filter((i) => i > 0 && i < header.length);
  sheet.getRange(sheetRow, 1).clearContent();
  for (const ci of cols) {
    const cell = sheet.getRange(sheetRow, ci + 1);
    if (cell.getFormula()) continue;
    if (dateCols) { cell.setValue(0); cell.setBackground(null); }
  }
  const idCol = header.findIndex((x) => /^id$/i.test(x));
  if (idCol >= 0) sheet.getRange(sheetRow, idCol + 1).clearContent();
  if (locCol >= 0) sheet.getRange(sheetRow, locCol + 1).clearContent();
}

function parseDate_(v) {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${('0' + m[1]).slice(-2)}-${('0' + m[2]).slice(-2)}` : null;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
