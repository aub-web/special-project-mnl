import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, getSettings, resolveRecorder, resolveLocation, addAlias } from './db.js';

const app = express();
const root = dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(root, 'public')));

// Amounts are always derived from hours × rate × fx stored on each session,
// so changing the default rate in Settings never rewrites past pay.
const USD = 'ROUND(s.hours * s.rate_usd, 2)';
const PHP = 'ROUND(s.hours * s.rate_usd * s.fx_rate, 2)';

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    console.error(e);
    res.status(e.status || 400).json({ error: e.message });
  }
};
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function sessionFilters(q) {
  const where = [], params = [];
  if (q.from) { where.push('s.date >= ?'); params.push(q.from); }
  if (q.to) { where.push('s.date <= ?'); params.push(q.to); }
  if (q.recorder_id) { where.push('s.recorder_id = ?'); params.push(Number(q.recorder_id)); }
  if (q.location_id) { where.push('s.location_id = ?'); params.push(Number(q.location_id)); }
  if (q.category) { where.push('s.category = ?'); params.push(q.category); }
  if (q.q) { where.push('(r.name LIKE ? OR l.name LIKE ? OR s.notes LIKE ?)'); params.push(...Array(3).fill(`%${q.q}%`)); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// ---------- Settings ----------
app.get('/api/settings', wrap(() => getSettings()));
app.put('/api/settings', wrap((req) => {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(req.body)) up.run(k, String(v));
  return getSettings();
}));

// ---------- Recorders ----------
app.get('/api/recorders', wrap(() => db.prepare(`
  SELECT r.*, COUNT(s.id) AS sessions, COALESCE(SUM(s.hours),0) AS hours,
         COALESCE(SUM(${PHP}),0) AS php, MAX(s.date) AS last_date,
         (SELECT GROUP_CONCAT(alias, ' · ') FROM recorder_aliases a WHERE a.recorder_id = r.id) AS aliases
  FROM recorders r LEFT JOIN sessions s ON s.recorder_id = r.id
  GROUP BY r.id ORDER BY r.name`).all()));

app.post('/api/recorders', wrap((req) => {
  const { name } = req.body;
  if (!name?.trim()) throw fail('Name is required');
  const id = resolveRecorder(name);
  return db.prepare('SELECT * FROM recorders WHERE id = ?').get(id);
}));

app.put('/api/recorders/:id', wrap((req) => {
  const f = ['name', 'app_account', 'payout_account_no', 'payout_account_name', 'contact', 'active', 'notes'];
  const sets = f.filter((k) => k in req.body);
  if (!sets.length) throw fail('Nothing to update');
  db.prepare(`UPDATE recorders SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...sets.map((k) => req.body[k]), Number(req.params.id));
  return db.prepare('SELECT * FROM recorders WHERE id = ?').get(Number(req.params.id));
}));

// Merge a duplicate into another recorder: moves sessions/payments, keeps the old name as an alias.
app.post('/api/recorders/:id/merge', wrap((req) => {
  const from = Number(req.params.id), into = Number(req.body.into);
  if (!into || from === into) throw fail('Choose a different recorder to merge into');
  return tx(() => {
    const old = db.prepare('SELECT * FROM recorders WHERE id = ?').get(from);
    if (!old) throw fail('Recorder not found', 404);
    db.prepare('UPDATE sessions SET recorder_id = ? WHERE recorder_id = ?').run(into, from);
    db.prepare('UPDATE OR IGNORE payments SET recorder_id = ? WHERE recorder_id = ?').run(into, from);
    db.prepare('DELETE FROM payments WHERE recorder_id = ?').run(from);
    db.prepare('UPDATE followups SET recorder_id = ? WHERE recorder_id = ?').run(into, from);
    db.prepare('UPDATE recorder_aliases SET recorder_id = ? WHERE recorder_id = ?').run(into, from);
    for (const k of ['app_account', 'payout_account_no', 'payout_account_name', 'contact']) {
      if (old[k]) db.prepare(`UPDATE recorders SET ${k} = COALESCE(${k}, ?) WHERE id = ?`).run(old[k], into);
    }
    db.prepare('DELETE FROM recorders WHERE id = ?').run(from);
    addAlias(old.name, into);
    return { ok: true };
  });
}));

// ---------- Locations ----------
app.get('/api/locations', wrap(() => db.prepare(`
  SELECT l.*, COUNT(s.id) AS sessions, COALESCE(SUM(s.hours),0) AS hours, COALESCE(SUM(${PHP}),0) AS php,
         MIN(s.date) AS first_date, MAX(s.date) AS last_date, COUNT(DISTINCT s.recorder_id) AS recorders
  FROM locations l LEFT JOIN sessions s ON s.location_id = l.id
  GROUP BY l.id ORDER BY last_date DESC`).all()));
app.post('/api/locations', wrap((req) => {
  if (!req.body.name?.trim()) throw fail('Name is required');
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(resolveLocation(req.body.name));
}));
app.put('/api/locations/:id', wrap((req) => {
  db.prepare('UPDATE locations SET name = COALESCE(?, name), notes = COALESCE(?, notes) WHERE id = ?')
    .run(req.body.name ?? null, req.body.notes ?? null, Number(req.params.id));
  return { ok: true };
}));

app.post('/api/locations/:id/merge', wrap((req) => {
  const from = Number(req.params.id), into = Number(req.body.into);
  if (!into || from === into) throw fail('Choose a different location to merge into');
  return tx(() => {
    db.prepare('UPDATE sessions SET location_id = ? WHERE location_id = ?').run(into, from);
    db.prepare('DELETE FROM locations WHERE id = ?').run(from);
    return { ok: true };
  });
}));

// ---------- Sessions ----------
const SESSION_SELECT = `
  SELECT s.*, r.name AS recorder, l.name AS location, ${USD} AS usd, ${PHP} AS php
  FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id`;

app.get('/api/sessions', wrap((req) => {
  const { sql, params } = sessionFilters(req.query);
  return db.prepare(`${SESSION_SELECT} ${sql} ORDER BY s.date DESC, l.name, r.name LIMIT 5000`).all(...params);
}));

function sessionValues(b, defaults) {
  const hours = Number(b.hours);
  if (!(hours > 0 && hours <= 24)) throw fail('Hours must be between 0 and 24');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw fail('Date is required');
  const recorderId = b.recorder_id ? Number(b.recorder_id) : resolveRecorder(b.recorder || '');
  if (!recorderId) throw fail('Recorder is required');
  return [
    recorderId,
    b.location_id ? Number(b.location_id) : resolveLocation(b.location),
    b.date, hours, b.category || 'Studio', b.shift || null,
    Number(b.rate_usd ?? defaults.rate_usd), Number(b.fx_rate ?? defaults.fx_rate),
    b.notes || null,
  ];
}

app.post('/api/sessions', wrap((req) => {
  const v = sessionValues(req.body, getSettings());
  const id = db.prepare(`INSERT INTO sessions (recorder_id, location_id, date, hours, category, shift, rate_usd, fx_rate, notes, source)
    VALUES (?,?,?,?,?,?,?,?,?, 'web')`).run(...v).lastInsertRowid;
  return db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
}));

// Daily log: one date + location, many recorders — mirrors the per-day sheets.
app.post('/api/sessions/bulk', wrap((req) => {
  const { date, location, category, rows = [] } = req.body;
  const defaults = getSettings();
  const filled = rows.filter((r) => (r.recorder || '').trim() && Number(r.hours) > 0);
  if (!filled.length) throw fail('Add at least one recorder with hours');
  const ins = db.prepare(`INSERT INTO sessions (recorder_id, location_id, date, hours, category, shift, rate_usd, fx_rate, notes, source)
    VALUES (?,?,?,?,?,?,?,?,?, 'web')`);
  return tx(() => {
    for (const r of filled) ins.run(...sessionValues({ ...r, date, location, category }, defaults));
    return { inserted: filled.length };
  });
}));

app.put('/api/sessions/:id', wrap((req) => {
  const cur = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw fail('Session not found', 404);
  const v = sessionValues({ ...cur, ...req.body }, cur);
  db.prepare(`UPDATE sessions SET recorder_id=?, location_id=?, date=?, hours=?, category=?, shift=?, rate_usd=?, fx_rate=?, notes=? WHERE id=?`)
    .run(...v, cur.id);
  return db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(cur.id);
}));

app.delete('/api/sessions/:id', wrap((req) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

// ---------- Summary (the "Summary MM/DD - MM/DD" sheet, generated) ----------
function buildSummary({ from, to, category, location_id, period_id }) {
  if (!from || !to) throw fail('from and to are required');
  const { sql, params } = sessionFilters({ from, to, category, location_id });
  const rows = db.prepare(`
    SELECT s.recorder_id, r.name, r.payout_account_no, s.date, SUM(s.hours) AS hours, SUM(${USD}) AS usd, SUM(${PHP}) AS php,
           GROUP_CONCAT(DISTINCT l.name) AS locations
    FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id
    ${sql} GROUP BY s.recorder_id, s.date ORDER BY r.name`).all(...params);

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const payments = period_id
    ? Object.fromEntries(db.prepare('SELECT * FROM payments WHERE period_id = ?').all(Number(period_id)).map((p) => [p.recorder_id, p]))
    : {};
  const byRec = new Map();
  for (const r of rows) {
    if (!byRec.has(r.recorder_id)) {
      byRec.set(r.recorder_id, { recorder_id: r.recorder_id, name: r.name, payout_account_no: r.payout_account_no,
        by_date: {}, hours: 0, usd: 0, php: 0, locations: new Set(), payment: payments[r.recorder_id] || null });
    }
    const o = byRec.get(r.recorder_id);
    o.by_date[r.date] = r.hours;
    o.hours += r.hours; o.usd += r.usd; o.php += r.php;
    (r.locations || '').split(',').filter(Boolean).forEach((l) => o.locations.add(l));
  }
  const list = [...byRec.values()].map((o) => ({ ...o, locations: [...o.locations] }));
  const totals = {
    by_date: Object.fromEntries(dates.map((d) => [d, rows.filter((r) => r.date === d).reduce((a, r) => a + r.hours, 0)])),
    hours: list.reduce((a, r) => a + r.hours, 0),
    usd: list.reduce((a, r) => a + r.usd, 0),
    php: list.reduce((a, r) => a + r.php, 0),
    paid_php: list.reduce((a, r) => a + (r.payment?.status === 'Paid' ? r.payment.amount_php : 0), 0),
  };
  return { from, to, dates, rows: list, totals };
}
app.get('/api/summary', wrap((req) => buildSummary(req.query)));

app.get('/api/summary.csv', wrap((req, res) => {
  const s = buildSummary(req.query);
  const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ''));
  const lines = [['Name of Recorder', ...s.dates, 'Total in Hours', 'USD Earned', 'PH Earned', 'Locations', 'Payout Account'].map(esc).join(',')];
  for (const r of s.rows) {
    lines.push([r.name, ...s.dates.map((d) => r.by_date[d] || 0), r.hours, r.usd.toFixed(2), r.php.toFixed(2), r.locations.join(' / '), r.payout_account_no].map(esc).join(','));
  }
  lines.push(['Total', ...s.dates.map((d) => s.totals.by_date[d]), s.totals.hours, s.totals.usd.toFixed(2), s.totals.php.toFixed(2)].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${s.from}_to_${s.to}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

// ---------- Pay periods & payments ----------
app.get('/api/periods', wrap(() => db.prepare(`
  SELECT p.*,
    (SELECT COALESCE(SUM(s.hours),0) FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS hours,
    (SELECT COALESCE(SUM(${PHP}),0) FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS php,
    (SELECT COUNT(DISTINCT s.recorder_id) FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS recorders,
    (SELECT COALESCE(SUM(amount_php),0) FROM payments x WHERE x.period_id = p.id AND x.status = 'Paid') AS paid_php
  FROM periods p ORDER BY p.start_date DESC`).all()));

app.post('/api/periods', wrap((req) => {
  const { name, start_date, end_date, notes } = req.body;
  if (!start_date || !end_date || start_date > end_date) throw fail('Valid start and end dates are required');
  const id = db.prepare('INSERT INTO periods (name, start_date, end_date, notes) VALUES (?,?,?,?)')
    .run(name || `${start_date} – ${end_date}`, start_date, end_date, notes || null).lastInsertRowid;
  return db.prepare('SELECT * FROM periods WHERE id = ?').get(id);
}));
app.put('/api/periods/:id', wrap((req) => {
  const f = ['name', 'start_date', 'end_date', 'status', 'notes'].filter((k) => k in req.body);
  db.prepare(`UPDATE periods SET ${f.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...f.map((k) => req.body[k]), Number(req.params.id));
  return db.prepare('SELECT * FROM periods WHERE id = ?').get(Number(req.params.id));
}));
app.delete('/api/periods/:id', wrap((req) => {
  db.prepare('DELETE FROM periods WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

app.put('/api/periods/:id/payments/:recorderId', wrap((req) => {
  const { amount_php, status = 'Paid', account_no, reference, paid_at, notes } = req.body;
  db.prepare(`INSERT INTO payments (period_id, recorder_id, amount_php, status, account_no, reference, paid_at, notes)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(period_id, recorder_id) DO UPDATE SET amount_php=excluded.amount_php, status=excluded.status,
      account_no=excluded.account_no, reference=excluded.reference, paid_at=excluded.paid_at, notes=excluded.notes`)
    .run(Number(req.params.id), Number(req.params.recorderId), Number(amount_php) || 0, status,
      account_no || null, reference || null, paid_at || new Date().toISOString().slice(0, 10), notes || null);
  return { ok: true };
}));
app.delete('/api/periods/:id/payments/:recorderId', wrap((req) => {
  db.prepare('DELETE FROM payments WHERE period_id = ? AND recorder_id = ?').run(Number(req.params.id), Number(req.params.recorderId));
  return { ok: true };
}));

// ---------- Follow-ups ----------
app.get('/api/followups', wrap(() => db.prepare(`
  SELECT f.*, r.name AS recorder FROM followups f LEFT JOIN recorders r ON r.id = f.recorder_id
  ORDER BY f.status = 'Resolved', f.created_at DESC`).all()));
const FU = ['recorder_id', 'description', 'expected_php', 'received_php', 'old_account_no', 'old_account_name', 'new_account_no', 'new_account_name', 'status', 'notes'];
app.post('/api/followups', wrap((req) => {
  const b = { ...req.body };
  if (b.recorder && !b.recorder_id) b.recorder_id = resolveRecorder(b.recorder);
  const id = db.prepare(`INSERT INTO followups (${FU.join(',')}) VALUES (${FU.map(() => '?').join(',')})`)
    .run(...FU.map((k) => b[k] ?? (k === 'status' ? 'Open' : null))).lastInsertRowid;
  return { id };
}));
app.put('/api/followups/:id', wrap((req) => {
  const f = FU.filter((k) => k in req.body);
  db.prepare(`UPDATE followups SET ${f.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...f.map((k) => req.body[k]), Number(req.params.id));
  return { ok: true };
}));
app.delete('/api/followups/:id', wrap((req) => {
  db.prepare('DELETE FROM followups WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

// ---------- Dashboard ----------
app.get('/api/dashboard', wrap(() => {
  const totals = db.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(hours),0) hours, COALESCE(SUM(${USD}),0) usd, COALESCE(SUM(${PHP}),0) php,
    COUNT(DISTINCT recorder_id) recorders, COUNT(DISTINCT location_id) locations, MIN(date) first_date, MAX(date) last_date FROM sessions s`).get();
  const byWeek = db.prepare(`SELECT date(s.date, '-' || ((strftime('%w', s.date) + 6) % 7) || ' days') AS week,
      SUM(hours) hours, SUM(${PHP}) php, COUNT(DISTINCT recorder_id) recorders
    FROM sessions s GROUP BY week ORDER BY week`).all();
  const byCategory = db.prepare(`SELECT category, SUM(hours) hours, SUM(${PHP}) php FROM sessions s GROUP BY category ORDER BY hours DESC`).all();
  const byLocation = db.prepare(`SELECT COALESCE(l.name,'—') name, SUM(s.hours) hours, SUM(${PHP}) php
    FROM sessions s LEFT JOIN locations l ON l.id = s.location_id GROUP BY s.location_id ORDER BY hours DESC`).all();
  const topRecorders = db.prepare(`SELECT r.id, r.name, SUM(s.hours) hours, SUM(${PHP}) php, COUNT(DISTINCT s.date) days
    FROM sessions s JOIN recorders r ON r.id = s.recorder_id GROUP BY r.id ORDER BY hours DESC LIMIT 10`).all();
  const openFollowups = db.prepare(`SELECT COUNT(*) n FROM followups WHERE status != 'Resolved'`).get().n;
  const openPeriods = db.prepare(`SELECT COUNT(*) n FROM periods WHERE status = 'Open'`).get().n;
  return { totals, byWeek, byCategory, byLocation, topRecorders, openFollowups, openPeriods };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(join(root, 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Studio Payout running at http://localhost:${PORT}`));
