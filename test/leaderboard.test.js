// Leaderboard/rank/abandon + hardening tests. Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bootServer } from './harness.js';

const PORT = 3198;
// Fresh schema per run so parallel test files never collide on the shared DB.
const SCHEMA = 'leaderboard_' + Date.now();
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

// Attach the live stream for `attend` seconds so the SERVER banks the wait,
// then settle. v2: a client can no longer declare its own seconds — the poll
// and complete paths both clamp against what the server observed.
async function runWait(handle, attend, agentKey = 'render') {
  const s = await req('POST', '/waits/start', { handle, agentKey });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const ctl = new AbortController();
  const resp = await fetch(`${base}/waits/${sid}/stream?handle=${encodeURIComponent(handle)}&token=${token}`,
    { signal: ctl.signal });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const streamStartedAt = Date.now();
  while (Date.now() - streamStartedAt < attend * 1000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ctl.abort();
  try { await resp.body.cancel(); } catch {}
  // Settle on the WALL-CLOCK duration actually streamed — what the real CLI and
  // surface do. The server validates it against its own elapsed clock, so an
  // honest client is never clamped and never under-claims.
  const elapsed = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
  const done = await req('POST', `/waits/${sid}/complete`, { handle, token, attendedTicks: elapsed, agentKey });
  return { sid, token, done, verified: done.body.session ? done.body.session.seconds : 0 };
}

before(async () => {
  const booted = await bootServer({ port: PORT, schema: SCHEMA });
  proc = booted.proc;
});

after(() => { if (proc) proc.kill(); });

test('leaderboard ranks builders by total earned, desc', async () => {
  // The server decides how much each wait is worth, so the two builders must
  // wait for genuinely different durations. 4s vs 10s gives a margin wider than
  // the ±2s of tick/abort slack a real stream has.
  const a = await runWait('alice', 4);
  const b = await runWait('bob', 10);
  assert.ok(b.verified > a.verified,
    `the fixtures must differ (alice ${a.verified}s vs bob ${b.verified}s)`);

  const lb = await req('GET', '/leaderboard?limit=10');
  assert.equal(lb.status, 200);
  const arr = lb.body.builders;
  assert.ok(arr.length >= 2);
  const ranks = arr.map((x) => ({ h: x.handle, t: x.totalMicro }));
  const idxAlice = ranks.findIndex((r) => r.h === 'alice');
  const idxBob = ranks.findIndex((r) => r.h === 'bob');
  assert.ok(idxBob >= 0 && idxAlice >= 0, 'both builders appear on the board');
  assert.ok(idxBob < idxAlice,
    `bob (${ranks[idxBob]?.t}) should be ranked above alice (${ranks[idxAlice]?.t})`);
  assert.equal(arr[idxBob].rank, 1);
  assert.equal(arr[idxBob].waits, 1);
  assert.ok(arr[idxBob].badge, 'the leaderboard exposes the level badge');
});

test('board exposes rank + leaderboard size', async () => {
  // Self-sufficient: don't depend on a sibling test having created `bob` first.
  // `node --test` runs tests within a file concurrently, so ordering between
  // tests is not guaranteed — a test that assumed it was a latent flake.
  const h = 'rank_' + Date.now();
  await runWait(h, 5);
  const b = await req('GET', `/board/${h}`);
  assert.equal(b.status, 200, `board must answer: ${JSON.stringify(b.body)}`);
  assert.ok(b.body.world, 'the board returns a world');
  assert.ok(b.body.rank >= 1, `a builder with a banked wait has a rank, got ${b.body.rank}`);
  assert.ok(b.body.leaderboardSize >= 1);
});

test('empty/ahead limit clamps to [1,100]', async () => {
  const none = await req('GET', '/leaderboard?limit=');
  assert.ok(none.body.builders.length >= 1);
  const huge = await req('GET', '/leaderboard?limit=9999');
  assert.ok(huge.body.builders.length <= 100);
});

test('abandon an active session returns 200 and marks abandoned', async () => {
  const s = await req('POST', '/waits/start', { handle: 'dave' });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const ab = await req('POST', `/waits/${sid}/abandon`, { handle: 'dave', token });
  assert.equal(ab.status, 200);
  assert.equal(ab.body.session.status, 'abandoned');
});

test('abandoning a completed session returns 409', async () => {
  const { sid, token } = await runWait('erin', 10);
  const ab = await req('POST', `/waits/${sid}/abandon`, { handle: 'erin', token });
  assert.equal(ab.status, 409);
});

test('attendedTicks is clamped (negative/zero coerced to 1)', async () => {
  const s = await req('POST', '/waits/start', { handle: 'frank' });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const d = await req('POST', `/waits/${sid}/complete`, { handle: 'frank', token, attendedTicks: -5 });
  assert.equal(d.body.session.seconds, 1); // never fractional / zero
  assert.equal(d.body.session.requestedSeconds, -5, 'the raw claim is echoed back');
});

test('an absurd claim is clamped to what the server observed, not honoured', async () => {
  // v1 hole: a fresh session claiming 100000 seconds banked 100000 XP with an
  // EMPTY ledger, so the world held value the payout math never saw.
  const s = await req('POST', '/waits/start', { handle: 'greedy' });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const d = await req('POST', `/waits/${sid}/complete`, { handle: 'greedy', token, attendedTicks: 100000 });
  assert.equal(d.status, 200);
  assert.equal(d.body.session.clamped, true);
  assert.ok(d.body.session.seconds < 60, `banked ${d.body.session.seconds}s`);
  assert.equal(d.body.session.attestedTier, 'declared', 'an unstreamed wait is unverified');

  // The world must equal the ledger — no orphaned value.
  const board = await req('GET', '/board/greedy');
  const ledgerXp = (board.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0) / 1e6;
  assert.equal(board.body.world.xp, ledgerXp, 'world must reconcile with the ledger');
  assert.ok(board.body.world.xp < 60);
});

test('replay-detection: cloned session id from another handle is 404', async () => {
  const s = await req('POST', '/waits/start', { handle: 'grace' });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const evil = await req('POST', `/waits/${sid}/complete`, { handle: 'mallory', token, attendedTicks: 100 });
  assert.equal(evil.status, 403); // token valid but not their session
});