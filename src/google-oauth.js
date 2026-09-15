// Google Sign-In — CLIENT-SIDE ONLY (Google Identity Services), no secret.
//
// The pattern that works with nothing but the Client ID:
//   1. The page loads Google's GIS library and renders the button.
//   2. GIS returns an ID token (JWT) in the browser.
//   3. The page POSTs that token to /auth/google/token.
//   4. The backend verifies it against Google's published JWKS (RS256,
//      node:crypto) — aud === our client ID + iss/exp/sub checks — then binds
//      the verified `sub` to a WAITSI user and mints the normal session cookie.
//
// No client secret anywhere: a client-side GIS token is verified by public-key
// JWT, which needs only the Client ID. Env: GOOGLE_CLIENT_ID (required).
import { createPublicKey, verify } from 'node:crypto';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const AUTH_ALLOWED_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Live accessor (reads env at call time, not import time).
export function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}
// For callers that want the const at import time (stable after boot).
export function googleClientIdAtImport() {
  return GOOGLE_CLIENT_ID;
}

// Client-side flow is configured as soon as the public Client ID exists.
// Read env at call time so it stays reactive (and testable).
export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

// ---- ID token verification (RS256, node:crypto, no deps, no secret) ----
function b64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const jwksCache = { ts: 0, keys: [] };
async function getJwks(force = false) {
  const now = Date.now();
  if (!force && jwksCache.keys.length && now - jwksCache.ts < 3600_000) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`google JWKS fetch failed ${r.status}`);
  const j = await r.json();
  jwksCache.keys = (j.keys || []).filter((k) => k.kty === 'RSA');
  jwksCache.ts = now;
  return jwksCache.keys;
}

function verifyRS256(data, sigBuf, jwk) {
  const key = createPublicKey({ key: { kty: 'RSA', e: jwk.e, n: jwk.n }, format: 'jwk' });
  return verify('RSA-SHA256', data, key, sigBuf);
}

export async function verifyIdToken(token, clientId = GOOGLE_CLIENT_ID) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [h, p, sig] = parts;
  const header = JSON.parse(b64url(h).toString('utf8'));
  const payload = JSON.parse(b64url(p).toString('utf8'));

  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('no matching JWKS key for kid');
  const ok = verifyRS256(Buffer.from(`${h}.${p}`, 'utf8'), b64url(sig), jwk);
  if (!ok) throw new Error('id_token signature invalid');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('id_token expired');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('id_token issued in future');
  if (payload.aud !== clientId) throw new Error('id_token audience mismatch');
  if (!AUTH_ALLOWED_ISS.has(payload.iss)) throw new Error('id_token bad issuer');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('id_token missing sub');
  return payload;
}

// ---- turn a verified Google identity into a WAITSI user + session ----
export function handleFromEmail(email, sub) {
  const local = String(email || '').toLowerCase().split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 26);
  if (local && local.length >= 3) return `g_${local}`;
  return `g_${sub.slice(0, 20)}`;
}

// Verify a client-side GIS ID token and bind/claim the WAITSI user.
// Returns { ok, user, error?, status? }.
export async function loginWithGoogleToken({ credential, db, clientId = googleClientId() }) {
  if (!googleConfigured()) {
    return { ok: false, status: 503, error: 'google_oauth_not_configured', detail: 'set GOOGLE_CLIENT_ID' };
  }
  if (typeof credential !== 'string' || !credential) {
    return { ok: false, status: 400, error: 'id token (credential) required' };
  }
  let payload;
  try {
    payload = await verifyIdToken(credential, clientId);
  } catch (e) {
    return { ok: false, status: 401, error: `invalid google id token: ${e.message}` };
  }
  const email = String(payload.email || '').toLowerCase();

  const existing = await db.findUserByGoogleSub(payload.sub);
  let user;
  if (existing) {
    user = existing;
  } else {
    let handle = handleFromEmail(email, payload.sub);
    user = await db.upsertUserByGoogle(payload.sub, handle, email);
    if (!user) {
      handle = `g_${payload.sub.slice(0, 20)}`;
      user = await db.upsertUserByGoogle(payload.sub, handle, email);
    }
    if (!user) return { ok: false, status: 409, error: 'could not bind google account' };
  }
  return { ok: true, user: { id: user.id, handle: user.handle, google: true } };
}