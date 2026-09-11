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

const PORT = 3197;
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
  process.env.PORT = String(PORT);
  process.env.WAITSI_DB_SCHEMA = 'multi_' + Date.now();
  proc = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env } });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((resolve) => {
    const s = spawn(process.execPath, ['src/seed.js'], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env } });
    s.on('exit', resolve);
  });
});

after(() => { if (proc) proc.kill(); });

test('atomic increments: N parallel ticks bank exactly N xp (no lost updates)', async () => {
  const h = handle();
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'concurrent' });
  const { id, token } = s.body.session;
  const N = 12;

  // Fire N ticks simultaneously at ONE session — the read-modify-write pattern
  // that previously lost ~83% of them.
  await Promise.all(Array.from({ length: N }, () =>
    req('POST', `/waits/${id}/tick`, { handle: h, token })
  ));

  const board = await req('GET', `/board/${h}`);
  const world = board.body.world;

  // world xp must equal ledger wait_xp exactly — no drift.
  const ledgerXp = (board.body.ledger.find((r) => r.kind === 'wait_xp')?.total || 0) / 1_000_000;
  assert.equal(world.xp, ledgerXp, `world xp (${world.xp}) must equal ledger (${ledgerXp})`);
  assert.equal(world.xp, N, `expected exactly ${N} xp from ${N} parallel ticks, got ${world.xp}`);
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
    sessions.push({ id: s.body.session.id, token: s.body.session.token });
  }

  // concurrently tick all three (proxy for concurrent SSE streams banking seconds)
  await Promise.all(Array.from({ length: 9 }, (_, i) => {
    const s = sessions[i % sessions.length];
    return req('POST', `/waits/${s.id}/tick`, { handle: h, token: s.token });
  }));

  const board = await req('GET', `/board/${h}`);
  const ledgerXp = (board.body.ledger.find((r) => r.kind === 'wait_xp')?.total || 0) / 1_000_000;
  assert.equal(board.body.world.xp, ledgerXp, `world (${board.body.world.xp}) vs ledger (${ledgerXp}) drift`);
  assert.equal(board.body.world.xp, 9, 'every one of the 9 concurrent ticks banked');
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
