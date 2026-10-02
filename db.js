import pg from 'pg';

// Netlify DB sets NETLIFY_DATABASE_URL; DATABASE_URL works for any other Postgres.
const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('No database configured. Set DATABASE_URL (or NETLIFY_DATABASE_URL) — see README.');
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
  rate_usd    DOUBLE PRECISION NOT NULL,
  fx_rate     DOUBLE PRECISION NOT NULL,         -- PHP per USD at time of entry
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

-- Self sign-up: new accounts wait for an admin to approve them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO settings (key, value) VALUES ('rate_usd', '2.5'), ('fx_rate', '60'), ('ot_rate_php', '150'),
  ('admin_emails', 'aubrey@atlascapture.io'),   -- these emails become admins (pre-approved) when they sign up
  ('business_rate_php', '850'),
  ('business_sheet_id', '1904ps8_vBAG2Nezf7O9gnJveCRNRt38OoC35Ra2W2a8'),
  ('recorder_sheet_id', '1oTfvacoQFUpDsxxZ4s_xYMNqqYVJ5IWkAIpShnH0Jq8')
ON CONFLICT (key) DO NOTHING;
`;

let migrated;
/** Create tables if missing. Cached so each cold start runs it once. */
export function migrate() {
  return (migrated ??= pool.query(SCHEMA).catch((e) => { migrated = null; throw e; }));
}

export async function getSettings(db = pool) {
  const out = {};
  for (const { key, value } of await q('SELECT key, value FROM settings', [], db)) {
    out[key] = isNaN(Number(value)) ? value : Number(value);
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
    row = (await one('SELECT recorder_id AS id FROM recorder_aliases WHERE alias = $1', [key], db)) ||
      (await q('SELECT id, name FROM recorders', [], db)).find((r) => nameKey(r.name) === key);
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
