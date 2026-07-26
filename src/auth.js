// Auth for the dashboard: scrypt password hashing + HMAC-signed session tokens. Zero deps.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import * as db from './db.js';

// Constant-time string compare (for URL-embedded webhook secrets).
export function secretEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Verify a GitHub-style `X-Hub-Signature-256: sha256=<hmac>` over the raw request body.
export function verifyHmac(secret, raw, sigHeader) {
  if (!sigHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sigHeader), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- password ---------------------------------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [saltHex, hashHex] = stored.split('$');
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// --- session tokens (stateless, HMAC-signed) --------------------------------
// token = base64url(payload) . hex(hmac(payload)) where payload = `<expiryMillis>`
function secret(database) {
  let s = db.getSetting(database, 'session_secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    db.setSetting(database, 'session_secret', s);
  }
  return s;
}

export function issueToken(database, username, ttlHours = 24 * 7) {
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const payload = Buffer.from(`${exp}.${username}`).toString('base64url');
  const sig = createHmac('sha256', secret(database)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// Validate a session token and return the live user it belongs to, or null. The signed payload is
// `<expiryMillis>.<username>`; we re-check the user still exists so deleting a user revokes their
// tokens for free.
export function validUser(database, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', secret(database)).update(payload).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, 'base64url').toString();
  const dot = decoded.indexOf('.');
  if (dot < 0) return null;
  const exp = Number(decoded.slice(0, dot));
  if (!Number.isFinite(exp) || Date.now() >= exp) return null;
  const user = db.getUser(database, decoded.slice(dot + 1));
  return user ? { username: user.username, role: user.role, mustChange: !!user.must_change, appQuota: user.app_quota ?? null } : null;
}

// --- users ------------------------------------------------------------------
// Create a user, hashing the plaintext password. `mustChange` forces a password change on login.
export function createUser(database, { username, password, role = 'member', appQuota = null, mustChange = 0 }) {
  db.createUser(database, {
    username, pass_hash: hashPassword(password), role,
    app_quota: appQuota, must_change: mustChange, created_at: new Date().toISOString(),
  });
}

// Returns the user record on correct credentials, else null.
export function verifyUser(database, username, password) {
  const user = db.getUser(database, username);
  if (!user || !verifyPassword(password, user.pass_hash)) return null;
  return user;
}

export function setUserPassword(database, username, password, mustChange = 0) {
  db.setUserPassword(database, username, hashPassword(password), mustChange);
}

export const hasAdmin = (database) => db.hasAdminUser(database);

// --- admin password (CLI) ---------------------------------------------------
// Used by `justdeploy dashboard install/password`. Keeps the legacy `admin_hash` setting (bootstrap
// seed) and the 'admin' user in sync — creating the admin user on a fresh install.
export function setAdminPassword(database, password) {
  const hash = hashPassword(password);
  db.setSetting(database, 'admin_hash', hash);
  if (db.getUser(database, 'admin')) db.setUserPassword(database, 'admin', hash, 0);
  else db.createUser(database, { username: 'admin', pass_hash: hash, role: 'admin', created_at: new Date().toISOString() });
}
