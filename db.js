import pg from 'pg';

// DATABASE_URL is ours; NETLIFY_DATABASE_URL is what Netlify DB sets automatically. Ours wins.
const envName = process.env.DATABASE_URL ? 'DATABASE_URL' : 'NETLIFY_DATABASE_URL';
// Tolerate a whole .env line pasted as the value ("DATABASE_URL=postgresql://…") and surrounding quotes.
const connectionString = (process.env[envName] || '').trim().replace(/^[A-Z_]+=/, '').replace(/^["']|["']$/g, '');
if (!connectionString) {
  throw new Error('No database configured. Set DATABASE_URL (or NETLIFY_DATABASE_URL) — see README.');
}
// Catch common paste mistakes early, without ever echoing the password.
{
  let host = '';
  try { host = new URL(connectionString).hostname; } catch {}
  if (!/^postgres(ql)?:\/\//.test(connectionString) || !host.includes('.')) {
    throw new Error(`${envName} doesn't look like a Postgres connection string ` +
      `(it starts with "${connectionString.slice(0, 11)}…" and the host is "${host || 'unreadable'}"). ` +
      'It should be the whole value starting with postgresql:// — without the "DATABASE_URL=" part.');
  }
}

// Serverless functions each hold their own pool, so keep it small.
export const pool = new pg.Pool({ connectionString, max: process.env.NETLIFY ? 2 : 10 });

/** Run a query on the pool (or a transaction client) and return the rows. */
export async function q(text, params = [], db = pool) {
  return (await db.query(text, params)).rows;
}
export async function one(text, params = [], db = pool) {
  return (await db.query(text, params)).rows[0];
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Dates are stored as 'YYYY-MM-DD' text so they reach the browser unchanged (no timezone shifts).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',   -- admin | staff
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recorders (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  app_account TEXT,                -- "Recorder's Acct. No." from the HOME sheets (e.g. 005)
  payout_account_no   TEXT,        -- where money is sent (GoTyme / GCash / bank)
  payout_account_name TEXT,
  contact     TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recorders_name_ci ON recorders (lower(name));

-- Alternate spellings seen in the spreadsheet / input, mapped to one recorder. Stored lowercase.
CREATE TABLE IF NOT EXISTS recorder_aliases (
  alias       TEXT PRIMARY KEY,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS locations (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  notes  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS locations_name_ci ON locations (lower(name));

-- One row = one recorder's hours at one location on one day (or shift).
CREATE TABLE IF NOT EXISTS sessions (
  id          SERIAL PRIMARY KEY,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id),
  location_id INTEGER REFERENCES locations(id),
  date        TEXT NOT NULL,                     -- YYYY-MM-DD
  hours       DOUBLE PRECISION NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Studio',    -- Studio | Home Shift | OT
  shift       TEXT,
  rate_php    DOUBLE PRECISION,                  -- ₱ per hour at time of entry (pay = hours × rate_php)
  rate_usd    DOUBLE PRECISION,                  -- legacy (USD era); kept for history, not used
  fx_rate     DOUBLE PRECISION,                  -- legacy
  notes       TEXT,
  source      TEXT,                              -- sheet it was imported from, or 'web'
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_recorder ON sessions(recorder_id);

CREATE TABLE IF NOT EXISTS periods (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Open',  -- Open | Closed
  notes      TEXT
);

-- What was actually sent to a recorder for a period.
CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id),
  amount_php  DOUBLE PRECISION NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Paid',  -- Paid | Pending | Issue
  account_no  TEXT,
  reference   TEXT,
  paid_at     TEXT,
  notes       TEXT,
  UNIQUE (period_id, recorder_id)
);

-- Payment problems to chase (wrong account, short payment, etc.)
CREATE TABLE IF NOT EXISTS followups (
  id               SERIAL PRIMARY KEY,
  recorder_id      INTEGER REFERENCES recorders(id),
  description      TEXT,
  expected_php     DOUBLE PRECISION,
  received_php     DOUBLE PRECISION,
  old_account_no   TEXT,
  old_account_name TEXT,
  new_account_no   TEXT,
  new_account_name TEXT,
  status           TEXT NOT NULL DEFAULT 'Open',  -- Open | Resolved
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Host businesses (from the "Studio Business Payout" sheet → Business Profile).
CREATE TABLE IF NOT EXISTS businesses (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_name      TEXT,
  bank_name       TEXT,
  bank_account_no TEXT,
  account_name    TEXT,            -- "Owner's ID" column: name on the account
  gcash_owner     TEXT,
  location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL,  -- where recorders log hours for this business
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS businesses_name_ci ON businesses (lower(name));

-- Shifts hosted per day. Business payout = shifts × scenes × rate_php.
CREATE TABLE IF NOT EXISTS business_shifts (
  id          SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,                 -- YYYY-MM-DD
  shifts      DOUBLE PRECISION NOT NULL,
  scenes      DOUBLE PRECISION NOT NULL,
  rate_php    DOUBLE PRECISION NOT NULL,
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'web',   -- 'sheet' rows are replaced on every sync
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_shifts_date ON business_shifts(date);

-- Recorder profile details (synced from the recorder Google Sheet).
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS id_document TEXT;          -- name of the ID file on record
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS contract TEXT;             -- signed service agreement (file name or link)
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS contract_hard_copy TEXT;   -- "done" / "not yet"
-- Google Drive links behind the sheet's file chips. Only the link is stored; Drive sharing controls who can open it.
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS id_document_url TEXT;
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS contract_url TEXT;

-- Business profile extras: address, engagement status from the sheet ("Finish" / "On going"),
-- and the defaults used for new shifts: scenes per shift and ₱ per shift × scene.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS default_scenes DOUBLE PRECISION;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rate_php DOUBLE PRECISION;

-- What kind of place a location is, for the recorder "Works at" tags: business | sp | other.
-- NULL = decide automatically (linked to a business → business; name mentions Naruto / In-Lab → sp; else other).
ALTER TABLE locations ADD COLUMN IF NOT EXISTS kind TEXT;

-- Recorders assigned to a business (in addition to anyone who logged hours at its location).
CREATE TABLE IF NOT EXISTS business_recorders (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, recorder_id)
);

-- Business owner IDs (Google Drive links, e.g. from the "Business Owner's ID" folder).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_id_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gcash_owner_id_url TEXT;

-- Contract tag set by admins only: Done | Pending. Seeded from whether a signed contract is on file.
ALTER TABLE recorders ADD COLUMN IF NOT EXISTS contract_status TEXT;
UPDATE recorders SET contract_status = CASE WHEN contract IS NOT NULL OR contract_url IS NOT NULL THEN 'Done' ELSE 'Pending' END
  WHERE contract_status IS NULL;
ALTER TABLE recorders ALTER COLUMN contract_status SET DEFAULT 'Pending';

-- Public registration form (/register?k=…). Submissions wait for an admin; nothing public writes to recorders directly.
CREATE TABLE IF NOT EXISTS registrations (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  contact        TEXT NOT NULL,
  address        TEXT NOT NULL,
  payment_method TEXT NOT NULL,            -- GCash | PayMaya | Bank
  bank_name      TEXT,
  account_no     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Approved | Rejected
  recorder_id    INTEGER REFERENCES recorders(id) ON DELETE SET NULL,
  reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uploaded ID / e-signature files. Stored in the database (served only to admins and the recorder themselves).
CREATE TABLE IF NOT EXISTS recorder_files (
  id              SERIAL PRIMARY KEY,
  registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
  recorder_id     INTEGER REFERENCES recorders(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('id', 'esign')),
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  data            BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recorder_files_recorder ON recorder_files(recorder_id);

-- Shared secret for the Apps Script write-back (app → recorder sheet).
INSERT INTO settings (key, value) VALUES ('sheets_webhook_secret', replace(gen_random_uuid()::text, '-', '')), ('recorder_sheet_webhook', '')
ON CONFLICT (key) DO NOTHING;

-- The key in the registration link; regenerate it to switch off an old link.
INSERT INTO settings (key, value) VALUES ('registration_key', replace(gen_random_uuid()::text, '-', ''))
ON CONFLICT (key) DO NOTHING;

-- Self sign-up: new accounts wait for an admin to approve them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;
-- Roles: admin | sdr | set_director | recorder. A recorder login sees only the recorder whose
-- sheet email matches the login email (resolved on each request, so sheet changes apply right away).
-- recorder_id is no longer used; kept so older databases don't need a destructive migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recorder_id INTEGER REFERENCES recorders(id) ON DELETE SET NULL;
UPDATE users SET role = 'set_director' WHERE role = 'staff';

-- Pesos only: sessions carry a ₱/hour rate. Older rows get rate_usd × fx_rate (e.g. $2.50 × ₱60 = ₱150).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rate_php DOUBLE PRECISION;
ALTER TABLE sessions ALTER COLUMN rate_usd DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN fx_rate DROP NOT NULL;
UPDATE sessions SET rate_php = rate_usd * fx_rate WHERE rate_php IS NULL AND rate_usd IS NOT NULL AND fx_rate IS NOT NULL;
INSERT INTO settings (key, value)
  SELECT 'rate_php', (COALESCE((SELECT value::float8 FROM settings WHERE key = 'rate_usd'), 2.5)
                    * COALESCE((SELECT value::float8 FROM settings WHERE key = 'fx_rate'), 60))::text
ON CONFLICT (key) DO NOTHING;
DELETE FROM settings WHERE key IN ('rate_usd', 'fx_rate');

INSERT INTO settings (key, value) VALUES ('ot_rate_php', '150'),
  ('admin_emails', 'aubrey@atlascapture.io'),   -- these emails become admins (pre-approved) when they sign up
  ('business_rate_php', '850'),
  ('business_sheet_id', '1904ps8_vBAG2Nezf7O9gnJveCRNRt38OoC35Ra2W2a8'),
  ('recorder_sheet_id', '1oTfvacoQFUpDsxxZ4s_xYMNqqYVJ5IWkAIpShnH0Jq8'),
  ('payout_sheet_id', '1PxfBOfKmuHfG3Y_7GCrwXueg8pIm1mIL9aaxOANpxwE')
ON CONFLICT (key) DO NOTHING;
`;

// Bump when SCHEMA changes. The schema (with its ALTER TABLEs, which lock tables) only runs when the
// stored version differs, so serverless cold starts don't block a running sync.
const SCHEMA_VERSION = '2026-10-08.works-at';

let migrated;
/** Create/upgrade tables if needed. Cached so each cold start checks once. */
export function migrate() {
  return (migrated ??= (async () => {
    const current = await pool.query(`SELECT value FROM settings WHERE key = 'schema_version'`)
      .then((r) => r.rows[0]?.value, () => null); // settings table may not exist yet
    if (current === SCHEMA_VERSION) return;
    await pool.query(SCHEMA);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('schema_version', $1)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION]);
  })().catch((e) => { migrated = null; throw e; }));
}

export async function getSettings(db = pool) {
  const out = {};
  for (const { key, value } of await q('SELECT key, value FROM settings', [], db)) {
    out[key] = value.trim() !== '' && !isNaN(Number(value)) ? Number(value) : value; // '' stays '' (Number('') is 0)
  }
  return out;
}

/** Collapse a name to a comparison key: lowercase, no accents/punctuation/middle initials. */
export function nameKey(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.jpg$/, '')
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 1)
    .join(' ');
}

/**
 * Find a recorder by exact name or alias; create if none.
 * fuzzy: also match ignoring middle initials/punctuation. Only the spreadsheet importer uses it —
 * in day-to-day entry it would silently merge people whose names differ only by an initial.
 */
export async function resolveRecorder(rawName, { create = true, fuzzy = false, db = pool } = {}) {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const key = nameKey(name);
  let row =
    (await one('SELECT id FROM recorders WHERE lower(name) = lower($1)', [name], db)) ||
    (await one('SELECT recorder_id AS id FROM recorder_aliases WHERE alias = $1', [name.toLowerCase()], db));
  if (!row && fuzzy) {
    const all = await q('SELECT id, name FROM recorders', [], db);
    row = (await one('SELECT recorder_id AS id FROM recorder_aliases WHERE alias = $1', [key], db)) ||
      all.find((r) => nameKey(r.name) === key);
    if (!row) {
      // One name's words all inside the other's, same surname, and only one such recorder:
      // "Lord Leam T. Andes" ↔ "Leam Andes". ("Rencel Teodoro" fits two Rencels, so it never matches.)
      const t = key.split(' ');
      const fits = all.filter((r) => {
        const c = nameKey(r.name).split(' ');
        const [short, long] = c.length <= t.length ? [c, t] : [t, c];
        return short.length >= 2 && c.at(-1) === t.at(-1) && short.every((w) => long.includes(w));
      });
      if (fits.length === 1) {
        row = fits[0];
        await addAlias(name, row.id, db); // remember the spelling so later lookups are exact
      }
    }
  }
  if (row) return row.id;
  if (!create) return null;
  return (await one('INSERT INTO recorders (name) VALUES ($1) RETURNING id', [name], db)).id;
}

export async function addAlias(alias, recorderId, db = pool) {
  await q(`INSERT INTO recorder_aliases (alias, recorder_id) VALUES ($1, $2)
           ON CONFLICT (alias) DO UPDATE SET recorder_id = excluded.recorder_id`, [alias.trim().toLowerCase(), recorderId], db);
}

export async function resolveLocation(name, db = pool) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const row = await one('SELECT id FROM locations WHERE lower(name) = lower($1)', [n], db);
  if (row) return row.id;
  return (await one('INSERT INTO locations (name) VALUES ($1) RETURNING id', [n], db)).id;
}
