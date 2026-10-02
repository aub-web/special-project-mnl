import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.SPL_DB || join(root, 'data', 'spl.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recorders (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  app_account TEXT,                -- "Recorder's Acct. No." from the HOME sheets (e.g. 005)
  payout_account_no   TEXT,        -- where money is sent (GoTyme / GCash / bank)
  payout_account_name TEXT,
  contact     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Alternate spellings seen in the spreadsheet / input, mapped to one recorder.
CREATE TABLE IF NOT EXISTS recorder_aliases (
  alias       TEXT PRIMARY KEY COLLATE NOCASE,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS locations (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  notes  TEXT
);

-- One row = one recorder's hours at one location on one day (or shift).
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id),
  location_id INTEGER REFERENCES locations(id),
  date        TEXT NOT NULL,              -- YYYY-MM-DD
  hours       REAL NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Studio',  -- Studio | Home Shift | OT
  shift       TEXT,
  rate_usd    REAL NOT NULL,
  fx_rate     REAL NOT NULL,              -- PHP per USD at time of entry
  notes       TEXT,
  source      TEXT,                       -- e.g. sheet name it was imported from
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_recorder ON sessions(recorder_id);

CREATE TABLE IF NOT EXISTS periods (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Open',  -- Open | Closed
  notes      TEXT
);

-- What was actually sent to a recorder for a period.
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY,
  period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  recorder_id INTEGER NOT NULL REFERENCES recorders(id),
  amount_php  REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Paid',  -- Paid | Pending | Issue
  account_no  TEXT,
  reference   TEXT,
  paid_at     TEXT,
  notes       TEXT,
  UNIQUE (period_id, recorder_id)
);

-- Payment problems to chase (wrong account, short payment, etc.)
CREATE TABLE IF NOT EXISTS followups (
  id               INTEGER PRIMARY KEY,
  recorder_id      INTEGER REFERENCES recorders(id),
  description      TEXT,
  expected_php     REAL,
  received_php     REAL,
  old_account_no   TEXT,
  old_account_name TEXT,
  new_account_no   TEXT,
  new_account_name TEXT,
  status           TEXT NOT NULL DEFAULT 'Open',  -- Open | Resolved
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const DEFAULT_SETTINGS = { rate_usd: '2.5', fx_rate: '60', ot_rate_php: '150' };
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

export function getSettings() {
  const out = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    out[key] = isNaN(Number(value)) ? value : Number(value);
  }
  return out;
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
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

/** Find a recorder by exact name, alias, or normalized key; create if none. */
export function resolveRecorder(rawName, { create = true } = {}) {
  const name = String(rawName).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  let row =
    db.prepare('SELECT id FROM recorders WHERE name = ? COLLATE NOCASE').get(name) ||
    db.prepare('SELECT recorder_id AS id FROM recorder_aliases WHERE alias = ?').get(name);
  if (!row) {
    const key = nameKey(name);
    row = db.prepare('SELECT recorder_id AS id FROM recorder_aliases WHERE alias = ?').get(key);
    if (!row) {
      for (const r of db.prepare('SELECT id, name FROM recorders').all()) {
        if (nameKey(r.name) === key) { row = r; break; }
      }
    }
  }
  if (row) return row.id;
  if (!create) return null;
  return Number(db.prepare('INSERT INTO recorders (name) VALUES (?)').run(name).lastInsertRowid);
}

export function addAlias(alias, recorderId) {
  db.prepare('INSERT OR REPLACE INTO recorder_aliases (alias, recorder_id) VALUES (?, ?)').run(alias.trim(), recorderId);
}

export function resolveLocation(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const row = db.prepare('SELECT id FROM locations WHERE name = ? COLLATE NOCASE').get(n);
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO locations (name) VALUES (?)').run(n).lastInsertRowid);
}
