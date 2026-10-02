import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { one, q } from './db.js';

const scryptAsync = promisify(scrypt);
const COOKIE = 'spl_session';
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set to a random string of 32+ characters — see README.');
  return s;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

// Stateless signed cookie: base64url(json).hmac
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');
function makeToken(user) {
  const data = Buffer.from(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })).toString('base64url');
  return `${data}.${sign(data)}`;
}
function readToken(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  return payload.exp > Date.now() / 1000 ? payload : null;
}

function cookieValue(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const secure = () => (process.env.NETLIFY || process.env.NODE_ENV === 'production' ? '; Secure' : '');

export function setSessionCookie(res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure()}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`);
}

export const PUBLIC_USER = 'id, email, name, role, active, approved, created_at, last_login_at';

/** Express middleware: attaches req.user or responds 401. */
export async function requireUser(req, res, next) {
  try {
    const payload = readToken(cookieValue(req));
    const user = payload && (await one(`SELECT ${PUBLIC_USER} FROM users WHERE id = $1 AND active AND approved`, [payload.uid]));
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

const slowDown = () => new Promise((r) => setTimeout(r, 400)); // makes password guessing slower

/** Returns the user, or throws a 401/403 with a message for the sign-in form. */
export async function login(email, password) {
  const user = await one('SELECT * FROM users WHERE lower(email) = lower($1) AND active', [String(email || '').trim()]);
  const ok = user && (await verifyPassword(String(password || ''), user.password_hash));
  if (!ok) {
    await slowDown();
    throw Object.assign(new Error('Wrong email or password'), { status: 401 });
  }
  if (!user.approved) {
    throw Object.assign(new Error('Your account is waiting for an admin to approve it.'), { status: 403 });
  }
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}

/**
 * Self sign-up. Emails listed in the admin_emails setting become approved admins straight away;
 * everyone else is created as pending staff until an admin approves them.
 */
export async function signup({ name, email, password }, adminEmails = []) {
  email = String(email || '').trim();
  name = String(name || '').trim();
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!name) throw bad('Please enter your name');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Please enter a valid email');
  if (String(password || '').length < 10) throw bad('Password must be at least 10 characters');
  if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])) {
    await slowDown();
    throw bad('An account with this email already exists. Sign in instead.');
  }
  const isAdmin = adminEmails.map((e) => e.trim().toLowerCase()).includes(email.toLowerCase());
  return one(`INSERT INTO users (email, name, password_hash, role, approved) VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC_USER}`,
    [email, name, await hashPassword(password), isAdmin ? 'admin' : 'recorder', isAdmin]);
}
