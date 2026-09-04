// Integration tests for WAITSI core mechanics. Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3199;
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const TOTAL_MICRO = 1_000_000;

before(async () => {
  process.env.PORT = String(PORT);
  process.env.WAITSI_DB_PATH = `/tmp/waitsi_test_${Date.now()}.db`;
  // re-init schema by importing fresh modules via the server process
  proc = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), stdio: 'ignore' });
  // wait for health
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  // seed discoveries by hitting a direct import through the running server? Simpler: seed via a child seed run against same DB path.
  await new Promise((resolve) => {
    const s = spawn(process.execPath, ['src/seed.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: { ...process.env },
    });
    s.on('exit', resolve);
  });
});

after(() => {
  if (proc) proc.kill();
});

test('health is ok', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('wait session: start -> allocated discovery -> complete banks world + ledger', async () => {
  const started = await req('POST', '/waits/start', { handle: 'alice', agentKey: 'render' });
  assert.equal(started.status, 201);
  assert.equal(started.body.world.level, 1);
  assert.ok(started.body.session.token && started.body.session.token.length >= 24);
  assert.ok(started.body.discovery && started.body.discovery.sponsor);
  const sessionId = started.body.session.id;
  const token = started.body.session.token;

  // idempotent: same session+tick grows world (live)
  await req('POST', `/waits/${sessionId}/tick`, { handle: 'alice', token });
  await req('POST', `/waits/${sessionId}/tick`, { handle: 'alice', token });

  const done = await req('POST', `/waits/${sessionId}/complete`, {
    handle: 'alice', token, attendedTicks: 30, agentKey: 'render',
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.session.status, 'completed');
  assert.equal(done.body.session.seconds, 30);
  assert.equal(done.body.session.xpEarned, 30);
  assert.equal(done.body.world.xp, 32); // 30 completed + 2 ticks
  assert.ok(done.body.level.level >= 1);
  assert.ok(done.body.discovery.builderCoins >= 0);

  const board = await req('GET', '/board/alice');
  assert.equal(board.body.completedWaits, 1);
  assert.equal(board.body.world.xp, 32);
  // ledger has wait_xp exactly = xp * 1e6
  const waitXp = board.body.ledger.find((l) => l.kind === 'wait_xp');
  assert.equal(waitXp.total, 32 * TOTAL_MICRO);
});

test('level-up unlocks a new scene and needs exponential ticks', async () => {
  const started = await req('POST', '/waits/start', { handle: 'bob' });
  const sessionId = started.body.session.id;
  const token = started.body.session.token;
  const done = await req('POST', `/waits/${sessionId}/complete`, {
    handle: 'bob', token, attendedTicks: 80,
  });
  assert.equal(done.body.level.level >= 2, true);
  assert.notEqual(done.body.level.looking, 'an open field of prompts');
});

test('session already completed returns 409 (no double-bank)', async () => {
  const started = await req('POST', '/waits/start', { handle: 'carol' });
  const sessionId = started.body.session.id;
  const token = started.body.session.token;
  await req('POST', `/waits/${sessionId}/complete`, { handle: 'carol', token, attendedTicks: 10 });
  const again = await req('POST', `/waits/${sessionId}/complete`, { handle: 'carol', token, attendedTicks: 10 });
  assert.equal(again.status, 409);
});

test('unknown/foreign session returns 404', async () => {
  const r = await req('POST', '/waits/999999/complete', { handle: 'mallory', token: 'wv_x', attendedTicks: 10 });
  assert.equal(r.status, 404);
});

test('missing handle is rejected', async () => {
  const r = await req('POST', '/waits/start', {});
  assert.equal(r.status, 400);
});

// --- NEW: session-token auth -------------------------------

test('state-changing calls reject a missing session token (401)', async () => {
  const started = await req('POST', '/waits/start', { handle: 'auth_none' });
  const sessionId = started.body.session.id;
  const tick = await req('POST', `/waits/${sessionId}/tick`, { handle: 'auth_none' });
  assert.equal(tick.status, 401);
  const done = await req('POST', `/waits/${sessionId}/complete`, { handle: 'auth_none', attendedTicks: 5 });
  assert.equal(done.status, 401);
  const ab = await req('POST', `/waits/${sessionId}/abandon`, { handle: 'auth_none' });
  assert.equal(ab.status, 401);
});

test('a wrong session token is rejected (401)', async () => {
  const started = await req('POST', '/waits/start', { handle: 'auth_wrong' });
  const sessionId = started.body.session.id;
  const done = await req('POST', `/waits/${sessionId}/complete`, { handle: 'auth_wrong', token: 'wv_not_the_token', attendedTicks: 5 });
  assert.equal(done.status, 401);
});

test('a valid token is rejected for a different handle (403)', async () => {
  const started = await req('POST', '/waits/start', { handle: 'auth_own' });
  const sessionId = started.body.session.id;
  const token = started.body.session.token;
  const done = await req('POST', `/waits/${sessionId}/complete`, { handle: 'auth_evil', token, attendedTicks: 5 });
  assert.equal(done.status, 403);
});

test('SSE stream rejects a missing/incorrect token (401 before headers)', async () => {
  const started = await req('POST', '/waits/start', { handle: 'auth_sse' });
  const s = started.body.session;
  const bad = await fetch(`${base}/waits/${s.id}/stream?handle=auth_sse`).then((r) => ({ status: r.status }));
  assert.equal(bad.status, 401);
  const okResp = await fetch(`${base}/waits/${s.id}/stream?handle=auth_sse&token=${s.token}`);
  assert.equal(okResp.status, 200);
  assert.match(okResp.headers.get('content-type'), /text\/event-stream/);
  await okResp.body?.cancel?.(); // close the stream so the server interval stops
});