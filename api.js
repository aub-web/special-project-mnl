// Express app with every /api route. Used by server.js locally and by the Netlify Function in production.
import express from 'express';
import { pool, q, one, tx, migrate, getSettings, resolveRecorder, resolveLocation, addAlias } from './db.js';
import { requireUser, requireAdmin, login, signup, setSessionCookie, clearSessionCookie, hashPassword, PUBLIC_USER } from './auth.js';
import { router as businessRoutes } from './businesses.js';
import { router as recorderSyncRoutes, driveUrl } from './recorders-sync.js';
import { router as payoutSyncRoutes } from './payout-sync.js';
import { router as registrationRoutes, publicRouter as registrationPublicRoutes } from './registrations.js';

export const app = express();
app.use(express.json({ limit: '8mb' })); // room for an uploaded .xlsx (base64)

// Netlify forwards /api/* to /.netlify/functions/api/* — map it back so routes match either way.
app.use((req, res, next) => {
  if (req.url.startsWith('/.netlify/functions/api')) req.url = '/api' + req.url.slice('/.netlify/functions/api'.length);
  next();
});
app.use('/api', async (req, res, next) => {
  try { await migrate(); next(); } catch (e) { next(e); }
});

// Amounts are always derived from hours × the ₱ rate stored on each session,
// so changing the default rate in Settings never rewrites past pay.
const PHP = 'ROUND((s.hours * s.rate_php)::numeric, 2)::float8';

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

/** Collects positional params: p(v) pushes v and returns its "$n" placeholder. */
function params() {
  const list = [];
  const p = (v) => { list.push(v); return '$' + list.length; };
  p.list = list;
  return p;
}

function sessionFilters(qry, p) {
  const where = [];
  if (qry.from) where.push(`s.date >= ${p(qry.from)}`);
  if (qry.to) where.push(`s.date <= ${p(qry.to)}`);
  if (qry.recorder_id) where.push(`s.recorder_id = ${p(Number(qry.recorder_id))}`);
  if (qry.location_id) where.push(`s.location_id = ${p(Number(qry.location_id))}`);
  if (qry.category) where.push(`s.category = ${p(qry.category)}`);
  if (qry.q) {
    const like = p(`%${qry.q}%`);
    where.push(`(r.name ILIKE ${like} OR l.name ILIKE ${like} OR s.notes ILIKE ${like})`);
  }
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

/** UPDATE table SET <allowed fields present in body> WHERE id = :id */
async function updateFields(table, id, body, allowed, db = pool) {
  const p = params();
  const sets = allowed.filter((k) => k in body).map((k) => `${k} = ${p(toNull(body[k]))}`);
  if (!sets.length) throw fail('Nothing to update');
  await q(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ${p(Number(id))}`, p.list, db);
}

// ---------- Auth (public) ----------
app.post('/api/auth/login', wrap(async (req, res) => {
  const user = await login(req.body.email, req.body.password);
  setSessionCookie(res, user);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}));
app.post('/api/auth/signup', wrap(async (req, res) => {
  const { admin_emails = '' } = await getSettings();
  const user = await signup(req.body, String(admin_emails).split(/[,\s]+/).filter(Boolean));
  if (!user.approved) return { pending: true };
  setSessionCookie(res, user);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}));
app.post('/api/auth/logout', wrap((req, res) => { clearSessionCookie(res); return { ok: true }; }));

// Public recorder registration form (key-protected; never writes to recorders directly).
app.use('/api', registrationPublicRoutes);

// Everything below needs a signed-in user.
app.use('/api', requireUser);

// ---------- Access matrix ----------
//   admin         everything
//   sdr           dashboard + businesses
//   set_director  log hours + sessions, never sees money (amounts are stripped server-side)
//   recorder      only their own profile, sessions and pay (/me/recorder)
// Rules are [method, path, exact?]; '*' matches any method. Admin skips the check.
export const ROLES = ['admin', 'sdr', 'set_director', 'recorder'];
const ACCESS = {
  sdr: [['GET', '/dashboard', true], ['*', '/businesses'], ['*', '/business-shifts'], ['GET', '/locations', true], ['GET', '/settings', true]],
  set_director: [['GET', '/recorders', true], ['GET', '/locations', true], ['GET', '/sessions', true], ['POST', '/sessions/bulk', true],
    ['PUT', '/sessions/'], ['DELETE', '/sessions/'], ['GET', '/settings', true]],
  recorder: [['GET', '/me/recorder', true], ['GET', '/files/']], // files: own only (checked in registrations.js)
};
const hidesMoney = (req) => req.user.role === 'set_director';
app.use('/api', (req, res, next) => {
  const { role } = req.user;
  if (role === 'admin' || req.path.startsWith('/auth/')) return next();
  const ok = (ACCESS[role] || []).some(([m, path, exact]) =>
    (m === '*' || m === req.method) && (exact ? req.path === path : req.path.startsWith(path)));
  if (!ok) return res.status(403).json({ error: "Your role doesn't have access to this." });
  next();
});

app.use('/api', businessRoutes);
app.use('/api', recorderSyncRoutes);
app.use('/api', payoutSyncRoutes);
app.use('/api', registrationRoutes);
app.get('/api/auth/me', wrap((req) => req.user));

app.post('/api/auth/password', wrap(async (req) => {
  const { current, password } = req.body;
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const { verifyPassword } = await import('./auth.js');
  if (!(await verifyPassword(String(current || ''), u.password_hash))) throw fail('Current password is wrong');
  if (String(password || '').length < 10) throw fail('New password must be at least 10 characters');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), req.user.id]);
  return { ok: true };
}));

// ---------- Users (admin) ----------
// email_recorders: recorders whose sheet email matches this login — that's who a Recorder login sees.
app.get('/api/users', requireAdmin, wrap(() => q(`
  SELECT ${PUBLIC_USER.split(', ').map((c) => 'u.' + c).join(', ')},
         (SELECT string_agg(name, ', ' ORDER BY name) FROM recorders r WHERE lower(r.email) = lower(u.email)) AS email_recorders,
         (SELECT COUNT(*)::int FROM recorders r WHERE lower(r.email) = lower(u.email)) AS email_recorder_count
  FROM users u
  ORDER BY u.approved, u.name`)));
app.get('/api/users/pending-count', wrap(async (req) =>
  req.user.role === 'admin' ? one('SELECT COUNT(*)::int AS n FROM users WHERE NOT approved') : { n: 0 }));
// Reject a sign-up / remove a login. Their logged sessions stay (created_by is cleared).
app.delete('/api/users/:id', requireAdmin, wrap(async (req) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw fail("You can't delete yourself");
  await q('UPDATE sessions SET created_by = NULL WHERE created_by = $1', [id]);
  await q('DELETE FROM users WHERE id = $1', [id]);
  return { ok: true };
}));
app.post('/api/users', requireAdmin, wrap(async (req) => {
  const { email, name, password, role = 'set_director' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '')) throw fail('Valid email is required');
  if (String(password || '').length < 10) throw fail('Password must be at least 10 characters');
  if (!ROLES.includes(role)) throw fail('Unknown role');
  if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])) throw fail('That email already has an account');
  return one(`INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING ${PUBLIC_USER}`,
    [email.trim(), (name || email).trim(), await hashPassword(password), role]);
}));
app.put('/api/users/:id', requireAdmin, wrap(async (req) => {
  const id = Number(req.params.id);
  const body = { ...req.body };
  if (id === req.user.id && (body.active === false || (body.role && body.role !== 'admin'))) throw fail("You can't demote or disable yourself");
  if (body.role !== undefined && !ROLES.includes(body.role)) throw fail('Unknown role');
  if (body.password) {
    if (String(body.password).length < 10) throw fail('Password must be at least 10 characters');
    body.password_hash = await hashPassword(body.password);
  }
  // Recorder logins are linked by email (see recorderForEmail), so there's no recorder_id to set.
  await updateFields('users', id, body, ['name', 'email', 'role', 'active', 'approved', 'password_hash']);
  return one(`SELECT ${PUBLIC_USER} FROM users WHERE id = $1`, [id]);
}));

// ---------- My hours (recorder role) ----------
// A recorder login is linked automatically: it shows the recorder whose email (from the recorder sheet)
// matches the login email. Ambiguous emails are refused rather than guessed.
async function recorderForEmail(email) {
  const matches = await q('SELECT id, name FROM recorders WHERE lower(email) = lower($1)', [email]);
  if (!matches.length) {
    throw fail(`No recorder in the recorder sheet uses ${email}. Ask the studio admin to put this email on your row in the sheet and sync.`, 404);
  }
  if (matches.length > 1) {
    throw fail(`${email} is listed for more than one recorder (${matches.map((m) => m.name).join(', ')}). Ask the studio admin to fix the recorder sheet.`, 409);
  }
  return matches[0].id;
}

app.get('/api/me/recorder', wrap(async (req) => {
  const rid = await recorderForEmail(req.user.email);
  const [profile, sessions, periods] = await Promise.all([
    one(`SELECT id, name, email, contact, payment_method, payout_account_no, contract, contract_url, contract_hard_copy, contract_status, id_document, id_document_url,
      (SELECT COALESCE(json_agg(json_build_object('id', f.id, 'kind', f.kind, 'filename', f.filename) ORDER BY f.kind, f.id), '[]')
         FROM recorder_files f WHERE f.recorder_id = recorders.id) AS files
      FROM recorders WHERE id = $1`, [rid]),
    q(`${SESSION_SELECT} WHERE s.recorder_id = $1 ORDER BY s.date DESC`, [rid]),
    q(`SELECT p.id, p.name, p.start_date, p.end_date, p.status,
              COALESCE(SUM(s.hours),0) AS hours, COALESCE(SUM(${PHP}),0) AS php,
              x.status AS payment_status, x.amount_php AS paid_php, x.paid_at, x.reference
       FROM periods p
       JOIN sessions s ON s.recorder_id = $1 AND s.date BETWEEN p.start_date AND p.end_date
       LEFT JOIN payments x ON x.period_id = p.id AND x.recorder_id = $1
       GROUP BY p.id, x.id ORDER BY p.start_date DESC`, [rid]),
  ]);
  // Recorders only see their own sessions; drop internal fields.
  for (const s of sessions) { delete s.created_by; delete s.source; delete s.recorder_id; }
  return { profile, sessions, periods };
}));

// ---------- Settings ----------
app.get('/api/settings', wrap(async (req) => {
  const s = await getSettings();
  if (req.user.role === 'admin') return s;
  // Non-admins only get what their pages need; never rates for set directors.
  return req.user.role === 'sdr' ? { business_rate_php: s.business_rate_php } : {};
}));
app.put('/api/settings', requireAdmin, wrap(async (req) => {
  for (const [k, v] of Object.entries(req.body)) {
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [k, String(v)]);
  }
  return getSettings();
}));

// ---------- Recorders ----------
app.get('/api/recorders', wrap((req) => {
  // Set directors only need names for the log form — no contact, account or pay details.
  if (hidesMoney(req)) return q('SELECT id, name, active FROM recorders ORDER BY name');
  return q(`
  SELECT r.*, COUNT(s.id)::int AS sessions, COALESCE(SUM(s.hours),0) AS hours,
         COALESCE(SUM(${PHP}),0) AS php, MAX(s.date) AS last_date,
         (SELECT string_agg(alias, ' · ') FROM recorder_aliases a WHERE a.recorder_id = r.id) AS aliases,
         (SELECT COUNT(*)::int FROM recorder_files f WHERE f.recorder_id = r.id AND f.kind = 'id') AS id_files,
         (SELECT COUNT(*)::int FROM recorder_files f WHERE f.recorder_id = r.id AND f.kind = 'esign') AS esign_files
  FROM recorders r LEFT JOIN sessions s ON s.recorder_id = r.id
  GROUP BY r.id ORDER BY r.name`);
}));

app.post('/api/recorders', wrap(async (req) => {
  if (!req.body.name?.trim()) throw fail('Name is required');
  return one('SELECT * FROM recorders WHERE id = $1', [await resolveRecorder(req.body.name)]);
}));

app.put('/api/recorders/:id', wrap(async (req) => {
  // Document links must be Google Drive/Docs URLs (they're rendered as links for admins).
  for (const k of ['id_document_url', 'contract_url']) {
    if (req.body[k] && !driveUrl(req.body[k])) throw fail('Document links must be Google Drive or Google Docs links (https://drive.google.com/…)');
  }
  if ('contract_status' in req.body && !['Done', 'Pending'].includes(req.body.contract_status)) throw fail('Contract must be Done or Pending');
  await updateFields('recorders', req.params.id, req.body,
    ['name', 'app_account', 'payout_account_no', 'payout_account_name', 'payment_method', 'contact', 'email', 'address',
      'id_document', 'id_document_url', 'contract', 'contract_url', 'contract_hard_copy', 'contract_status', 'active', 'notes']);
  return one('SELECT * FROM recorders WHERE id = $1', [Number(req.params.id)]);
}));

// Merge a duplicate into another recorder: moves sessions/payments, keeps the old name as an alias.
app.post('/api/recorders/:id/merge', wrap(async (req) => {
  const from = Number(req.params.id), into = Number(req.body.into);
  if (!into || from === into) throw fail('Choose a different recorder to merge into');
  return tx(async (c) => {
    const old = await one('SELECT * FROM recorders WHERE id = $1', [from], c);
    if (!old) throw fail('Recorder not found', 404);
    await q('UPDATE sessions SET recorder_id = $1 WHERE recorder_id = $2', [into, from], c);
    // A period can only have one payment per person: keep the target's if both exist.
    await q(`DELETE FROM payments WHERE recorder_id = $2 AND period_id IN (SELECT period_id FROM payments WHERE recorder_id = $1)`, [into, from], c);
    await q('UPDATE payments SET recorder_id = $1 WHERE recorder_id = $2', [into, from], c);
    await q('UPDATE followups SET recorder_id = $1 WHERE recorder_id = $2', [into, from], c);
    await q('UPDATE recorder_aliases SET recorder_id = $1 WHERE recorder_id = $2', [into, from], c);
    await q(`UPDATE recorders SET app_account = COALESCE(app_account, $2), payout_account_no = COALESCE(payout_account_no, $3),
             payout_account_name = COALESCE(payout_account_name, $4), contact = COALESCE(contact, $5) WHERE id = $1`,
      [into, old.app_account, old.payout_account_no, old.payout_account_name, old.contact], c);
    await q('DELETE FROM recorders WHERE id = $1', [from], c);
    await addAlias(old.name, into, c);
    return { ok: true };
  });
}));

// ---------- Locations ----------
app.get('/api/locations', wrap((req) => {
  if (hidesMoney(req)) return q('SELECT id, name FROM locations ORDER BY name');
  return q(`
  SELECT l.*, COUNT(s.id)::int AS sessions, COALESCE(SUM(s.hours),0) AS hours, COALESCE(SUM(${PHP}),0) AS php,
         MIN(s.date) AS first_date, MAX(s.date) AS last_date, COUNT(DISTINCT s.recorder_id)::int AS recorders
  FROM locations l LEFT JOIN sessions s ON s.location_id = l.id
  GROUP BY l.id ORDER BY last_date DESC NULLS LAST`);
}));
app.post('/api/locations', wrap(async (req) => {
  if (!req.body.name?.trim()) throw fail('Name is required');
  return one('SELECT * FROM locations WHERE id = $1', [await resolveLocation(req.body.name)]);
}));
app.put('/api/locations/:id', wrap(async (req) => {
  await updateFields('locations', req.params.id, req.body, ['name', 'notes']);
  return { ok: true };
}));
app.post('/api/locations/:id/merge', wrap(async (req) => {
  const from = Number(req.params.id), into = Number(req.body.into);
  if (!into || from === into) throw fail('Choose a different location to merge into');
  return tx(async (c) => {
    await q('UPDATE sessions SET location_id = $1 WHERE location_id = $2', [into, from], c);
    await q('DELETE FROM locations WHERE id = $1', [from], c);
    return { ok: true };
  });
}));

// ---------- Sessions ----------
const SESSION_SELECT = `
  SELECT s.*, r.name AS recorder, l.name AS location, ${PHP} AS php
  FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id`;

/** Remove every money field from session rows (set directors). */
function stripMoney(rows) {
  for (const s of [].concat(rows)) { delete s.php; delete s.rate_php; delete s.rate_usd; delete s.fx_rate; }
  return rows;
}

app.get('/api/sessions', wrap(async (req) => {
  const p = params();
  const where = sessionFilters(req.query, p);
  const rows = await q(`${SESSION_SELECT} ${where} ORDER BY s.date DESC, l.name, r.name LIMIT 5000`, p.list);
  return hidesMoney(req) ? stripMoney(rows) : rows;
}));

/** Set directors may only change sessions they logged themselves. */
async function editableSession(req) {
  const cur = await one('SELECT * FROM sessions WHERE id = $1', [Number(req.params.id)]);
  if (!cur) throw fail('Session not found', 404);
  if (req.user.role === 'set_director' && cur.created_by !== req.user.id) throw fail('You can only change sessions you logged', 403);
  return cur;
}

async function sessionValues(b, defaults, db) {
  const hours = Number(b.hours);
  if (!(hours > 0 && hours <= 24)) throw fail('Hours must be between 0 and 24');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw fail('Date is required');
  const recorderId = b.recorder_id ? Number(b.recorder_id) : await resolveRecorder(b.recorder || '', { db });
  if (!recorderId) throw fail('Recorder is required');
  return [
    recorderId,
    b.location_id ? Number(b.location_id) : await resolveLocation(b.location, db),
    b.date, hours, b.category || 'Studio', toNull(b.shift),
    Number(b.rate_php ?? defaults.rate_php),
    toNull(b.notes),
  ];
}
const INSERT_SESSION = `INSERT INTO sessions (recorder_id, location_id, date, hours, category, shift, rate_php, notes, source, created_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'web',$9) RETURNING id`;

app.post('/api/sessions', wrap(async (req) => {
  const v = await sessionValues(req.body, await getSettings());
  const { id } = await one(INSERT_SESSION, [...v, req.user.id]);
  return one(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
}));

// Daily log: one date + location, many recorders — mirrors the per-day sheets.
app.post('/api/sessions/bulk', wrap(async (req) => {
  const { date, location, category, rows = [] } = req.body;
  const filled = rows.filter((r) => (r.recorder || '').trim() && Number(r.hours) > 0);
  if (!filled.length) throw fail('Add at least one recorder with hours');
  return tx(async (c) => {
    const defaults = await getSettings(c);
    for (const r of filled) await q(INSERT_SESSION, [...(await sessionValues({ ...r, date, location, category }, defaults, c)), req.user.id], c);
    return { inserted: filled.length };
  });
}));

app.put('/api/sessions/:id', wrap(async (req) => {
  const cur = await editableSession(req);
  const body = { ...req.body };
  if (req.user.role !== 'admin') delete body.rate_php; // only admins change pay rates
  const v = await sessionValues({ ...cur, ...body }, cur);
  await q(`UPDATE sessions SET recorder_id=$1, location_id=$2, date=$3, hours=$4, category=$5, shift=$6, rate_php=$7, notes=$8 WHERE id=$9`,
    [...v, cur.id]);
  const row = await one(`${SESSION_SELECT} WHERE s.id = $1`, [cur.id]);
  return hidesMoney(req) ? stripMoney(row) : row;
}));

app.delete('/api/sessions/:id', wrap(async (req) => {
  await editableSession(req);
  await q('DELETE FROM sessions WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// ---------- Summary (the "Summary MM/DD - MM/DD" sheet, generated) ----------
async function buildSummary({ from, to, category, location_id, period_id }) {
  if (!from || !to) throw fail('from and to are required');
  const p = params();
  const where = sessionFilters({ from, to, category, location_id }, p);
  const rows = await q(`
    SELECT s.recorder_id, r.name, r.payout_account_no, r.id_document, r.id_document_url, s.date, SUM(s.hours) AS hours, SUM(${PHP}) AS php,
           string_agg(DISTINCT l.name, ',') AS locations
    FROM sessions s JOIN recorders r ON r.id = s.recorder_id LEFT JOIN locations l ON l.id = s.location_id
    ${where} GROUP BY s.recorder_id, r.name, r.payout_account_no, r.id_document, r.id_document_url, s.date ORDER BY r.name`, p.list);

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const payments = period_id
    ? Object.fromEntries((await q('SELECT * FROM payments WHERE period_id = $1', [Number(period_id)])).map((x) => [x.recorder_id, x]))
    : {};
  const byRec = new Map();
  for (const r of rows) {
    if (!byRec.has(r.recorder_id)) {
      byRec.set(r.recorder_id, { recorder_id: r.recorder_id, name: r.name, payout_account_no: r.payout_account_no, id_document: r.id_document, id_document_url: r.id_document_url,
        by_date: {}, hours: 0, php: 0, locations: new Set(), payment: payments[r.recorder_id] || null });
    }
    const o = byRec.get(r.recorder_id);
    o.by_date[r.date] = r.hours;
    o.hours += r.hours; o.php += r.php;
    (r.locations || '').split(',').filter(Boolean).forEach((l) => o.locations.add(l));
  }
  const list = [...byRec.values()].map((o) => ({ ...o, locations: [...o.locations] }));
  const totals = {
    by_date: Object.fromEntries(dates.map((d) => [d, rows.filter((r) => r.date === d).reduce((a, r) => a + r.hours, 0)])),
    hours: list.reduce((a, r) => a + r.hours, 0),
    php: list.reduce((a, r) => a + r.php, 0),
    paid_php: list.reduce((a, r) => a + (r.payment?.status === 'Paid' ? r.payment.amount_php : 0), 0),
  };
  return { from, to, dates, rows: list, totals };
}
app.get('/api/summary', wrap((req) => buildSummary(req.query)));

app.get('/api/summary.csv', wrap(async (req, res) => {
  const s = await buildSummary(req.query);
  const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ''));
  const lines = [['Name of Recorder', ...s.dates, 'Total in Hours', 'Rate', 'PH Earned', 'Locations', 'Payout Account'].map(esc).join(',')];
  for (const r of s.rows) {
    lines.push([r.name, ...s.dates.map((d) => r.by_date[d] || 0), r.hours, r.hours ? (r.php / r.hours).toFixed(2) : '', r.php.toFixed(2), r.locations.join(' / '), r.payout_account_no].map(esc).join(','));
  }
  lines.push(['Total', ...s.dates.map((d) => s.totals.by_date[d]), s.totals.hours, '', s.totals.php.toFixed(2)].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${s.from}_to_${s.to}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

// ---------- Pay periods & payments ----------
app.get('/api/periods', wrap(() => q(`
  SELECT p.*,
    (SELECT COALESCE(SUM(s.hours),0) FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS hours,
    (SELECT COALESCE(SUM(${PHP}),0) FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS php,
    (SELECT COUNT(DISTINCT s.recorder_id)::int FROM sessions s WHERE s.date BETWEEN p.start_date AND p.end_date) AS recorders,
    (SELECT COALESCE(SUM(amount_php),0) FROM payments x WHERE x.period_id = p.id AND x.status = 'Paid') AS paid_php
  FROM periods p ORDER BY p.start_date DESC`)));

app.post('/api/periods', wrap(async (req) => {
  const { name, start_date, end_date, notes } = req.body;
  if (!start_date || !end_date || start_date > end_date) throw fail('Valid start and end dates are required');
  return one('INSERT INTO periods (name, start_date, end_date, notes) VALUES ($1,$2,$3,$4) RETURNING *',
    [name || `${start_date} – ${end_date}`, start_date, end_date, toNull(notes)]);
}));
app.put('/api/periods/:id', wrap(async (req) => {
  await updateFields('periods', req.params.id, req.body, ['name', 'start_date', 'end_date', 'status', 'notes']);
  return one('SELECT * FROM periods WHERE id = $1', [Number(req.params.id)]);
}));
app.delete('/api/periods/:id', requireAdmin, wrap(async (req) => {
  await q('DELETE FROM periods WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

app.put('/api/periods/:id/payments/:recorderId', wrap(async (req) => {
  const { amount_php, status = 'Paid', account_no, reference, paid_at, notes } = req.body;
  await q(`INSERT INTO payments (period_id, recorder_id, amount_php, status, account_no, reference, paid_at, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (period_id, recorder_id) DO UPDATE SET amount_php=excluded.amount_php, status=excluded.status,
      account_no=excluded.account_no, reference=excluded.reference, paid_at=excluded.paid_at, notes=excluded.notes`,
    [Number(req.params.id), Number(req.params.recorderId), Number(amount_php) || 0, status,
      toNull(account_no), toNull(reference), paid_at || new Date().toISOString().slice(0, 10), toNull(notes)]);
  return { ok: true };
}));
app.delete('/api/periods/:id/payments/:recorderId', wrap(async (req) => {
  await q('DELETE FROM payments WHERE period_id = $1 AND recorder_id = $2', [Number(req.params.id), Number(req.params.recorderId)]);
  return { ok: true };
}));

// ---------- Follow-ups ----------
app.get('/api/followups', wrap(() => q(`
  SELECT f.*, r.name AS recorder FROM followups f LEFT JOIN recorders r ON r.id = f.recorder_id
  ORDER BY f.status = 'Resolved', f.created_at DESC`)));
const FU = ['recorder_id', 'description', 'expected_php', 'received_php', 'old_account_no', 'old_account_name', 'new_account_no', 'new_account_name', 'status', 'notes'];
app.post('/api/followups', wrap(async (req) => {
  const b = { ...req.body };
  if (b.recorder && !b.recorder_id) b.recorder_id = await resolveRecorder(b.recorder);
  return one(`INSERT INTO followups (${FU.join(',')}) VALUES (${FU.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
    FU.map((k) => toNull(b[k]) ?? (k === 'status' ? 'Open' : null)));
}));
app.put('/api/followups/:id', wrap(async (req) => {
  await updateFields('followups', req.params.id, req.body, FU);
  return { ok: true };
}));
app.delete('/api/followups/:id', wrap(async (req) => {
  await q('DELETE FROM followups WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// ---------- Dashboard ----------
app.get('/api/dashboard', wrap(async () => {
  const [totals, byWeek, byCategory, byLocation, topRecorders, fu, pr, bizTotals] = await Promise.all([
    one(`SELECT COUNT(*)::int sessions, COALESCE(SUM(hours),0) hours, COALESCE(SUM(${PHP}),0) php,
      COUNT(DISTINCT recorder_id)::int recorders, COUNT(DISTINCT location_id)::int locations, MIN(date) first_date, MAX(date) last_date FROM sessions s`),
    q(`SELECT to_char(date_trunc('week', s.date::date), 'YYYY-MM-DD') AS week,
         SUM(hours) hours, SUM(${PHP}) php, COUNT(DISTINCT recorder_id)::int recorders
       FROM sessions s GROUP BY week ORDER BY week`),
    q(`SELECT category, SUM(hours) hours, SUM(${PHP}) php FROM sessions s GROUP BY category ORDER BY hours DESC`),
    q(`SELECT COALESCE(l.name,'—') AS name, SUM(s.hours) hours, SUM(${PHP}) php
       FROM sessions s LEFT JOIN locations l ON l.id = s.location_id GROUP BY l.name ORDER BY hours DESC`),
    q(`SELECT r.id, r.name, SUM(s.hours) hours, SUM(${PHP}) php, COUNT(DISTINCT s.date)::int days
       FROM sessions s JOIN recorders r ON r.id = s.recorder_id GROUP BY r.id, r.name ORDER BY hours DESC LIMIT 10`),
    one(`SELECT COUNT(*)::int n FROM followups WHERE status != 'Resolved'`),
    one(`SELECT COUNT(*)::int n FROM periods WHERE status = 'Open'`),
    one(`SELECT (SELECT COUNT(*)::int FROM businesses WHERE active) businesses,
                COALESCE(SUM(shifts),0) shifts, COALESCE(SUM(shifts * scenes * rate_php),0) payout FROM business_shifts`),
  ]);
  return { totals, byWeek, byCategory, byLocation, topRecorders, openFollowups: fu.n, openPeriods: pr.n, bizTotals };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: process.env.NETLIFY ? 'Server error' : err.message });
});
