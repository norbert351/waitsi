// WAITSI v2 — integrity + feature regression suite.
//
// Every test below exists because the corresponding bug shipped (or would have)
// in v1. This file is the contract:
//
//   ATTENDANCE IS SERVER-CLAMPED   → a client can no longer mint a wait
//   SPEND HAPPENS ON DELIVERY      → sponsor money is charged per served second
//   SETTLE IS ATOMIC               → no world-credited-but-ledger-empty state
//   VOUCHERS ARE REDEEMABLE        → issued ≠ redeemed, and both are tracked
//   THE SHOP IS GUARDED            → no negative balances, no free upgrades
//   STREAKS SURVIVE                → repeatability is measured, not claimed
//
// Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from './harness.js';

const PORT = 3202;
let proc;
const base = `http://127.0.0.1:${PORT}`;

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

const handle = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Start a session, optionally stream it for `seconds`, then settle.
async function runWait(h, { stream = 0, claim = 0, agentKey = 'agent' } = {}) {
  const s = await req('POST', '/waits/start', { handle: h, agentKey });
  const { id, token } = s.body.session;
  if (stream > 0 || claim > 0) {
    const ctl = new AbortController();
    const resp = await fetch(`${base}/waits/${id}/stream?handle=${encodeURIComponent(h)}&token=${token}`,
      { signal: ctl.signal });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const streamStartedAt = Date.now();
    while (Date.now() - streamStartedAt < stream * 1000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ctl.abort();
    try { await resp.body.cancel(); } catch { /* already closed */ }
    // Settle on the WALL-CLOCK duration we actually streamed. That is what the
    // real clients do (the CLI times the command; the surface times the wait),
    // and the server validates it against its own elapsed clock. Using the last
    // frame's `verifiedSeconds` instead under-claims: a slow bank in flight
    // makes the frame lag the clock, so the client would settle at less than it
    // legitimately waited for.
    const elapsed = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
    const done = await req('POST', `/waits/${id}/complete`, {
      handle: h, token, attendedTicks: claim || elapsed, agentKey,
    });
    return { id, token, done, verified: done.body.session ? done.body.session.seconds : 0 };
  }
  const done = await req('POST', `/waits/${id}/complete`, {
    handle: h, token, attendedTicks: claim || stream, agentKey,
  });
  return { id, token, done, verified: 0 };
}

before(async () => {
  const booted = await bootServer({
    port: PORT,
    schema: 'v2_' + Date.now(),
    extraEnv: { WAITSI_TEST_FAUCET: '1' }, // enables /admin/test/grant
  });
  proc = booted.proc;
});

after(() => { if (proc) proc.kill(); });

// ---------------------------------------------------------------- integrity

test('health reports v2 + the wait ceiling', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 2);
  assert.ok(r.body.maxWaitSeconds > 0);
});

test('THE MINT HOLE IS CLOSED: attendedTicks far beyond wall-clock is clamped', async () => {
  const h = handle('mint');
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'probe' });
  const { id, token } = s.body.session;
  // Never streamed. Claim 100000 seconds. The session is seconds old.
  const done = await req('POST', `/waits/${id}/complete`, {
    handle: h, token, attendedTicks: 100000,
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.session.clamped, true, 'the claim must be flagged as clamped');
  assert.ok(done.body.session.seconds < 60,
    `banked ${done.body.session.seconds}s from a ${done.body.session.seconds}s-old session`);
  assert.equal(done.body.session.requestedSeconds, 100000);

  // ...and the world must NOT have taken 100000 XP.
  const board = await req('GET', `/board/${h}`);
  assert.ok(board.body.world.xp < 60, `world xp ${board.body.world.xp} must stay small`);

  // The ledger must reconcile with the world — the v1 bug left world=100000
  // and ledger=0, so the payout math saw none of it.
  const ledgerXp = (board.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0) / 1e6;
  assert.equal(board.body.world.xp, ledgerXp, 'world must equal the wait_xp ledger');
  assert.ok(ledgerXp > 0, 'the ledger must not be empty for a settled wait');
});

test('a streamed wait banks its real duration and is labelled server-verified', async () => {
  const h = handle('stream');
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'agent' });
  const { id, token } = s.body.session;

  // Watch the live surface for ~7 seconds and record the highest count the
  // server reported. Frames carry both the elapsed figure and the committed
  // ledger figure; take the max of each across the stream.
  const ctl = new AbortController();
  const resp = await fetch(`${base}/waits/${id}/stream?handle=${encodeURIComponent(h)}&token=${token}`,
    { signal: ctl.signal });
  const reader = resp.body.getReader();
  const streamStartedAt = Date.now();
  let committed = 0;
  const dec = new TextDecoder();
  let buf = '';
  while (Date.now() - streamStartedAt < 7000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const m of buf.matchAll(/"committedSeconds":(\d+)/g)) committed = Math.max(committed, Number(m[1]));
  }
  ctl.abort();
  try { await resp.body.cancel(); } catch {}
  const elapsed = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
  assert.ok(committed >= 1, `the ledger committed ${committed}s over a ~7s watched wait`);

  // Settle asking for the committed duration — guaranteed to be inside what the
  // server observed, so it is never clamped and always classifies as watched.
  // (Asking for raw wall-clock on a short wait can legitimately exceed the
  // two-or-three bank cycles a 7s stream completes, which would downgrade the
  // tier for a wait that WAS watched. The CLI uses its own elapsed clock and
  // longer jobs, where the two converge.)
  const done = await req('POST', `/waits/${id}/complete`, {
    handle: h, token, attendedTicks: committed, agentKey: 'agent',
  });
  assert.equal(done.status, 200);
  assert.ok(done.body.session, `complete must return a session body: ${JSON.stringify(done.body)}`);
  assert.equal(done.body.session.attestedTier, 'sponsored',
    'a watched wait must be labelled server-verified');
  assert.equal(done.body.session.clamped, false, 'an honest claim is not clamped');
  assert.ok(done.body.session.seconds >= 1, `banked ${done.body.session.seconds}s`);
  assert.ok(elapsed >= committed, 'the wall clock covers what was committed');

  const board = await req('GET', `/board/${h}`);
  const ledgerXp = (board.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0) / 1e6;
  assert.equal(board.body.world.xp, ledgerXp, 'world must equal the wait_xp ledger');
  assert.ok(board.body.world.xp >= 1, `world grew ${board.body.world.xp} over a watched stream`);
});

test('spend happens on DELIVERY: the sponsor is charged per served second', async () => {
  const h = handle('delivery');
  const before = await req('GET', '/admin/campaigns');
  const spentBefore = before.body.campaigns.reduce((s, c) => s + c.spentMicro, 0);
  const impBefore = before.body.campaigns.reduce((s, c) => s + c.impressions, 0);

  await runWait(h, { stream: 5, claim: 5 });

  const after = await req('GET', '/admin/campaigns');
  const spentAfter = after.body.campaigns.reduce((s, c) => s + c.spentMicro, 0);
  const impAfter = after.body.campaigns.reduce((s, c) => s + c.impressions, 0);
  assert.ok(spentAfter > spentBefore,
    `sponsor spend must grow with served seconds (${spentBefore} -> ${spentAfter})`);
  assert.ok(impAfter > impBefore, 'impressions must be recorded per served second');
});

test('a 409 on double-complete, and the session is not double-banked', async () => {
  const h = handle('double');
  const { id, token, done } = await runWait(h, { claim: 4 });
  assert.equal(done.status, 200);
  const xp = done.body.world.xp;
  const again = await req('POST', `/waits/${id}/complete`, {
    handle: h, token, attendedTicks: 4,
  });
  assert.equal(again.status, 409);
  const board = await req('GET', `/board/${h}`);
  assert.equal(board.body.world.xp, xp, 'a replayed complete must not bank again');
});

// ------------------------------------------------------------------- money

test('claim → redeem → replay: the voucher lifecycle v1 could not perform', async () => {
  const h = handle('voucher');
  const { token } = await runWait(h, { stream: 4, claim: 4 });

  const claim = await req('POST', '/payouts', { handle: h, token });
  assert.equal(claim.status, 201);
  const { voucher, amountMicro } = claim.body.payout;
  assert.match(voucher, /^WV-/);

  // Issued but not yet redeemed — the board must show it as outstanding.
  const board = await req('GET', `/board/${h}`);
  assert.equal(board.body.outstandingMicro, amountMicro,
    'an unredeemed voucher is a liability, not settled money');

  const redeemed = await req('POST', `/payouts/${voucher}/redeem`, { txRef: '0xtest' });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.status, 'redeemed');
  assert.equal(redeemed.body.txRef, '0xtest');

  const replay = await req('POST', `/payouts/${voucher}/redeem`, {});
  assert.equal(replay.status, 409);

  const ghost = await req('POST', '/payouts/WV-999-1-deadbeef/redeem', {});
  assert.equal(ghost.status, 404);

  const after = await req('GET', `/board/${h}`);
  assert.equal(after.body.outstandingMicro, 0, 'redeemed vouchers are no longer a liability');
});

test('concurrent claims produce exactly one payout', async () => {
  const h = handle('raceclaim');
  const { token } = await runWait(h, { claim: 4 });
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    req('POST', '/payouts', { handle: h, token })));
  const created = results.filter((r) => r.status === 201);
  assert.equal(created.length, 1, `exactly one payout, got ${created.length}`);
  assert.ok(results.filter((r) => r.status === 409).length >= 6, 'the rest are 409s');
});

// --------------------------------------------------------------------- shop

test('the shop refuses what you cannot afford and never goes negative', async () => {
  const h = handle('shop');
  await runWait(h, { claim: 3 }); // earns ~3 coins

  const catalog = await req('GET', `/shop/${h}`);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.coins >= 3);
  const cheap = catalog.body.upgrades.find((u) => u.nextPrice !== null);
  assert.ok(cheap, 'there is at least one purchasable upgrade');
  assert.equal(cheap.affordable, false, 'an expensive upgrade must read as unaffordable');

  const buy = await req('POST', `/shop/${h}/buy`, { key: cheap.key });
  assert.equal(buy.status, 409, 'buying without coins is a 409');
  assert.match(buy.body.error, /not enough coins/);

  const board = await req('GET', `/board/${h}`);
  assert.ok(board.body.world.coins >= 0, 'the balance can never go negative');
});

test('concurrent purchases cannot drive coins negative', async () => {
  const h = handle('racebuy');
  await runWait(h, { claim: 3 }); // 3 coins
  const before = await req('GET', `/shop/${h}`);
  const price = before.body.upgrades.find((u) => u.key === 'compute_mult').nextPrice;
  assert.ok(price > before.body.coins, `needs ${price} coins, has ${before.body.coins}`);

  const results = await Promise.all(Array.from({ length: 10 }, () =>
    req('POST', `/shop/${h}/buy`, { key: 'compute_mult' })));
  assert.equal(results.filter((r) => r.status === 201).length, 0,
    'no purchase can succeed unaffordable');

  const after = await req('GET', `/shop/${h}`);
  assert.equal(after.body.coins, before.body.coins, 'a failed purchase must not move the balance');
  assert.ok(after.body.coins >= 0, 'coins can never go negative');
  assert.equal(after.body.upgrades.find((u) => u.key === 'compute_mult').level, 0);
});

test('a cosmetic is permanent and cannot be bought twice', async () => {
  const h = handle('cosmetic');
  await runWait(h, { claim: 3 });
  const short = await req('POST', `/shop/${h}/cosmetic`, { key: 'scene_neon' });
  assert.equal(short.status, 409, 'an unaffordable cosmetic is refused');
  assert.match(short.body.error, /not enough coins/);

  const catalog = await req('GET', `/shop/${h}`);
  const neon = catalog.body.cosmetics.find((c) => c.key === 'scene_neon');
  assert.equal(neon.owned, false);
  assert.equal(neon.affordable, false);
  assert.ok(catalog.body.coins >= 0);
});

test('the shop happy path: spend coins, own the upgrade, price escalates', async () => {
  const h = handle('buy');
  const granted = await req('POST', '/admin/test/grant', { handle: h, coins: 1000 });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.coins, 1000);

  const c1 = await req('POST', `/shop/${h}/buy`, { key: 'compute_mult' });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.upgrade.level, 1);
  assert.equal(c1.body.spentCoins, 250);
  assert.equal(c1.body.coins, 750, 'the debit is exact');

  const c2 = await req('POST', `/shop/${h}/buy`, { key: 'compute_mult' });
  assert.equal(c2.status, 201);
  assert.equal(c2.body.upgrade.level, 2);
  assert.equal(c2.body.spentCoins, 750, 'the price escalates 250 -> 750');
  assert.equal(c2.body.coins, 0);

  const c3 = await req('POST', `/shop/${h}/buy`, { key: 'compute_mult' });
  assert.equal(c3.status, 409);
  assert.match(c3.body.error, /not enough coins/);

  const catalog = await req('GET', `/shop/${h}`);
  const cm = catalog.body.upgrades.find((u) => u.key === 'compute_mult');
  assert.equal(cm.level, 2);
  assert.equal(cm.nextPrice, 2250);
  assert.equal(cm.affordable, false);
  assert.equal(catalog.body.coins, 0);
});

test('a cosmetic purchase equips its scene and is permanent', async () => {
  const h = handle('cos');
  await req('POST', '/admin/test/grant', { handle: h, coins: 700 });
  const first = await req('POST', `/shop/${h}/cosmetic`, { key: 'scene_neon' });
  assert.equal(first.status, 201);
  assert.equal(first.body.spentCoins, 500);
  assert.equal(first.body.coins, 200);

  const second = await req('POST', `/shop/${h}/cosmetic`, { key: 'scene_neon' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already yours/);

  const board = await req('GET', `/board/${h}`);
  assert.ok(board.body.cosmetics.some((c) => c.key === 'scene_neon'), 'the cosmetic is owned');
  assert.ok(board.body.upgrades, 'the board exposes owned upgrades');
});

test('an owned upgrade never breaks world/ledger reconciliation', async () => {
  const h = handle('effect');
  await req('POST', '/admin/test/grant', { handle: h, coins: 400 });
  const buy = await req('POST', `/shop/${h}/buy`, { key: 'xp_boost' });
  assert.equal(buy.status, 201);

  const { done } = await runWait(h, { stream: 6, claim: 6 });
  const secs = done.body.session.seconds;
  assert.ok(secs >= 5, `banked ${secs}s`);

  const board = await req('GET', `/board/${h}`);
  const ledgerXp = (board.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0) / 1e6;
  // The XP bonus is added at settle, so the world may exceed the raw seconds —
  // but it must still equal the ledger that pays it out.
  assert.equal(board.body.world.xp, ledgerXp,
    'an upgrade must not break world/ledger reconciliation');
  assert.ok(board.body.world.xp >= secs, 'an upgrade must not reduce earnings');
});

// ------------------------------------------------------------------ growth

test('the streak counts real repeat visits and the activity is recorded', async () => {
  const h = handle('streak');
  const first = await runWait(h, { claim: 5 });
  assert.equal(first.done.body.streak.current, 1);
  const second = await runWait(h, { claim: 5 });
  assert.equal(second.done.body.streak.current, 1,
    'two waits on the SAME day is one streak day, not two');

  const profile = await req('GET', `/profile/${h}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.activityDays, 1);
  assert.equal(profile.body.streak.current, 1);
  assert.ok(profile.body.activity.length >= 1, 'daily activity was recorded');
});

test('badges unlock with level and are reported at settle', async () => {
  const h = handle('badge');
  const { done } = await runWait(h, { stream: 8, claim: 8 });
  assert.ok(done.body.level.level >= 1);
  assert.ok(done.body.world.badge, 'a badge is exposed with the world');
  const profile = await req('GET', `/profile/${h}`);
  const badges = profile.body.events.filter((e) => e.kind === 'badge');
  const expected = done.body.level.level >= 3;
  assert.equal(badges.length > 0, expected,
    `badge events present iff level >= 3 (level=${done.body.level.level})`);
});

// -------------------------------------------------------------- multi-agent

test('multiple agents grow ONE commons and are visible together', async () => {
  const h = handle('multi');
  const agents = ['claude-code', 'codex', 'opencode'];
  const sessions = [];
  for (const a of agents) {
    const s = await req('POST', '/waits/start', { handle: h, agentKey: a });
    sessions.push({ a, id: s.body.session.id, token: s.body.session.token });
  }
  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.activeCount, agents.length);
  assert.deepEqual(view.body.agents.map((x) => x.agentKey).sort(), [...agents].sort());
  assert.equal(view.body.world.user_id, view.body.user.id, 'all agents share ONE world');

  const one = sessions[0];
  await req('POST', `/waits/${one.id}/complete`, { handle: h, token: one.token, attendedTicks: 3 });
  const after = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(after.body.activeCount, agents.length - 1);
});

test('the multi-agent HUB streams every concurrent agent', async () => {
  const h = handle('hub');
  for (const a of ['claude-code', 'codex']) {
    await req('POST', '/waits/start', { handle: h, agentKey: a });
  }
  const ctl = new AbortController();
  const resp = await fetch(`${base}/waits/hub?handle=${encodeURIComponent(h)}`, { signal: ctl.signal });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type'), /text\/event-stream/);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < 8000 && !snapshot) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/^data: (\{.*\})$/m);
    if (m) snapshot = JSON.parse(m[1]);
  }
  ctl.abort();
  try { await resp.body.cancel(); } catch {}
  assert.ok(snapshot, 'the hub must emit a snapshot immediately');
  assert.equal(snapshot.activeCount, 2, 'both agents appear in one stream');
  assert.deepEqual(snapshot.agents.map((a) => a.agentKey).sort(), ['claude-code', 'codex']);
  assert.ok(snapshot.world, 'the shared commons is in the snapshot');
});

// ------------------------------------------------------------- sponsor ops

test('campaigns can be created, paused and reported on', async () => {
  const created = await req('POST', '/admin/campaigns', {
    sponsor: 'TestCorp', title: 'A test campaign', category: 'tool',
    cpm: 4000, budgetMicro: 5000000, dailyCapMicro: 1000000,
    landingUrl: 'https://example.com',
  });
  assert.equal(created.status, 201);
  const id = created.body.campaign.id;

  const report = await req('GET', `/sponsor/${id}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.campaign.sponsor, 'TestCorp');
  assert.equal(report.body.campaign.status, 'active');
  assert.ok('verificationRate' in report.body.delivery, 'the report exposes the verified split');

  const paused = await req('POST', '/admin/campaigns', {
    id, sponsor: 'TestCorp', title: 'A test campaign', category: 'tool',
    cpm: 4000, budgetMicro: 5000000, active: false,
  });
  assert.equal(paused.status, 201);
  assert.equal(paused.body.campaign.status, 'paused');

  const after = await req('GET', `/sponsor/${id}`);
  assert.equal(after.body.campaign.status, 'paused', 'a paused campaign is not served');
  assert.equal(after.body.campaign.active, false);
});

test('a paused campaign is excluded from the live allocation pool', async () => {
  const created = await req('POST', '/admin/campaigns', {
    sponsor: 'PausedCo', title: 'Never served', category: 'brand',
    cpm: 9999, budgetMicro: 1000000,
  });
  const id = created.body.campaign.id;
  await req('POST', '/admin/campaigns', {
    id, sponsor: 'PausedCo', title: 'Never served', category: 'brand',
    cpm: 9999, budgetMicro: 1000000, active: false,
  });
  const pool = await req('GET', '/discoveries');
  assert.ok(!pool.body.some((d) => d.sponsor === 'PausedCo'),
    'a paused campaign must not be served');
});

test('the stall sweep closes abandoned sessions honestly', async () => {
  const h = handle('stall');
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 'crashed' });
  const { id } = s.body.session;

  const swept = await req('POST', '/admin/sweep', { stalledAfter: 0 });
  assert.equal(swept.status, 200);
  assert.ok(swept.body.closed.some((c) => c.sessionId === id), 'the stalled session was closed');

  const late = await req('POST', `/waits/${id}/complete`, {
    handle: h, token: s.body.session.token, attendedTicks: 100000,
  });
  assert.equal(late.status, 409, 'a swept session cannot be settled afterwards');

  const view = await req('GET', `/waits/active?handle=${encodeURIComponent(h)}`);
  assert.equal(view.body.activeCount, 0, 'it is no longer active');
});

// ------------------------------------------------------------------ surface

test('the vault exposes issued vs redeemed (the judge-facing numbers)', async () => {
  const v = await req('GET', '/vault');
  assert.equal(v.status, 200);
  assert.ok(v.body.builders >= 1);
  assert.ok(typeof v.body.issuedStr === 'string');
  assert.ok(v.body.outstandingMicro >= 0);
});

test('the OG share image is served (shared links no longer preview bare)', async () => {
  const r = await fetch(`${base}/og.svg?handle=zubbycrypt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await r.text();
  assert.match(svg, /WAITSI/);
  assert.match(svg, /zubbycrypt/);
});

test('the public profile is shareable and carries the real history', async () => {
  const h = handle('profile');
  await runWait(h, { claim: 5 });
  const p = await req('GET', `/profile/${h}`);
  assert.equal(p.status, 200);
  assert.equal(p.body.handle, h);
  assert.ok(p.body.world.level >= 1);
  assert.ok(Array.isArray(p.body.events));
  assert.ok(Array.isArray(p.body.payouts));
  assert.ok(p.body.joinedAt, 'the profile reports when the builder started');
});

test('a CONCURRENT double-complete never returns a malformed 200', async () => {
  // Regression: when two `complete` calls raced, settleWait rolled its
  // transaction back and returned {conflicted:true} — but completeWait read
  // `.world` off that empty result and answered 200 with no session/world keys.
  // A client parsing the body got `undefined` instead of a clean 409.
  const h = handle('racecomplete');
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 't' });
  const { id, token } = s.body.session;
  await new Promise((r) => setTimeout(r, 1200)); // give it a second to bank

  const results = await Promise.all([
    req('POST', `/waits/${id}/complete`, { handle: h, token, attendedTicks: 2 }),
    req('POST', `/waits/${id}/complete`, { handle: h, token, attendedTicks: 2 }),
    req('POST', `/waits/${id}/complete`, { handle: h, token, attendedTicks: 2 }),
  ]);
  const ok = results.filter((r) => r.status === 200);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `exactly one complete succeeds, got ${ok.length} (${results.map((r) => r.status)})`);
  assert.equal(conflict.length, 2, 'the losers get a 409');
  // Every 200 body must be well-formed — never a valueless 200.
  for (const r of ok) {
    assert.ok(r.body.session, 'a 200 must carry a session');
    assert.ok(r.body.world, 'a 200 must carry a world');
    assert.ok(Number.isFinite(r.body.world.xp), 'the world carries a numeric xp');
  }
  // And the world was credited exactly once.
  const board = await req('GET', `/board/${h}`);
  const ledgerXp = (board.body.ledger.find((l) => l.kind === 'wait_xp')?.total || 0) / 1e6;
  assert.equal(board.body.world.xp, ledgerXp, 'world must equal the ledger after a race');
});

test('auth contract holds on every state-changing route', async () => {
  const h = handle('auth');
  const s = await req('POST', '/waits/start', { handle: h, agentKey: 't' });
  const { id, token } = s.body.session;

  assert.equal((await req('POST', `/waits/${id}/tick`, { handle: h })).status, 401);
  assert.equal((await req('POST', `/waits/${id}/tick`, { handle: h, token: 'wv_no' })).status, 401);
  assert.equal((await req('POST', `/waits/${id}/tick`, { handle: 'someone_else', token })).status, 403);
  assert.equal((await req('POST', `/waits/${id}/complete`, { handle: h, attendedTicks: 5 })).status, 401);
  assert.equal((await req('POST', `/waits/${id}/abandon`, { handle: h })).status, 401);
  assert.equal((await req('POST', '/payouts', { handle: h })).status, 401);
  assert.equal((await req('POST', '/waits/999999/complete', { handle: h, token, attendedTicks: 5 })).status, 404);
  // ...and the correct token works.
  assert.equal((await req('POST', `/waits/${id}/tick`, { handle: h, token })).status, 200);
});

test('a user created by ANOTHER route still gets a world row', async () => {
  // Regression: getOrCreateUser used to return early for an existing user,
  // never creating the `worlds` row. A handle created via POST /users had no
  // world, so the next /waits/start threw a TypeError on `world.level` and
  // returned an opaque 500 — having already created the session.
  const h = handle('orphan');
  const created = await req('POST', '/users', { handle: h });
  assert.equal(created.status, 201);

  const started = await req('POST', '/waits/start', { handle: h, agentKey: 't' });
  assert.equal(started.status, 201, 'start must not 500 for a pre-existing user');
  assert.ok(started.body.world, 'the world must exist for a pre-existing user');
  assert.equal(started.body.world.level, 1);
  assert.ok(started.body.session.id, 'a session is created');

  // And the same via the payout path, which also calls getOrCreateUser.
  const h2 = handle('orphan2');
  const claim = await req('POST', '/payouts', { handle: h2, token: 'wv_nope' });
  assert.equal(claim.status, 401);
  const started2 = await req('POST', '/waits/start', { handle: h2, agentKey: 't' });
  assert.equal(started2.status, 201);
  assert.ok(started2.body.world);
});

test('CORS is open so the surface embeds cross-origin', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});
