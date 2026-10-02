// Scheduled: every 10 minutes, pull the Google Sheets into the app (sheet → app).
// Hours (Studio Payout Summary) only rewrite sessions when the sheet changed; recorder and business
// profiles are cheap upserts. Each runs independently so one failing sheet doesn't block the others.
import { migrate } from '../../db.js';
import { autoSyncPayout } from '../../payout-sync.js';
import { syncRecorders } from '../../recorders-sync.js';
import { syncBusinesses } from '../../businesses.js';

export default async () => {
  await migrate();
  const out = {};
  for (const [name, fn] of [['hours', autoSyncPayout], ['recorders', syncRecorders], ['businesses', syncBusinesses]]) {
    try { const r = await fn(); out[name] = r.skipped || 'synced'; }
    catch (e) { out[name] = 'error: ' + e.message; }
  }
  console.log('sheet-sync', JSON.stringify(out));
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/10 * * * *' };
