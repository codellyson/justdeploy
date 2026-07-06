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

export function issueToken(database, ttlHours = 24 * 7) {
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const payload = Buffer.from(String(exp)).toString('base64url');
  const sig = createHmac('sha256', secret(database)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function validToken(database, token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', secret(database)).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(Buffer.from(payload, 'base64url').toString());
  return Number.isFinite(exp) && Date.now() < exp;
}

// --- admin password storage -------------------------------------------------
export const setAdminPassword = (database, password) =>
  db.setSetting(database, 'admin_hash', hashPassword(password));

export const hasAdmin = (database) => !!db.getSetting(database, 'admin_hash');

export const checkAdmin = (database, password) =>
  verifyPassword(password, db.getSetting(database, 'admin_hash'));
