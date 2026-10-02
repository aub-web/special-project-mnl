// Create or reset a login. Usage: npm run add-user -- you@example.com "Your Name" [admin|staff]
// Prompts for the password so it never lands in shell history.
import { createInterface } from 'node:readline/promises';
import { pool, one, migrate } from '../db.js';
import { hashPassword } from '../auth.js';

const [email, name = email, role = 'admin'] = process.argv.slice(2);
if (!/^\S+@\S+\.\S+$/.test(email || '')) {
  console.error('Usage: npm run add-user -- you@example.com "Your Name" [admin|staff]');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('Password (10+ characters): ');
rl.close();
if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }

await migrate();
const u = await one(`INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
  ON CONFLICT (email) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash, role = excluded.role, active = TRUE
  RETURNING id, email, role`, [email, name, await hashPassword(password), role === 'staff' ? 'staff' : 'admin']);
console.log(`Saved ${u.role} login for ${u.email}.`);
await pool.end();
