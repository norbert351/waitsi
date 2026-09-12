// Integration tests for WAITSI core mechanics. Run: npm run smoke
//
// v2 note: a client can no longer DECLARE how many seconds it earned. The
// server clamps `attendedTicks` against what it independently observed (the SSE
// stream it banked, or wall-clock since the session opened). Tests that used to
// POST `attendedTicks: 80` to a fresh session now have to actually stream, or
// settle at their real age — see the `runWait` helper.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bootServer } from './harness.js';

const PORT = 3199;
// Fresh schema per run so parallel test files never collide on the shared DB.
const SCHEMA = 'api_' + Date.now();
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

// Attach the live stream for `seconds` so the SERVER banks the wait, then
// settle. Returns the session + complete body.
async function streamWait(handle, seconds, agentKey = 'render') {
  const s = await req('POST', '/waits/start', { handle, agentKey });
  const { id, token } = s.body.session;
  const ctl = new AbortController();
  const resp = await fetch(`${base}/waits/${id}/stream?handle=${encodeURIComponent(handle)}&token=${token}`,
    { signal: ctl.signal });
  const reader = resp.body.getReader();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const { done } = await reader.read();
    if (done) break;
  }
  ctl.abort();
  try { await resp.body.cancel(); } catch {}
  const done = await req('POST', `/waits/${id}/complete`, {
    handle, token, attendedTicks: seconds, agentKey,
  });
  return { id, token, done };
}

before(async () => {
  const booted = await bootServer({ port: PORT, schema: SCHEMA });
  proc = booted.proc;
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

  // Live ticks bank real seconds server-side (the poll path is capped by
  // wall-clock, so this is exactly what the poll is allowed to grant).
  const t1 = await req('POST', `/waits/${sessionId}/tick`, { handle: 'alice', token });
  assert.equal(t1.status, 200);
  assert.ok(t1.body.verifiedSeconds >= 1, 'a tick banks the elapsed second');
  await new Promise((r) => setTimeout(r, 1200));
  const t2 = await req('POST', `/waits/${sessionId}/tick`, { handle: 'alice', token });
  assert.equal(t2.status, 200);
  assert.ok(t2.body.verifiedSeconds > t1.body.verifiedSeconds, 'the poll keeps banking');

  const done = await req('POST', `/waits/${sessionId}/complete`, {
    handle: 'alice', token, attendedTicks: 30, agentKey: 'render',
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.session.status, 'completed');
  // The client asked for 30s; the session is ~2s old, so the server grants what
  // it can justify and says so.
  assert.equal(done.body.session.clamped, true);
  assert.ok(done.body.session.seconds >= 2 && done.body.session.seconds <= 40,
    `banked ${done.body.session.seconds}s`);
  assert.equal(done.body.session.xpEarned, done.body.session.seconds);
  assert.equal(done.body.world.xp, done.body.session.seconds);
  assert.ok(done.body.level.level >= 1);
  assert.ok(done.body.discovery.builderCoins >= 0);

  const board = await req('GET', '/board/alice');
  assert.equal(board.body.completedWaits, 1);
  assert.equal(board.body.world.xp, done.body.session.seconds);
  // ledger has wait_xp exactly = xp * 1e6 — the world and the ledger agree
  const waitXp = board.body.ledger.find((l) => l.kind === 'wait_xp');
  assert.equal(waitXp.total, done.body.session.seconds * TOTAL_MICRO);
});

test('level-up unlocks a new scene and needs exponential ticks', async () => {
  // Level 2 needs 60 banked seconds; stream for ~7s to prove the stream and
  // the level math agree without making the suite slow.
  const s = await req('POST', '/waits/start', { handle: 'bob', agentKey: 'render' });
  const { id, token } = s.body.session;
  const ctl = new AbortController();
  const resp = await fetch(`${base}/waits/${id}/stream?handle=bob&token=${token}`, { signal: ctl.signal });
  const reader = resp.body.getReader();
  const started = Date.now();
  while (Date.now() - started < 7000) {
    const { done } = await reader.read();
    if (done) break;
  }
  ctl.abort();
  try { await resp.body.cancel(); } catch {}

  const done = await req('POST', `/waits/${id}/complete`, {
    handle: 'bob', token, attendedTicks: 7, agentKey: 'render',
  });
  assert.equal(done.status, 200);
  assert.ok(done.body.session.seconds >= 5, `banked ${done.body.session.seconds}s`);
  assert.ok(done.body.level.level >= 1);
  assert.ok(done.body.level.needForNext > 0, 'the level curve is exposed');
  // Still level 1 below 60s — the curve is real, not decorative.
  assert.equal(done.body.level.level, 1, 'under 60s stays at level 1');
  assert.equal(done.body.level.looking, 'an open field of prompts');
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