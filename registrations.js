// Recorder self-registration (/register?k=…) and the admin review queue.
//
// Safety rules:
//   • The public form never writes to `recorders`. Submissions wait in `registrations` until an admin approves,
//     so nobody can use the link to change an existing recorder's payout account.
//   • The link only works with the current registration key (Settings → regenerate to switch an old link off).
//   • Files are checked by their actual bytes (JPEG/PNG/WebP/HEIC/PDF only) and served with no-sniff + sandbox headers.
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { q, one, tx, getSettings, nameKey } from './db.js';
import { requireAdmin } from './auth.js';
import { pushRecorderToSheet } from './sheet-writeback.js';

export const publicRouter = express.Router();   // mounted before sign-in is required
export const router = express.Router();         // mounted after sign-in

const PAYMENT_METHODS = ['GCash', 'PayMaya', 'Bank'];
const MAX_FILE = 4 * 1024 * 1024;        // per file, after the browser shrinks photos
const MAX_TOTAL = 5 * 1024 * 1024;       // whole submission (serverless request limit is ~6 MB)
const MIN_FILES = { id: 1, esign: 1 };
const MAX_FILES_PER_KIND = 2;

const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => async (req, res) => {
  try { const out = await fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 400).json({ error: e.message }); }
};

/** Identify the file type from its first bytes; never trust the browser's claim. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  return null;
}

async function checkKey(k) {
  const { registration_key } = await getSettings();
  const a = Buffer.from(String(k || '')), b = Buffer.from(String(registration_key || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// Light per-instance throttle against form spamming: at most 5 successful submissions per device per hour.
// (Failed attempts don't count, so someone fixing a typo isn't locked out.)
const recent = new Map();
const recentFor = (ip) => (recent.get(ip) || []).filter((t) => Date.now() - t < 3600_000);
function checkThrottle(ip) {
  if (recentFor(ip).length >= 5) throw fail('Too many submissions from this device. Please try again later.', 429);
}
function recordSubmission(ip) { recent.set(ip, [...recentFor(ip), Date.now()]); }

// ---------- Public ----------
publicRouter.get('/public/register/check', wrap(async (req) => ({ valid: await checkKey(req.query.k) })));

publicRouter.post('/public/register', wrap(async (req) => {
  const b = req.body || {};
  if (!(await checkKey(b.k))) throw fail('This registration link is no longer valid. Ask the studio for a new link.', 403);
  if (clean(b.website)) return { ok: true }; // honeypot: bots fill hidden fields
  const ip = String(req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0];
  checkThrottle(ip);

  const r = {
    name: clean(b.name), email: clean(b.email).toLowerCase(), contact: clean(b.contact).replace(/[^\d+]/g, ''),
    address: clean(b.address), payment_method: clean(b.payment_method), bank_name: clean(b.bank_name) || null,
    account_no: clean(b.account_no).replace(/[^\dA-Za-z-]/g, ''),
  };
  if (r.name.length < 4 || !/\s/.test(r.name)) throw fail('Please enter your full name (first and last name).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email)) throw fail('Please enter a valid email address.');
  if (!/^(\+?63|0)9\d{9}$/.test(r.contact)) throw fail('Please enter a valid PH mobile number, e.g. 09171234567.');
  if (r.address.length < 10) throw fail('Please enter your complete home address.');
  if (!PAYMENT_METHODS.includes(r.payment_method)) throw fail('Please choose a payment method.');
  if (r.payment_method === 'Bank' && !r.bank_name) throw fail('Please enter the name of your bank.');
  if (r.account_no.length < 6 || r.account_no.length > 34) throw fail('Please enter a valid account number.');
  if (!b.consent) throw fail('Please confirm that your details are correct and agree to how we use them.');
  if (r.contact.startsWith('+63')) r.contact = '0' + r.contact.slice(3);
  else if (r.contact.startsWith('63')) r.contact = '0' + r.contact.slice(2);

  // Files
  const files = Array.isArray(b.files) ? b.files : [];
  let total = 0;
  const parsed = files.map((f) => {
    if (!['id', 'esign'].includes(f?.kind)) throw fail('Unexpected file.');
    const data = Buffer.from(String(f.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    const mime = sniff(data);
    if (!mime) throw fail(`"${clean(f.name) || 'A file'}" isn't a photo or PDF we can accept (JPG, PNG, WebP, HEIC or PDF).`);
    if (data.length > MAX_FILE) throw fail(`"${clean(f.name)}" is too large (max 4 MB).`);
    total += data.length;
    const filename = (clean(f.name) || `${f.kind}.${mime.split('/')[1]}`).replace(/[^\w.() -]/g, '_').slice(0, 120);
    return { kind: f.kind, mime, data, filename };
  });
  if (total > MAX_TOTAL) throw fail('The attachments are too large together (max 5 MB). Try fewer or smaller photos.');
  for (const [kind, min] of Object.entries(MIN_FILES)) {
    const n = parsed.filter((f) => f.kind === kind).length;
    const label = kind === 'id' ? 'valid ID' : 'e-signature';
    if (n < min) throw fail(`Please attach your ${label} (1 or 2 files).`);
    if (n > MAX_FILES_PER_KIND) throw fail(`Please attach at most ${MAX_FILES_PER_KIND} ${label} files.`);
  }

  if (await one(`SELECT 1 FROM registrations WHERE lower(email) = $1 AND status = 'Pending'`, [r.email])) {
    throw fail('We already have a registration waiting for review with this email. The studio will contact you.');
  }

  await tx(async (c) => {
    const { id } = await one(`INSERT INTO registrations (name, email, contact, address, payment_method, bank_name, account_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [r.name, r.email, r.contact, r.address, r.payment_method, r.bank_name, r.account_no], c);
    for (const f of parsed) {
      await q('INSERT INTO recorder_files (registration_id, kind, filename, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, f.kind, f.filename, f.mime, f.data.length, f.data], c);
    }
  });
  recordSubmission(ip);
  return { ok: true };
}));

// ---------- Admin: link & review queue ----------
router.get('/registrations/link', requireAdmin, wrap(async () => ({ key: (await getSettings()).registration_key })));
router.post('/registrations/link/regenerate', requireAdmin, wrap(async () => {
  const key = randomBytes(16).toString('hex');
  await q(`INSERT INTO settings (key, value) VALUES ('registration_key', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key]);
  return { key };
}));

router.get('/registrations/pending-count', requireAdmin, wrap(() => one(`SELECT COUNT(*)::int n FROM registrations WHERE status = 'Pending'`)));

router.get('/registrations', requireAdmin, wrap(async () => {
  const regs = await q(`SELECT r.*, COALESCE(json_agg(json_build_object('id', f.id, 'kind', f.kind, 'filename', f.filename, 'mime', f.mime, 'size', f.size)
      ORDER BY f.kind, f.id) FILTER (WHERE f.id IS NOT NULL), '[]') AS files
    FROM registrations r LEFT JOIN recorder_files f ON f.registration_id = r.id
    WHERE r.status = 'Pending' GROUP BY r.id ORDER BY r.created_at`);
  // Suggest the existing recorder this might be (same email, or same name ignoring middle initials).
  const recs = await q('SELECT id, name, email FROM recorders');
  for (const g of regs) {
    g.matches = recs.filter((x) => (x.email && x.email.toLowerCase() === g.email.toLowerCase()) || nameKey(x.name) === nameKey(g.name))
      .map((x) => ({ id: x.id, name: x.name, email: x.email }));
  }
  return regs;
}));

router.post('/registrations/:id/approve', requireAdmin, wrap(async (req) => {
  const id = Number(req.params.id);
  const target = req.body?.recorder_id ? Number(req.body.recorder_id) : null; // null = create a new recorder
  const result = await tx(async (c) => {
    const g = await one(`SELECT * FROM registrations WHERE id = $1 AND status = 'Pending' FOR UPDATE`, [id], c);
    if (!g) throw fail('This registration was already handled.', 404);
    const method = g.payment_method === 'Bank' ? `Bank – ${g.bank_name}` : g.payment_method;
    const nFiles = await one(`SELECT COUNT(*) FILTER (WHERE kind = 'id')::int ids, COUNT(*) FILTER (WHERE kind = 'esign')::int esigns
      FROM recorder_files WHERE registration_id = $1`, [id], c);
    const fields = [g.email, g.contact, g.address, method, g.account_no, `${nFiles.ids} ID file(s) uploaded via registration form`];
    let rid = target;
    if (rid) {
      if (!(await one('SELECT 1 FROM recorders WHERE id = $1', [rid], c))) throw fail('That recorder no longer exists.');
      await q(`UPDATE recorders SET email = $2, contact = $3, address = $4, payment_method = $5, payout_account_no = $6, id_document = $7
        WHERE id = $1`, [rid, ...fields], c);
    } else {
      if (await one('SELECT 1 FROM recorders WHERE lower(name) = lower($1)', [g.name], c)) {
        throw fail(`A recorder named "${g.name}" already exists — choose them under "Save to" instead of creating a new one.`);
      }
      rid = (await one(`INSERT INTO recorders (name, email, contact, address, payment_method, payout_account_no, id_document, contract_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending') RETURNING id`, [g.name, ...fields], c)).id;
    }
    await q('UPDATE recorder_files SET recorder_id = $1 WHERE registration_id = $2', [rid, id], c);
    await q(`UPDATE registrations SET status = 'Approved', recorder_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, rid, req.user.id], c);
    return { ok: true, recorder_id: rid };
  });
  // Add/update them in the recorder Google Sheet (after the database commit; a sheet problem never blocks approval).
  return { ...result, sheet: await pushRecorderToSheet(result.recorder_id) };
}));

// Rejecting deletes the uploaded IDs/signatures right away (no reason to keep personal documents).
router.post('/registrations/:id/reject', requireAdmin, wrap(async (req) => {
  const id = Number(req.params.id);
  await tx(async (c) => {
    await q('DELETE FROM recorder_files WHERE registration_id = $1 AND recorder_id IS NULL', [id], c);
    await q(`UPDATE registrations SET status = 'Rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status = 'Pending'`, [id, req.user.id], c);
  });
  return { ok: true };
}));

// ---------- Files ----------
router.get('/recorders/:id/files', requireAdmin, wrap((req) =>
  q('SELECT id, kind, filename, mime, size, created_at FROM recorder_files WHERE recorder_id = $1 ORDER BY kind, id', [Number(req.params.id)])));

// Admins see any file; a recorder only their own (linked by email, like My hours).
router.get('/files/:id', wrap(async (req, res) => {
  const f = await one('SELECT * FROM recorder_files WHERE id = $1', [Number(req.params.id)]);
  if (!f) throw fail('File not found', 404);
  if (req.user.role !== 'admin') {
    const own = f.recorder_id && await one('SELECT 1 FROM recorders WHERE id = $1 AND lower(email) = lower($2)', [f.recorder_id, req.user.email]);
    if (!own) throw fail('Not allowed', 403);
  }
  res.set({
    'Content-Type': f.mime,
    'Content-Length': String(f.data.length),
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${f.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(f.data);
}));
