// WAITSI API server — HTTP + SSE live stream + static surface on PostgreSQL.
//
// v2 (2026-09) route additions (all of them existed as *gaps* before):
//   POST /waits/:id/verify              server-truth heartbeat (closes the
//                                       "client declares its own seconds" hole)
//   GET  /waits/hub?handle=             ONE SSE for ALL concurrent agents
//                                       (the multi-agent view had no surface)
//   GET  /shop/:handle                  coin sink catalog
//   POST /shop/:handle/buy              buy an upgrade
//   POST /shop/:handle/cosmetic         buy a cosmetic
//   POST /payouts/:voucher/redeem       single-use voucher redemption
//   GET  /profile/:handle               shareable public profile
//   GET  /sponsor/:id                   advertiser delivery report
//   GET  /admin/campaigns               sponsor-ops view
//   POST /admin/campaigns               create/pause a campaign
//   POST /admin/sweep                   close stalled sessions
//   GET  /og.svg                        OG/share image (links previewed bare)
//
// SSE responses are wrapped in a Transform stream that injects `retry:` and a
// `:ka` keep-alive comment every 15s. Without the keep-alive, Render's proxy
// (and most corporate proxies) close an idle-looking stream, and the surface
// shows a phantom "stream lost".
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { Transform } from 'node:stream';
import * as db from './db.js';
import * as svc from './service.js';
import { makeGate } from './x402.js';
import { makeVaultWriter } from './onchain.js';
import * as auth from './auth.js';
import { CATEGORIES } from './engine.js';
import * as ggl from './google-oauth.js';
import * as wallet from './wallet.js';

const PORT = process.env.PORT || 3120;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(process.cwd(), 'public');

// Sponsor-ops (create/pause campaigns, force a sweep) is an OPERATOR surface.
// It is gated by a shared secret so a judge can't drain a budget from the
// browser console, but it stays usable in a demo without a login screen.
const ADMIN_TOKEN = process.env.WAITSI_ADMIN_TOKEN || null;
// When no admin token is configured (local dev / fresh deploy) the ops routes
// are OPEN — but the response tells you so, rather than pretending to be safe.
function adminAllowed(req) {
  if (!ADMIN_TOKEN) return { ok: true, unguarded: true };
  const hdr = req.headers['authorization'] || '';
  const given = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  return { ok: given === ADMIN_TOKEN, unguarded: false };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, PAYMENT-SIGNATURE');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED');
}

function json(res, code, body) {
  cors(res);
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// Same as json() but attaches a Set-Cookie (login/register/logout).
function jsonSetCookie(res, code, body, cookie) {
  cors(res);
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': cookie,
  });
  res.end(payload);
}

function readBody(req, cap = 1e6) {
  return new Promise((resolve2, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > cap) {
        const e = Object.assign(new Error('body too large'), { status: 413 });
        reject(e);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve2({});
      try { resolve2(JSON.parse(data)); } catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Serve a file from public/ — path-traversal safe (only known extensions, only
// filenames, never ../). GET / -> public/index.html
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const ext = extname(rel);
  if (!MIME[ext]) return false;
  const full = resolve(PUBLIC_DIR, '.' + normalize(rel));
  if (!full.startsWith(PUBLIC_DIR)) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  cors(res);
  res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
  res.end(readFileSync(full));
  return true;
}

// Serve an HTML surface from public/ with the floating Vault · Log-in launcher
// injected (non-invasive string insertion, matching the old GET / behaviour).
function serveHtml(res, file) {
  const full = resolve(PUBLIC_DIR, file);
  if (!existsSync(full)) return false;
  let html = readFileSync(full, 'utf8');
  if (!html.includes('/launcher.js')) {
    html = html.replace('</body>', '<script src="/launcher.js?v=1"></script></body>');
  }
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
  return true;
}

function sseWrite(res, { event, id, data }) {
  if (event) res.write(`event: ${event}\n`);
  if (id !== undefined) res.write(`id: ${id}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

// Open an SSE response: headers, retry hint, keep-alive comments. Returns a
// writer that survives proxy buffering.
function openSse(req, res) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15_000);
  const shutdown = () => { clearInterval(ka); };
  req.on('close', shutdown);
  res.on('close', shutdown);
  return { write: (ev) => sseWrite(res, ev), close: shutdown };
}

function route(path) {
  return path.replace(/\/+$/, '') || '/';
}

// A test-only coin faucet. The full shop happy-path (buy -> own -> effect
// applied) needs a balance big enough for a 250-coin upgrade, which would mean
// streaming 250 real seconds. Gated behind an explicit env flag so it can never
// be enabled by accident in a deployed service.
const TEST_FAUCET = process.env.WAITSI_TEST_FAUCET === '1';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = route(url.pathname);
  const method = req.method;
  const query = Object.fromEntries(url.searchParams);

  try {
    if (method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (method === 'GET' && path === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'waitsi',
        version: 2,
        uptime: process.uptime(),
        streams: svc.activeStreamCount(),
        maxWaitSeconds: svc.MAX_WAIT_SECONDS,
      });
    }

    // OG image — a shared/profiled link previously previewed as a bare URL.
    if (method === 'GET' && path === '/og.svg') {
      const handle = (query.handle || 'a builder').replace(/[^\w.-]/g, '').slice(0, 24);
      return svgOg(res, handle || 'a builder');
    }

    // POST /users — upsert a builder
    if (method === 'POST' && path === '/users') {
      const body = await readBody(req);
      const handle = (body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      const user = await svc.getOrCreateUser(handle);
      return json(res, 201, { id: user.id, handle: user.handle });
    }

    // POST /waits/start — start a wait session { handle, agentKey }
    if (method === 'POST' && path === '/waits/start') {
      const body = await readBody(req);
      const handle = (body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      return json(res, 201, await svc.startWait({ handle, agentKey: body.agentKey }));
    }

    // GET /waits/active?handle= — multi-agent snapshot (JSON fallback)
    if (method === 'GET' && path === '/waits/active') {
      const handle = (query.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      return json(res, 200, await svc.getActiveWaits({ handle }));
    }

    // GET /waits/hub?handle= — ONE SSE stream driving ALL concurrent agents.
    // The v1 build had the /waits/active JSON but nothing rendered it; a page
    // with three agents open had no way to watch them together.
    if (method === 'GET' && path === '/waits/hub') {
      const handle = (query.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      const io = openSse(req, res);
      const stop = await svc.hubWait({
        handle,
        onEvent: (ev) => { try { io.write({ event: 'hub', data: ev }); } catch { /* closed */ } },
      });
      req.on('close', () => { stop && stop(); io.close(); });
      res.on('close', () => { stop && stop(); io.close(); });
      return;
    }

    // POST /waits/:id/tick — live world growth { handle, token } (capped)
    const tickMatch = path.match(/^\/waits\/(\d+)\/tick$/);
    if (method === 'POST' && tickMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.getLiveWait({
        handle: body.handle, token: body.token, sessionId: Number(tickMatch[1]),
      }));
    }

    // POST /waits/:id/verify — server-truth attestation of an externally
    // observed wait. The CLI reports what it observed; the server decides what
    // that is worth and stamps the session.
    const verifyMatch = path.match(/^\/waits\/(\d+)\/verify$/);
    if (method === 'POST' && verifyMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.verifyAttendance({
        handle: body.handle,
        token: body.token,
        sessionId: Number(verifyMatch[1]),
        observedSeconds: body.observedSeconds,
        source: body.source,
      }));
    }

    // GET /waits/:id/stream?handle=&token= — SSE live stream (surface animator)
    const streamMatch = path.match(/^\/waits\/(\d+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const handle = (query.handle || '').trim();
      const token = (query.token || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      // Validate ownership BEFORE sending headers so an error can still be JSON.
      const user = await db.getOrCreateUser(handle);
      const sess = await db.getActiveSession(Number(streamMatch[1]));
      if (!sess || sess.user_id !== user.id) {
        return json(res, 404, { error: 'session not found or not yours' });
      }
      if (!token || sess.token !== token) {
        return json(res, 401, { error: 'invalid or missing session token' });
      }
      const io = openSse(req, res);
      io.write({ event: 'open', data: { ok: true, sessionId: Number(streamMatch[1]) } });
      const stop = await svc.streamWait({
        handle, sessionId: Number(streamMatch[1]), token,
        onEvent: (ev) => { try { io.write({ event: 'message', data: ev }); } catch { /* closed */ } },
      });
      req.on('close', () => { stop && stop(); io.close(); });
      res.on('close', () => { stop && stop(); io.close(); });
      return;
    }

    // POST /waits/:id/complete — bank the wait { handle, token, attendedTicks }
    const completeMatch = path.match(/^\/waits\/(\d+)\/complete$/);
    if (method === 'POST' && completeMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.completeWait({
        handle: body.handle,
        token: body.token,
        sessionId: Number(completeMatch[1]),
        attendedTicks: body.attendedTicks,
        agentKey: body.agentKey,
      }));
    }

    // POST /waits/:id/abandon — user closed mid-wait { handle, token }
    const abandonMatch = path.match(/^\/waits\/(\d+)\/abandon$/);
    if (method === 'POST' && abandonMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.abandonWait({
        handle: body.handle, token: body.token, sessionId: Number(abandonMatch[1]),
      }));
    }

    // POST /payouts — Builder paid to wait: claim earned balance { handle, token }
    if (method === 'POST' && path === '/payouts') {
      const body = await readBody(req);
      return json(res, 201, await svc.claimPayout({ handle: body.handle, token: body.token }));
    }

    // POST /payouts/:voucher/redeem — cash the voucher (single-use)
    const redeemMatch = path.match(/^\/payouts\/(WV-[A-Za-z0-9_-]+)\/redeem$/);
    if (method === 'POST' && redeemMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.redeemPayout({
        voucher: redeemMatch[1], txRef: body.txRef,
      }));
    }

    // GET /shop/:handle — the coin sink
    const shopMatch = path.match(/^\/shop\/(.+)$/);
    if (method === 'GET' && shopMatch) {
      const handle = decodeURIComponent(shopMatch[1]);
      return json(res, 200, await svc.getShop(handle));
    }

    // POST /shop/:handle/buy { key } — buy/level up an upgrade
    const buyMatch = path.match(/^\/shop\/(.+)\/buy$/);
    if (method === 'POST' && buyMatch) {
      const body = await readBody(req);
      const handle = decodeURIComponent(buyMatch[1]);
      return json(res, 201, await svc.buyUpgrade({ handle, key: body.key }));
    }

    // POST /shop/:handle/cosmetic { key } — buy a cosmetic unlock
    const cosMatch = path.match(/^\/shop\/(.+)\/cosmetic$/);
    if (method === 'POST' && cosMatch) {
      const body = await readBody(req);
      const handle = decodeURIComponent(cosMatch[1]);
      return json(res, 201, await svc.buyCosmetic({ handle, key: body.key }));
    }

    // GET /profile/:handle — the shareable builder page
    const profileMatch = path.match(/^\/profile\/(.+)$/);
    if (method === 'GET' && profileMatch) {
      const handle = decodeURIComponent(profileMatch[1]);
      return json(res, 200, await svc.getProfile(handle));
    }

    // GET /board/:handle — the persistent scoreboard (vault view)
    if (method === 'GET' && path.startsWith('/board/')) {
      const handle = decodeURIComponent(path.slice('/board/'.length));
      return json(res, 200, await svc.getBoard(handle));
    }

    // GET /leaderboard?limit= — public "$CMNS Vault" scoreboard
    if (method === 'GET' && path === '/leaderboard') {
      const limit = query.limit ? Number(query.limit) : 20;
      const builders = await svc.getLeaderboard(limit);
      return json(res, 200, { total: builders.length, builders });
    }

    // GET /discoveries — eligible sponsor catalog (the live allocation pool)
    if (method === 'GET' && path === '/discoveries') {
      return json(res, 200, await svc.getDiscoveries());
    }

    // GET /sponsor/:id — the advertiser's delivery report
    const sponsorMatch = path.match(/^\/sponsor\/(\d+)$/);
    if (method === 'GET' && sponsorMatch) {
      const report = await db.sponsorReport(Number(sponsorMatch[1]));
      if (!report) return json(res, 404, { error: 'no such campaign' });
      return json(res, 200, report);
    }

    // GET /vault — global vault/sponsor stats (the judge-facing numbers)
    if (method === 'GET' && path === '/vault') {
      return json(res, 200, await svc.getVaultStats());
    }

    // POST /v1/sponsor/fund — REAL x402 on-chain top-up of a discovery budget.
    // No PAYMENT-SIGNATURE header -> 402 + challenge. With a valid header,
    // WAITSI verifies the EIP-712 signature AND the on-chain USDC Transfer to
    // payTo (replay ring in `payments`), then seeds the discovery's spendable
    // budget from the verified asset-backed payment. Every `discovery` /
    // `sponsor_rev` credit this budget later emits is therefore REAL money.
    if (method === 'POST' && path === '/v1/sponsor/fund') {
      const body = await readBody(req);
      const discoveryId = Number(body?.discoveryId);
      if (!discoveryId) return json(res, 400, { error: 'discoveryId required (an integer)' });
      const gate = makeGate({ db });
      if (!gate.configured) {
        return json(res, 503, {
          error: 'x402_not_configured',
          detail: 'set WAITSI_X402_PAYTO (or export X402_EXECUTOR_PK) + a funded executor to receive on-chain settlement',
        });
      }
      const resource = `sponsor-fund-${discoveryId}`;
      const header = req.headers['payment-signature'];
      if (!header) return gate.send402(res, resource);
      try {
        const { payer, txHash } = await gate.verifyPayment(header);
        const disco = await db.getDiscovery(discoveryId);
        if (!disco) return json(res, 404, { error: 'unknown discovery' });
        const amt = gate.cfg.priceAtomic;
        const funded = await db.fundDiscoveryBudget(discoveryId, Number(amt));
        // Anchor the REAL settlement as an on-chain, tamper-evident receipt.
        const anchored = await makeVaultWriter().anchor({
          txHash, amountMicro: Number(amt), discoveryId,
        });
        return json(res, 200, {
          funded: true,
          discoveryId,
          amountMicro: Number(amt),
          priorRemaining: disco.budget_remaining,
          budgetRemaining: funded.budget_remaining,
          budgetTotal: funded.budget_total,
          txHash,
          payer,
          anchor: anchored,
        });
      } catch (e) {
        const code = e.code || (e.status ? String(e.status) : '');
        const K = ['payment_already_used', 'payment_not_settled', 'signer_mismatch', 'amount_mismatch',
          'chain_mismatch', 'payto_mismatch', 'asset_mismatch'];
        if (K.includes(code)) return gate.send402(res, resource, code, e.message);
        throw e;
      }
    }

    // ---- accounts (WAITSI-native auth: scrypt + HttpOnly session cookie) ----
    if (method === 'POST' && path === '/account/register') {
      const body = await readBody(req);
      const r = await auth.register(body.handle, body.password);
      if (!r.ok) return json(res, r.status || 400, { error: r.error });
      return jsonSetCookie(res, 201, { user: r.user }, auth.sessionCookie(r.token));
    }
    if (method === 'POST' && path === '/account/login') {
      const body = await readBody(req);
      const r = await auth.login(body.handle, body.password);
      if (!r.ok) return json(res, r.status || 401, { error: r.error });
      return jsonSetCookie(res, 200, { user: r.user }, auth.sessionCookie(r.token));
    }
    if (method === 'POST' && path === '/account/logout') {
      await auth.logout(req);
      return jsonSetCookie(res, 200, { ok: true }, auth.clearSessionCookie());
    }
    // ---- Google Sign-In (client-side only: GIS ID token, JWKS-verified, no secret) ----
    if (method === 'GET' && path === '/auth/google/config') {
      return json(res, 200, {
        configured: ggl.googleConfigured(),
        clientId: ggl.googleClientId() || null,   // the SPA's GIS button needs the full ID
      });
    }
    // Accept a Google ID token delivered by the GIS client, verify it (public
    // JWKS, aud === client id), bind the sub, and mint the normal session.
    if (method === 'POST' && path === '/auth/google/token') {
      const body = await readBody(req);
      const r = await ggl.loginWithGoogleToken({ credential: body?.credential, db });
      if (!r.ok) return json(res, r.status || 500, { error: r.error, detail: r.detail });
      const token = auth.newSessionToken();
      await db.createSession(r.user.id, token, auth.sessionExpiry());
      return jsonSetCookie(res, 200, { user: r.user }, auth.sessionCookie(token));
    }
    // ---- Wallet identity (SIWE): issue a challenge to sign ----
    if (method === 'POST' && path === '/wallet/challenge') {
      const body = await readBody(req);
      const address = wallet.normalizeAddress(body?.address);
      if (!address) return json(res, 400, { error: 'valid wallet address required' });
      const nonce = wallet.newNonce();
      await db.createWalletChallenge(nonce, address);
      const host = (req.headers?.host || '').split(',')[0].trim();
      const uri = String(body?.uri || `https://${host}/`);
      const message = wallet.buildSiwe({ domain: host, address, nonce, uri, statement: body?.statement });
      return json(res, 201, { address, nonce, message, chainId: wallet.WALLET_CHAIN_ID, expiresInSeconds: Math.floor(wallet.TTL / 1000) });
    }
    // ---- Wallet login: verify the signed challenge and mint a session ----
    if (method === 'POST' && path === '/wallet/login') {
      const body = await readBody(req);
      const v = await wallet.verifyWalletSignature({ address: body?.address, message: body?.message, signature: body?.signature });
      if (!v.ok) return json(res, 400, { error: v.error });
      const chall = await db.consumeWalletChallenge(v.nonce, v.address, wallet.TTL);
      if (!chall) return json(res, 400, { error: 'nonce invalid, expired, or already used' });
      const existing = await db.findUserByWallet(v.address);
      let user = existing;
      if (!user) user = await db.upsertUserByWallet(v.address, `w_${v.address.slice(2, 10).toLowerCase()}`);
      if (!user) return json(res, 409, { error: 'wallet already bound to another account' });
      const token = auth.newSessionToken();
      await db.createSession(user.id, token, auth.sessionExpiry());
      return jsonSetCookie(res, 200, { user: { id: user.id, handle: user.handle, wallet: user.wallet_address } }, auth.sessionCookie(token));
    }
    // ---- Attach a wallet to the signed-in account (payout destination) ----
    if (method === 'POST' && path === '/account/wallet/attach') {
      const me = await auth.fromRequest(req);
      if (!me) return json(res, 401, { error: 'sign in to attach a wallet' });
      const body = await readBody(req);
      const v = await wallet.verifyWalletSignature({ address: body?.address, message: body?.message, signature: body?.signature });
      if (!v.ok) return json(res, 400, { error: v.error });
      const chall = await db.consumeWalletChallenge(v.nonce, v.address, wallet.TTL);
      if (!chall) return json(res, 400, { error: 'nonce invalid, expired, or already used' });
      const updated = await db.setUserWallet(me.id, v.address);
      if (!updated) return json(res, 409, { error: 'wallet already attached to another account' });
      return json(res, 200, { user: { id: updated.id, handle: updated.handle, wallet: updated.wallet_address } });
    }
    if (method === 'GET' && path === '/account/me') {
      const me = await auth.fromRequest(req);
      if (!me) return json(res, 401, { error: 'not signed in' });
      const walletAddr = await db.getUserWallet(me.id);
      return json(res, 200, { user: { id: me.id, handle: me.handle, wallet: walletAddr }, savedViews: await db.listSavedViews(me.id) });
    }
    // Save results/history per user — the whole point of sign-in. Public to
    // read the dashboard; saving requires a session.
    if (method === 'POST' && path === '/api/saved') {
      const me = await auth.fromRequest(req);
      if (!me) return json(res, 401, { error: 'sign in to save' });
      const body = await readBody(req);
      const label = String(body.label || '').trim().slice(0, 80);
      if (!label) return json(res, 400, { error: 'label required' });
      const summary = typeof body.summary === 'string' ? body.summary.slice(0, 4000) : JSON.stringify(body.summary || {});
      return json(res, 201, { saved: await db.createSavedView(me.id, label, summary) });
    }
    if (method === 'GET' && path === '/api/saved') {
      const me = await auth.fromRequest(req);
      if (!me) return json(res, 401, { error: 'sign in to view' });
      return json(res, 200, { savedViews: await db.listSavedViews(me.id) });
    }
    // The Vault — the judge-facing "the $CMNS is REAL" surface: every funded
    // top-up (real on-chain x402 payments) + rail + on-chain anchor status.
    if (method === 'GET' && path === '/api/vault') {
      const gate = makeGate({ db });
      const vault = makeVaultWriter();
      const rail = {
        live: gate.configured, chainId: gate.cfg.chainId, asset: gate.cfg.asset,
        payTo: gate.cfg.payTo, priceMicro: gate.cfg.priceAtomic.toString(),
      };
      let receiptCount = null, anchorReachable = false;
      if (vault.address) {
        try {
          const c = await vault.pc.readContract({ address: vault.address, abi: vault.abi, functionName: 'receiptCount' });
          receiptCount = Number(c); anchorReachable = true;
        } catch { /* RPC unreachable */ }
      }
      const anchor = { configured: vault.ready, address: vault.address, chainId: vault.chainId, onChainReceipts: receiptCount, reachable: anchorReachable };
      const payments = await db.listPayments(50);
      const vaultStats = await svc.getVaultStats();
      return json(res, 200, { rail, anchor, payments, vaultStats });
    }

    // ---- sponsor-ops (admin) ----
    if (method === 'GET' && path === '/admin/campaigns') {
      const gate = adminAllowed(req);
      if (!gate.ok) return json(res, 401, { error: 'admin token required' });
      return json(res, 200, { unguarded: gate.unguarded, campaigns: await svc.getCampaigns() });
    }

    if (method === 'POST' && path === '/admin/campaigns') {
      const gate = adminAllowed(req);
      if (!gate.ok) return json(res, 401, { error: 'admin token required' });
      const body = await readBody(req);
      return json(res, 201, await svc.upsertCampaign(body));
    }

    if (method === 'POST' && path === '/admin/sweep') {
      const gate = adminAllowed(req);
      if (!gate.ok) return json(res, 401, { error: 'admin token required' });
      const body = await readBody(req);
      // NOTE: `Number(x) || 300` is wrong here — Number(0) is 0 (falsy), so an
      // explicit `stalledAfter: 0` ("sweep everything streamless, now") silently
      // became a 300-second window and closed nothing. Check for a real number
      // instead of relying on truthiness.
      const raw = Number(body.stalledAfter);
      const closed = await svc.sweepStalledSessions({
        stalledAfter: Number.isFinite(raw) ? raw : 300,
      });
      return json(res, 200, { closed, count: closed.length });
    }

    // Test-only coin faucet — see TEST_FAUCET. Exists so the shop's happy path
    // (buy -> own -> effect applied) is actually exercised by the suite, rather
    // than only its refusal paths, without streaming 250 real seconds.
    if (TEST_FAUCET && method === 'POST' && path === '/admin/test/grant') {
      const body = await readBody(req);
      const handle = (body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      const coins = Math.floor(Number(body.coins) || 0);
      const user = await svc.getOrCreateUser(handle);
      const world = await db.grantCoins(user.id, coins);
      return json(res, 200, { handle, coins: world.coins });
    }

    // Static surface — the wait-surface UI itself (GET / -> wait-surface)
    if (method === 'GET' && path === '/account' && serveStatic(res, '/account.html')) {
      return;
    }
    if (method === 'GET' && path === '/vaults' && serveStatic(res, '/vault.html')) {
      return;
    }
    // Marketing landing — GET / and /index.html → landing.html
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return serveHtml(res, 'landing.html');
    }
    // The wait-surface product page — moved to /surface so / owns the landing.
    if (method === 'GET' && path === '/surface') {
      return serveHtml(res, 'index.html');
    }
    if (method === 'GET' && serveStatic(res, path)) {
      return;
    }

    return json(res, 404, { error: 'not found', path });
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error(e);
    // Never write headers twice — a throw after a partial response used to
    // crash the process with ERR_HTTP_HEADERS_SENT.
    if (res.headersSent) {
      try { res.end(); } catch { /* already gone */ }
      return;
    }
    return json(res, code, { error: e.message || 'internal error' });
  }
});

// The share image: a tiny hand-rolled SVG (no image deps, no build step).
function svgOg(res, handle) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0B0E0C"/>
  <g fill="none" stroke="#212B23" stroke-width="1">
    ${Array.from({ length: 24 }, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="630"/>`).join('')}
    ${Array.from({ length: 13 }, (_, i) => `<line x1="0" y1="${i * 50}" x2="1200" y2="${i * 50}"/>`).join('')}
  </g>
  <circle cx="600" cy="250" r="120" fill="none" stroke="#B8FF4F" stroke-width="2" opacity="0.5"/>
  <circle cx="600" cy="250" r="80" fill="#141C12" stroke="#2E3A2E"/>
  <text x="600" y="265" text-anchor="middle" font-family="monospace" font-size="52" fill="#B8FF4F">LVL</text>
  <text x="600" y="450" text-anchor="middle" font-family="sans-serif" font-size="72" font-weight="700" fill="#E9F3E3">@${handle}</text>
  <text x="600" y="510" text-anchor="middle" font-family="monospace" font-size="30" fill="#9CA98F">paid to wait · the commons grows</text>
  <text x="600" y="575" text-anchor="middle" font-family="monospace" font-size="26" fill="#B8FF4F">WAITSI — the waiting layer for AI</text>
</svg>`;
  cors(res);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' });
  res.end(svg);
}

await db.initSchema();
// Boot-time housekeeping: a restart (or a free-tier sleep) strands any session
// that was mid-wait. Close them honestly instead of leaving them "active"
// forever where they could later be settled against a stale client number.
// Same falsy-zero trap as the sweep route: `Number('0') || 300` ignores an
// explicit 0. Resolve the numeric value properly, defaulting only when unset.
const STALL_SECONDS = process.env.WAITSI_STALL_SECONDS === undefined
  ? 300
  : (Number.isFinite(Number(process.env.WAITSI_STALL_SECONDS))
      ? Number(process.env.WAITSI_STALL_SECONDS)
      : 300);
svc.sweepStalledSessions({ stalledAfter: STALL_SECONDS })
  .then((closed) => { if (closed.length) console.log(`swept ${closed.length} stalled session(s)`); })
  .catch((e) => console.error('stall sweep failed:', e.message));

// A test-only coin faucet — see TEST_FAUCET. Routed through the real
// request handler, like every other endpoint.
// (inserted above, inside the router)

const started = server.listen(PORT, HOST, () => {
  console.log(`WAITSI backend up on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => { db.closeDb().then(() => process.exit(0)); });
process.on('SIGTERM', () => { db.closeDb().then(() => process.exit(0)); });
