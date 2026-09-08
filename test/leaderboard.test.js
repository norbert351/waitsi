// Leaderboard/rank/abandon + hardening tests. Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3198;
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function runWait(handle, attend, agentKey = 'render') {
  const s = await req('POST', '/waits/start', { handle, agentKey });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const done = await req('POST', `/waits/${sid}/complete`, { handle, token, attendedTicks: attend, agentKey });
  return { sid, token, done };
}

before(async () => {
  process.env.PORT = String(PORT);
  process.env.WAITSI_DB_SCHEMA = 'lb_' + Date.now();
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

test('leaderboard ranks builders by total earned, desc', async () => {
  // alice earns 50s, bob earns 80s -> bob outranks alice
  await runWait('alice', 50);
  await runWait('bob', 80);
  const lb = await req('GET', '/leaderboard?limit=10');
  assert.equal(lb.status, 200);
  const arr = lb.body.builders;
  assert.ok(arr.length >= 2);
  const ranks = arr.map((b) => ({ h: b.handle, t: b.totalMicro }));
  const idxAlice = ranks.findIndex((r) => r.h === 'alice');
  const idxBob = ranks.findIndex((r) => r.h === 'bob');
  assert.ok(idxBob < idxAlice, 'bob (80) should be ranked above alice (50)');
  assert.equal(arr[idxBob].rank, 1);
  assert.equal(arr[idxBob].waits, 1);
});

test('board exposes rank + leaderboard size', async () => {
  const b = await req('GET', '/board/bob');
  assert.equal(b.body.rank, 1);
  assert.ok(b.body.leaderboardSize >= 2);
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
});

test('replay-detection: cloned session id from another handle is 404', async () => {
  const s = await req('POST', '/waits/start', { handle: 'grace' });
  const sid = s.body.session.id;
  const token = s.body.session.token;
  const evil = await req('POST', `/waits/${sid}/complete`, { handle: 'mallory', token, attendedTicks: 100 });
  assert.equal(evil.status, 403); // token valid but not their session
});