// Payouts (Builder paid to wait) + Repeatability-15% persistence. Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bootServer } from './harness.js';

const PORT = 3196;
// Fresh schema per run so parallel test files never collide on the shared DB.
const SCHEMA = 'payouts_' + Date.now();
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

// Start a session and complete it, returning the owning token + complete body.
// Start a session, STREAM it for `attend` seconds so the server banks the real
// wait, then settle. (v2: a client can no longer declare its own seconds — the
// server clamps `attendedTicks` against what it independently observed.)
async function bankWait(handle, attend, agentKey = 'render') {
  const s = await req('POST', '/waits/start', { handle, agentKey });
  // Diagnose the START too — an undefined read on `.session` two lines later is
  // unhelpful; the real cause is whatever /waits/start answered.
  if (!s.body || !s.body.session) {
    throw new Error(`/waits/start returned HTTP ${s.status}: ${JSON.stringify(s.body)} (handle=${handle})`);
  }
  const sid = s.body.session.id;
  const token = s.body.session.token;
  if (attend > 0) {
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
    // Settle on the WALL-CLOCK duration actually streamed — what the real CLI
    // and surface do. The server validates it against its own elapsed clock, so
    // an honest client is never clamped and never under-claims.
    const elapsed = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
    const done = await req('POST', `/waits/${sid}/complete`, {
      handle, token, attendedTicks: elapsed, agentKey,
    });
    // Fail with the ACTUAL body when the settle doesn't return a session, so a
    // malformed response is diagnosable instead of showing up two lines later
    // as "Cannot read properties of undefined".
    if (!done.body || !done.body.session) {
      throw new Error(
        `settle returned HTTP ${done.status} without a session body: ${JSON.stringify(done.body)} `
        + `(handle=${handle} session=${sid} attendedTicks=${elapsed})`,
      );
    }
    return { sid, token, done, verified: done.body.session.seconds };
  }
  const done = await req('POST', `/waits/${sid}/complete`, { handle, token, attendedTicks: attend, agentKey });
  return { sid, token, done, verified: 0 };
}

before(async () => {
  const booted = await bootServer({ port: PORT, schema: SCHEMA });
  proc = booted.proc;
});

after(() => { if (proc) proc.kill(); });

test('payout claim: issue a voucher for earned balance, then reject replay (409)', async () => {
  const { token } = await bankWait('paid_builder', 8); // a real watched wait
  // earned > 0, nothing claimed yet
  const claim = await req('POST', '/payouts', { handle: 'paid_builder', token });
  assert.equal(claim.status, 201);
  assert.ok(claim.body.payout.id >= 1);
  assert.ok(claim.body.payout.amountMicro > 0);
  assert.ok(claim.body.payout.amountStr.length > 0);
  assert.ok(claim.body.payout.voucher.startsWith('WV-'));
  assert.equal(claim.body.payout.status, 'claimed');

  // replay: same token, nothing new to claim -> 409
  const again = await req('POST', '/payouts', { handle: 'paid_builder', token });
  assert.equal(again.status, 409);

  // board reconciles: claimedStr == claimable converted, claimableMicro now 0
  const board = await req('GET', '/board/paid_builder');
  assert.ok(Number(board.body.claimedStr) > 0);
  assert.equal(board.body.claimableMicro, 0);
});

test('payout requires a valid owned session token (401)', async () => {
  const { token } = await bankWait('pay_own', 4);
  const stolen = await req('POST', '/payouts', { handle: 'pay_thief', token });
  assert.equal(stolen.status, 401);
  const missing = await req('POST', '/payouts', { handle: 'pay_own', token: '' });
  assert.equal(missing.status, 401);
});

test('a builder with no earned balance cannot claim (409)', async () => {
  await req('POST', '/users', { handle: 'pay_empty' }); // exists, earned nothing
  const s = await req('POST', '/waits/start', { handle: 'pay_empty' });
  const r = await req('POST', '/payouts', { handle: 'pay_empty', token: s.body.session.token });
  assert.equal(r.status, 409);
});

// --- Repeatability (15%): the persistent world is the repeat hook ----
test('repeat waits build on ONE persistent world (never resets) — the Repeatability hook', async () => {
  // v2: the level boundary is a 60-second wall-clock wait, which is too slow to
  // stream in a suite. What matters for Repeatability is the MECHANISM: the
  // world persists across sessions, strictly grows, and never resets. That is
  // asserted directly; the level curve itself is covered by its own unit test.
  const first = await bankWait('repeat_me', 6);
  // Diagnose a malformed settle with the real body instead of an undefined read.
  assert.ok(first.done && first.done.body && first.done.body.session,
    `first settle returned ${first.done && first.done.status}: ${JSON.stringify(first.done && first.done.body)}`);
  assert.equal(first.done.status, 200);
  // A 6s stream settles at ~5-6s of wall clock. Assert it banked a real wait
  // (not zero, not a clamped sliver) without pinning the exact tick count.
  assert.ok(first.done.body.session.seconds >= 4,
    `first wait banked ${first.done.body.session.seconds}s of a ~6s stream`);

  const board1 = await req('GET', '/board/repeat_me');
  const lvl1 = board1.body.world.level;
  const xp1 = board1.body.world.xp;
  const coins1 = board1.body.world.coins;
  const waits1 = board1.body.completedWaits;

  // second wait on the SAME handle — continued progression, cumulative ledgers
  const second = await bankWait('repeat_me', 6);
  assert.equal(second.done.status, 200);
  const board2 = await req('GET', '/board/repeat_me');
  assert.equal(board2.body.completedWaits, waits1 + 1);
  // world xp strictly grows (not reset to 0 / not per-session)
  assert.ok(board2.body.world.xp > xp1, `xp grew ${xp1} -> ${board2.body.world.xp}`);
  assert.ok(board2.body.world.coins > coins1, `coins grew ${coins1} -> ${board2.body.world.coins}`);
  // level never regresses
  assert.ok(board2.body.world.level >= lvl1);
  // the world is ONE row per builder, not one per wait
  assert.equal(board2.body.world.user_id, board1.body.world.user_id,
    'repeat waits must grow the SAME world row');
  // The scene is a real string (it only rotates on level-up, which needs 60s —
  // covered by the unit suite). What matters here is that the world persisted
  // and kept a coherent scene value across both waits.
  assert.equal(typeof board2.body.world.looking, 'string');
  assert.ok(board2.body.world.looking.length > 0);
  // The ledger accumulated across both waits rather than resetting per-session.
  // Compare like with like: `wait_xp` is the ledger kind denominated in banked
  // seconds, so it must equal the world's xp. (`discovery`/`sponsor_rev` are
  // micro-CMNS revenue — a different unit, deliberately not summed here.)
  const waitXpMicro = board2.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0;
  assert.ok(waitXpMicro > 0, 'the ledger is cumulative across waits');
  assert.equal(board2.body.world.xp, waitXpMicro / 1e6,
    'the world equals the wait_xp ledger that pays it out');
  assert.ok(board2.body.ledger.some((l) => l.kind === 'discovery'),
    'sponsor revenue was attributed across the waits');
});