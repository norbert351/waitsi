// WAITSI-native account auth — a real login with ZERO external dependency
// (node:crypto only). Passwords are scrypt-hashed with a per-user salt; login
// mints an opaque session token stored in the `sessions` table and delivered
// in an HttpOnly, SameSite=Lax cookie. This is the "another way" for sign-in
// that works standalone — no Commons OIDC, no third-party provider, no secrets.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import * as db from './db.js';

export const SESSION_COOKIE = 'waitsi_sess';
const SESSION_DAYS = 7;
const MIN_PW = 8;
const MAX_PW = 200;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHex) {
  if (!salt || !expectedHex) return false;
  const got = scryptSync(String(password), salt, 64);
  const want = Buffer.from(expectedHex, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function newSessionToken() {
  return 'wt_' + randomBytes(32).toString('hex');
}

export function sessionExpiry(days = SESSION_DAYS) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

// ---- cookie helpers (no external dep) ----
export function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { maxAge = SESSION_DAYS * 24 * 3600 } = {}) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function validateHandle(handle) {
  const h = String(handle || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(h)) return { ok: false, error: 'handle must be 3-32 chars: letters, digits, _ . -' };
  return { ok: true, handle: h };
}

export function validatePassword(pw) {
  const p = String(pw || '');
  if (p.length < MIN_PW || p.length > MAX_PW) return { ok: false, error: `password must be ${MIN_PW}-${MAX_PW} chars` };
  return { ok: true };
}

// ---- flows ----
export async function register(handle, password) {
  const h = validateHandle(handle);
  if (!h.ok) return { ok: false, status: 400, error: h.error };
  const p = validatePassword(password);
  if (!p.ok) return { ok: false, status: 400, error: p.error };
  const existing = await db.findUserByHandle(h.handle);
  if (existing && existing.password_hash) return { ok: false, status: 409, error: 'handle already registered' };
  const { hash, salt } = hashPassword(password);
  let user;
  if (existing) {
    // A handle that exists as a plain builder (no password yet) can be claimed
    // by setting a password — the world/history they already have is preserved.
    user = await db.setUserPassword(existing.id, hash, salt);
  } else {
    user = await db.createUserWithPassword(h.handle, hash, salt);
    if (!user) return { ok: false, status: 409, error: 'handle already registered' };
  }
  const token = newSessionToken();
  await db.createSession(user.id, token, sessionExpiry());
  return { ok: true, user: { id: user.id, handle: user.handle }, token };
}

export async function login(handle, password) {
  const h = validateHandle(handle);
  if (!h.ok) return { ok: false, status: 400, error: 'invalid credentials' };
  const user = await db.findUserByHandle(h.handle);
  if (!user || !user.password_hash) return { ok: false, status: 401, error: 'invalid credentials' };
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return { ok: false, status: 401, error: 'invalid credentials' };
  }
  const token = newSessionToken();
  await db.createSession(user.id, token, sessionExpiry());
  return { ok: true, user: { id: user.id, handle: user.handle }, token };
}

export async function fromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const u = await db.getSessionUser(token);
  return u ? { id: u.id, handle: u.handle, token } : null;
}

export async function logout(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await db.deleteSession(token);
  return true;
}