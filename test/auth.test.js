// WAITSI-native accounts — real auth, no external provider.
// register -> session cookie -> me; wrong password rejected; saving is gated;
// logout invalidates. Public dashboard stays public.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from './harness.js';

const PORT = 3211;
let base, proc;

before(async () => {
  const booted = await bootServer({ port: PORT, schema: 'auth_' + Date.now() });
  proc = booted.proc;
  base = booted.base;
});
after(() => { if (proc) proc.kill(); });

async function call(method, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get('set-cookie');
  const body_ = await r.json().catch(() => null);
  return { status: r.status, body: body_, cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('register issues a session, /account/me works, dashboard stays public', async () => {
  const h = 'acct_' + Date.now().toString(36);
  const reg = await call('POST', '/account/register', { handle: h, password: 'supersecret1' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.ok(reg.cookie && reg.cookie.startsWith('waitsi_sess='), 'session cookie set');
  assert.equal(reg.body.user.handle, h);

  const me = await call('GET', '/account/me', null, reg.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.handle, h);

  // No cookie -> 401 (gated), but the public leaderboard is still open.
  const anon = await call('GET', '/account/me');
  assert.equal(anon.status, 401);
  const pub = await call('GET', '/leaderboard');
  assert.equal(pub.status, 200);
});

test('duplicate handle is 409; wrong password is 401; right password logs in', async () => {
  const h = 'acct_' + Date.now().toString(36) + 'b';
  await call('POST', '/account/register', { handle: h, password: 'supersecret1' });

  const dup = await call('POST', '/account/register', { handle: h, password: 'supersecret1' });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/account/login', { handle: h, password: 'wrongpass99' });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/account/login', { handle: h, password: 'supersecret1' });
  assert.equal(good.status, 200);
  assert.ok(good.cookie, 'login issues a session');
});

test('save results/history per user: gated, then listed under the session', async () => {
  const h = 'acct_' + Date.now().toString(36) + 'c';
  const reg = await call('POST', '/account/register', { handle: h, password: 'supersecret1' });
  const cookie = reg.cookie;

  // Unsigned-in save is refused.
  const anon = await call('POST', '/api/saved', { label: 'x' });
  assert.equal(anon.status, 401);

  // Signed-in save works.
  const save = await call('POST', '/api/saved', { label: 'My wait view', summary: { xp: 42 } }, cookie);
  assert.equal(save.status, 201, JSON.stringify(save.body));
  assert.equal(save.body.saved.label, 'My wait view');

  // It shows up in this user's history.
  const list = await call('GET', '/api/saved', null, cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.savedViews.length, 1);
  assert.equal(list.body.savedViews[0].label, 'My wait view');

  // A DIFFERENT user does not see it (per-user isolation).
  const h2 = h + 'z';
  const reg2 = await call('POST', '/account/register', { handle: h2, password: 'supersecret1' });
  const list2 = await call('GET', '/api/saved', null, reg2.cookie);
  assert.equal(list2.body.savedViews.length, 0);
});

test('logout clears the session', async () => {
  const h = 'acct_' + Date.now().toString(36) + 'd';
  const reg = await call('POST', '/account/register', { handle: h, password: 'supersecret1' });
  const out = await call('POST', '/account/logout', {}, reg.cookie);
  assert.equal(out.status, 200);
  const me = await call('GET', '/account/me', null, reg.cookie);
  assert.equal(me.status, 401, 'the old session no longer authenticates');
});