// Multi-agent concurrency + atomic-increment tests. Run: npm run smoke
//
// Guards two regressions that are invisible in single-agent use:
//   1. spendTimeInWorld read-modify-write lost updates (12 parallel ticks
//      banked only 2 XP before the fix; the ledger recorded all 12).
//   2. A single global stream timer, which made concurrent agent waits
//      impossible to manage or settle independently.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bootServer } from './harness.js';

const PORT = 3197;
// Fresh schema per run so parallel test files never collide on the shared DB.
const SCHEMA = 'multiagent_' + Date.now();
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const handle = () => 'multi-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

before(async () => {
  const booted = await bootServer({ port: PORT, schema: SCHEMA });
  proc = booted.proc;
});

after(() => { if (proc) proc.kill(); });

test('atomic increments: N parallel ticks never lose a bank (no lost updates)', async () => {
  const h = handle();
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'concurrent' });
  const { id, token } = s.body.session;
  const N = 12;

  // Fire N ticks simultaneously at ONE session — the read-modify-write pattern
  // that previously lost ~83% of them.
  //
  // v2: a tick now banks ELAPSED seconds (not a flat +1), and the total is
  // clamped to wall-clock. So the invariant is no longer "N ticks = N xp" — it
  // is the one that actually protects the payout: whatever the world ends up
  // holding must EQUAL the ledger, and N concurrent writers must not lose each
  // other's increments (which would show up as world < ledger).
  await Promise.all(Array.from({ length: N }, () =>
    req('POST', `/waits/${id}/tick`, { handle: h, token })
  ));

  const board = await req('GET', `/board/${h}`);
  const world = board.body.world;
  const ledgerXp = (board.body.ledger.find((r) => r.kind === 'wait_xp')?.total || 0) / 1_000_000;

  assert.equal(world.xp, ledgerXp, `world xp (${world.xp}) must equal ledger (${ledgerXp}) — no drift`);
  assert.ok(world.xp >= 1, `12 parallel ticks must bank at least one second, got ${world.xp}`);
  // And the bank can never exceed real elapsed time (the clamp holds under load).
  const elapsed = Math.max(1, Math.floor((Date.now() - Date.parse(s.body.session.startedAt)) / 1000));
  assert.ok(world.xp <= elapsed + 3,
    `banked ${world.xp} over ${elapsed}s of wall clock — the clamp must hold under concurrency`);
});

test('multiple agents run concurrently on ONE handle against ONE shared world', async () => {
  const h = handle();
  const agents = ['claude-code', 'codex', 'opencode'];

  const sessions = [];
  for (const agentKey of agents) {
    const s = await req('POST', '/waits/start', { handle: h, agentKey });
    sessions.push({ agentKey, id: s.body.session.id, token: s.body.session.token });
  }

  // distinct sessions
  assert.equal(new Set(sessions.map((s) => s.id)).size, agents.length);

  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.activeCount, agents.length, 'all agents listed as active');
  assert.deepEqual(
    view.body.agents.map((a) => a.agentKey).sort(),
    [...agents].sort(),
    'each agent reported under its own key'
  );
  // one shared world across all agents
  const first = await req('GET', `/board/${h}`);
  assert.equal(view.body.world.user_id, first.body.user.id, 'all agents grow the SAME commons');
});

test('settling one agent leaves the others running', async () => {
  const h = handle();
  const a = await req('POST', '/waits/start', { handle: h, agentKey: 'alpha' });
  const b = await req('POST', '/waits/start', { handle: h, agentKey: 'beta' });
  const c = await req('POST', '/waits/start', { handle: h, agentKey: 'gamma' });

  const done = await req('POST', `/waits/${a.body.session.id}/complete`, {
    handle: h, token: a.body.session.token, attendedTicks: 7, agentKey: 'alpha',
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.session.status, 'completed');

  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.body.activeCount, 2, 'the two unsettled agents keep running');
  assert.ok(!view.body.agents.some((x) => x.sessionId === a.body.session.id), 'settled agent delisted');
  assert.ok(view.body.agents.some((x) => x.sessionId === b.body.session.id));
  assert.ok(view.body.agents.some((x) => x.sessionId === c.body.session.id));
});

test('abandoning one agent delists it without touching the others', async () => {
  const h = handle();
  const a = await req('POST', '/waits/start', { handle: h, agentKey: 'one' });
  const b = await req('POST', '/waits/start', { handle: h, agentKey: 'two' });

  await req('POST', `/waits/${a.body.session.id}/abandon`, { handle: h, token: a.body.session.token });
  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.body.activeCount, 1);
  assert.equal(view.body.agents[0].sessionId, b.body.session.id);
});

test('concurrent streams: world total reconciles with the ledger (no drift)', async () => {
  const h = handle();
  const sessions = [];
  for (const agentKey of ['s1', 's2', 's3']) {
    const s = await req('POST', '/waits/start', { handle: h, agentKey });
    sessions.push({ id: s.body.session.id, token: s.body.session.token, startedAt: s.body.session.startedAt });
  }

  // concurrently tick all three (proxy for concurrent SSE streams banking seconds)
  await Promise.all(Array.from({ length: 9 }, (_, i) => {
    const s = sessions[i % sessions.length];
    return req('POST', `/waits/${s.id}/tick`, { handle: h, token: s.token });
  }));

  const board = await req('GET', `/board/${h}`);
  const ledgerXp = (board.body.ledger.find((r) => r.kind === 'wait_xp')?.total || 0) / 1_000_000;
  assert.equal(board.body.world.xp, ledgerXp, `world (${board.body.world.xp}) vs ledger (${ledgerXp}) drift`);
  assert.ok(board.body.world.xp >= 1, 'the concurrent ticks banked something');
  // One shared commons: the total is a single world, not a per-agent sum.
  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.body.world.user_id, board.body.user.id, 'all agents grow the SAME world row');
});

test('/waits/active requires a handle', async () => {
  const r = await req('GET', '/waits/active');
  assert.equal(r.status, 400);
});

test('concurrent activity still reconciles at payout time', async () => {
  const h = handle();
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'payer' });
  const { id, token } = s.body.session;

  await Promise.all(Array.from({ length: 10 }, () =>
    req('POST', `/waits/${id}/tick`, { handle: h, token })
  ));
  await req('POST', `/waits/${id}/complete`, { handle: h, token, attendedTicks: 10, agentKey: 'payer' });

  const claim = await req('POST', '/payouts', { handle: h, token });
  assert.equal(claim.status, 201, 'payout created on a concurrent-earned balance');
  assert.match(claim.body.payout.voucher, /^WV-/, 'voucher issued on a concurrent-earned balance');

  const replay = await req('POST', '/payouts', { handle: h, token });
  assert.equal(replay.status, 409, 'replay-protected after concurrent earning');
});
