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

export const PUBLIC_USER = 'id, email, name, role, active, created_at, last_login_at';

/** Express middleware: attaches req.user or responds 401. */
export async function requireUser(req, res, next) {
  try {
    const payload = readToken(cookieValue(req));
    const user = payload && (await one(`SELECT ${PUBLIC_USER} FROM users WHERE id = $1 AND active`, [payload.uid]));
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

export async function login(email, password) {
  const user = await one('SELECT * FROM users WHERE lower(email) = lower($1) AND active', [String(email || '').trim()]);
  const ok = user && (await verifyPassword(String(password || ''), user.password_hash));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return null;
  }
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}
