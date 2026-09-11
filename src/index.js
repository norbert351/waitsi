// WAITSI API server — HTTP + SSE live stream + static surface on PostgreSQL.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import * as db from './db.js';
import * as svc from './service.js';

const PORT = process.env.PORT || 3120;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(process.cwd(), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

function readBody(req) {
  return new Promise((resolve2, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
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
  let rel = pathname === '/' ? '/index.html' : pathname;
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

function sseWrite(res, { event, id, data }) {
  if (event) res.write(`event: ${event}\n`);
  if (id !== undefined) res.write(`id: ${id}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

function route(path) {
  return path.replace(/\/+$/, '') || '/';
}

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
      return json(res, 200, { ok: true, service: 'waitsi', uptime: process.uptime() });
    }

    // POST /users — upsert a builder
    if (method === 'POST' && path === '/users') {
      const body = await readBody(req);
      const handle = (body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      const user = await svc.getOrCreateUser(handle);
      return json(res, 201, user);
    }

    // POST /waits/start — start a wait session { handle, agentKey }
    if (method === 'POST' && path === '/waits/start') {
      const body = await readBody(req);
      const handle = (body.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      return json(res, 201, await svc.startWait({ handle, agentKey: body.agentKey }));
    }

    // POST /waits/:id/tick — live world growth { handle, token }
    const tickMatch = path.match(/^\/waits\/(\d+)\/tick$/);
    if (method === 'POST' && tickMatch) {
      const body = await readBody(req);
      return json(res, 200, await svc.getLiveWait({
        handle: body.handle, token: body.token, sessionId: Number(tickMatch[1]),
      }));
    }

    // GET /waits/:id/stream?handle=&token= — SSE live stream (the surface animator)
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
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      sseWrite(res, { event: 'open', data: { ok: true, sessionId: Number(streamMatch[1]) } });
      const stop = await svc.streamWait({ handle, sessionId: Number(streamMatch[1]), token, onEvent: (ev) => sseWrite(res, { event: 'message', data: ev }) });
      req.on('close', () => stop && stop());
      res.on('close', () => stop && stop());
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

    // GET /board/:handle — the persistent scoreboard (vault view)
    if (method === 'GET' && path.startsWith('/board/')) {
      const handle = decodeURIComponent(path.slice('/board/'.length));
      return json(res, 200, await svc.getBoard(handle));
    }

    // GET /leaderboard?limit= — public "$CMNS Vault" scoreboard
    if (method === 'GET' && path === '/leaderboard') {
      const limit = query.limit ? Number(query.limit) : 20;
      return json(res, 200, { total: (await svc.getLeaderboard(limit)).length, builders: await svc.getLeaderboard(limit) });
    }

    // GET /discoveries — catalog for a sponsor-ops view
    if (method === 'GET' && path === '/discoveries') {
      return json(res, 200, await db.listActiveDiscoveries());
    }

    // GET /waits/active?handle= — every concurrent agent wait for one builder.
    // The multi-agent view: N agents, ONE shared commons they all grow.
    if (method === 'GET' && path === '/waits/active') {
      const handle = (query.handle || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      return json(res, 200, await svc.getActiveWaits({ handle }));
    }

    // Static surface — the wait-surface UI itself (GET / -> wait-surface)
    if (method === 'GET' && serveStatic(res, path)) {
      return;
    }

    return json(res, 404, { error: 'not found', path });
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error(e);
    return json(res, code, { error: e.message || 'internal error' });
  }
});

await db.initSchema();
server.listen(PORT, HOST, () => {
  console.log(`WAITSI backend up on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => { db.closeDb().then(() => process.exit(0)); });
process.on('SIGTERM', () => { db.closeDb().then(() => process.exit(0)); });