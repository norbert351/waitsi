// Google OAuth (authorization-code flow) for WAITSI sign-in.
//
// Zero new dependencies: the code exchange is POST /oauth2.googleapis.com/token
// and the ID token is verified with node:crypto against Google's published
// JWKS (RS256). On success we bind the verified Google `sub`/email to a WAITSI
// user and mint the same HttpOnly session cookie the native login uses, so
// Google sign-in and password sign-in share one session layer.
//
// Env:
//   GOOGLE_CLIENT_ID        — required
//   GOOGLE_CLIENT_SECRET    — required (confidential client)
//   GOOGLE_REDIRECT_URI     — optional; defaults to <host>/auth/google/callback
import { createPublicKey, verify, randomBytes } from 'node:crypto';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

export const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const AUTH_ALLOWED_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SCOPE = 'openid email profile';

export function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

// Callback URL an IDP must have whitelisted. Overridable for prod; defaults to
// the request's own host so localhost and the Render host both resolve without
// hardcoding.
export function callbackUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = (req.headers?.host || '').split(',')[0].trim();
  return `https://${host}/auth/google/callback`;
}

export function newOauthState() {
  return randomBytes(24).toString('hex');
}

export function authUrl(state, req) {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUri(req),
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce: randomBytes(16).toString('hex'),
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${OAUTH_AUTH}?${p.toString()}`;
}

// ---- token exchange ----
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`google token exchange failed ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json(); // { access_token, id_token, expires_in, token_type }
}

// ---- ID token verification (RS256, node:crypto, no deps) ----
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

// Full login: exchange code → verify ID token → bind identity → mint session.
// Returns { ok, user, token } (token is the *session* bearer, not Google's).
export async function loginWithGoogle({ code, redirectUri, db }) {
  if (!googleConfigured()) {
    return { ok: false, status: 503, error: 'google_oauth_not_configured', detail: 'set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET' };
  }
  const tok = await exchangeCode(code, redirectUri);
  const payload = await verifyIdToken(tok.id_token);
  const email = String(payload.email || '').toLowerCase();

  const existing = await db.findUserByGoogleSub(payload.sub);
  let user;
  if (existing) {
    user = existing;
  } else {
    // On first-ever Google sign-in, claim/create a handle from the email and
    // bind the Google sub. If the handle somehow collides, fall back to sub.
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