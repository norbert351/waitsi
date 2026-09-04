// Payouts (Builder paid to wait) + Repeatability-15% persistence. Run: npm run smoke
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

// Start a session and complete it, returning the owning token + complete body.
async function bankWait(handle, attend, agentKey = 'render') {
  const s = await req('POST', '/waits/start', { handle, agentKey });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const done = await req('POST', `/waits/${sid}/complete`, { handle, token, attendedTicks: attend, agentKey });
  return { sid, token, done };
}

before(async () => {
  process.env.PORT = String(PORT);
  process.env.WAITSI_DB_PATH = `/tmp/waitsi_pay_${Date.now()}.db`;
  proc = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), stdio: 'ignore' });
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

test('payout claim: issue a voucher for earned balance, then reject replay (409)', async () => {
  const { token } = await bankWait('paid_builder', 50); // 50 xp + discovery share
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
  const { token } = await bankWait('pay_own', 10);
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
  const first = await bankWait('repeat_me', 75);   // crosses into lvl 2
  assert.equal(first.done.body.level.level >= 2, true);
  const board1 = await req('GET', '/board/repeat_me');
  const lvl1 = board1.body.world.level;
  const xp1 = board1.body.world.xp;
  const coins1 = board1.body.world.coins;
  const waits1 = board1.body.completedWaits;

  // second wait on the SAME handle — continued progression, cumulative ledgers
  const second = await bankWait('repeat_me', 40);
  const board2 = await req('GET', '/board/repeat_me');
  assert.equal(board2.body.completedWaits, waits1 + 1);
  // world xp strictly grows (not reset to 0 / not per-session)
  assert.ok(board2.body.world.xp > xp1, `xp grew ${xp1} -> ${board2.body.world.xp}`);
  assert.ok(board2.body.world.coins > coins1);
  // level never regresses
  assert.ok(board2.body.world.level >= lvl1);
  // scene rotated toward later flavor (repeatability feels new)
  assert.notEqual(board2.body.world.looking, 'the commons');
});