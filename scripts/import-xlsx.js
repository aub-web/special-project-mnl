// Import the "Studio Payout Summary" .xlsx into the database from the command line.
// Usage: npm run import -- [path/to/file.xlsx] [--reset]
//   --reset  wipes sessions, recorders, locations, periods, payments and follow-ups first
//            (logins and settings are kept).
//
// Hours use the same parser as the in-app "Sync" / "Upload .xlsx" (see payout-sync.js).
// This script additionally creates the follow-ups and the pay periods for a fresh database.
import * as XLSX from 'xlsx';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, one, tx, migrate, resolveRecorder, nameKey, getSettings } from '../db.js';
import { applyPayoutSessions, ALIASES } from '../payout-sync.js';

XLSX.set_fs(fs);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || join(root, 'data', 'Studio Payout Summary.xlsx');
const wb = XLSX.readFile(file);
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (v) => { const n = Number(String(v ?? '').replace(/[₱$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

await migrate();
const fresh = args.includes('--reset');
if (fresh) {
  await q('TRUNCATE sessions, payments, followups, periods, recorder_aliases, recorders, locations RESTART IDENTITY CASCADE');
}
const settings = await getSettings();

const result = await tx(async (c) => {
  if (fresh) {
    // Seed canonical names from the most complete roster first so they win over short variants.
    const roster = wb.Sheets['Summary 0901 - 0905'];
    if (roster) {
      for (const r of XLSX.utils.sheet_to_json(roster, { header: 1, defval: null }).slice(2)) {
        const n = clean(r[0]);
        if (n && !/^total$/i.test(n)) await resolveRecorder(ALIASES[n] || n, { fuzzy: true, db: c });
      }
    }
  }

  const r = await applyPayoutSessions(c, wb, settings);

  if (fresh) {
    // Follow-ups
    const fu = wb.Sheets['Follow - up'];
    for (const row of fu ? XLSX.utils.sheet_to_json(fu, { header: 1, defval: null }).slice(2) : []) {
      if (!clean(row[0]) || row.slice(1).every((v) => !clean(v))) continue;
      await q(`INSERT INTO followups (recorder_id, description, expected_php, received_php,
        old_account_no, old_account_name, new_account_no, new_account_name, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [await resolveRecorder(clean(row[0]), { fuzzy: true, db: c }), 'Payout for Aug 14–27', (num(row[1]) + num(row[2])) || null,
          clean(row[3]) ? num(row[3]) : null, clean(row[6]), clean(row[7]), clean(row[8]), clean(row[9]), clean(row[10])], c);
    }
    // Pay periods (from the Summary tab names)
    for (const p of [
      ['Aug 14 – Aug 21', '2026-08-14', '2026-08-21', 'Closed', 'Antel Global (NARUTO Office)'],
      ['Aug 24 – Aug 28', '2026-08-24', '2026-08-28', 'Closed', 'NARUTO Airbnb + HOME Airbnb (Cainta)'],
      ['Sep 01 – Sep 05', '2026-09-01', '2026-09-05', 'Closed', 'HOME Airbnb (Pasig) + Antel Global'],
      ['Sep 08 – Sep 11', '2026-09-08', '2026-09-11', 'Closed', 'Bam Bam Chicken'],
      ['Sep 14 – Sep 20', '2026-09-14', '2026-09-20', 'Closed', 'Tone Tower + Mt. Moriah'],
      ['Sep 21 – Sep 27', '2026-09-21', '2026-09-27', 'Closed', 'Mt. Moriah + ERS Sip Up Cafe'],
      ['Sep 28 – Oct 04', '2026-09-28', '2026-10-04', 'Open', 'Oh Mama Maginhawa + others'],
    ]) await q('INSERT INTO periods (name, start_date, end_date, status, notes) VALUES ($1,$2,$3,$4,$5)', p, c);
  }
  return r;
});

console.log(`Sessions from the sheet: ${result.sessions} (${result.hours} h) · added/changed ${result.added.length} · removed ${result.removed.length}`);
const stats = await one(`SELECT (SELECT COUNT(*)::int FROM recorders) recorders, (SELECT COUNT(*)::int FROM locations) locations`);
console.log(`Recorders: ${stats.recorders} | Locations: ${stats.locations}`);

// Flag names that might still be the same person (same first + last word).
const all = await q('SELECT name FROM recorders ORDER BY name');
const near = [];
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
  const a = nameKey(all[i].name).split(' '), b = nameKey(all[j].name).split(' ');
  if (a.at(-1) === b.at(-1) && a[0] === b[0]) near.push(`${all[i].name}  ~  ${all[j].name}`);
}
if (near.length) console.log('Possible duplicates to review (use Merge in the Recorders page):\n  ' + near.join('\n  '));
await pool.end();
