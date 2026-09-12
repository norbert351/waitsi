// Unit tests for the pure game math — no server, no DB, instant.
//
// These live apart from the integration suite on purpose: the progression curve
// is deterministic math, and asserting it through a 60-second HTTP wait was the
// slowest and flakiest way to test it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ticksNeeded, cumTicksForLevel, applyLevels, sceneForLevel, badgeForLevel,
  badgesUnlockedBetween, clampAttended, formatMicro, MAX_WAIT_SECONDS,
} from '../src/world.js';
import { buildRewardBundle, splitReward, revShareForTicks, pickDiscovery, BUILDER_SHARE } from '../src/engine.js';
import { classifyAttestation } from '../src/attest.js';
import { effectBps, upgradePrice, findUpgrade, UPGRADES } from '../src/shop.js';

// ---------------------------------------------------------------- the curve

test('the level curve is exponential and monotonic', () => {
  assert.equal(ticksNeeded(1), 60);
  assert.equal(ticksNeeded(2), 96);   // 60 * 1.6
  assert.equal(ticksNeeded(3), 154);  // 60 * 1.6^2

  // Strictly increasing: every level costs more than the last.
  for (let l = 1; l < 40; l++) {
    assert.ok(ticksNeeded(l + 1) > ticksNeeded(l),
      `level ${l + 1} (${ticksNeeded(l + 1)}) must cost more than ${l} (${ticksNeeded(l)})`);
  }
  // Cumulative XP to reach a level is strictly increasing too.
  for (let l = 1; l < 40; l++) {
    assert.ok(cumTicksForLevel(l + 1) > cumTicksForLevel(l));
  }
});

test('applyLevels crosses the right boundaries and never regresses', () => {
  // 0 XP = level 1, nothing banked into it.
  const l0 = applyLevels(1, 0);
  assert.equal(l0.level, 1);
  assert.equal(l0.intoLevel, 0);
  assert.equal(l0.needForNext, 60);

  // One XP short of level 2.
  const l1 = applyLevels(1, 59);
  assert.equal(l1.level, 1);
  assert.equal(l1.intoLevel, 59);

  // Exactly at the level-2 threshold.
  const l2 = applyLevels(1, 60);
  assert.equal(l2.level, 2);
  assert.equal(l2.intoLevel, 0);

  // Deep in: 1000 XP should be several levels up, and re-applying from the
  // reached level must be idempotent (the race that level-up code can hit).
  const l3 = applyLevels(1, 1000);
  assert.ok(l3.level > 2);
  const again = applyLevels(l3.level, 1000);
  assert.equal(again.level, l3.level, 'applying twice must not advance two levels');
  assert.equal(again.intoLevel, l3.intoLevel);

  // A corrupt/absurd XP total must not hang the guard loop.
  const huge = applyLevels(1, 10_000_000);
  assert.ok(huge.level > 10 && huge.level < 10_000);
});

test('scenes rotate and badges unlock in bands', () => {
  const s1 = sceneForLevel(1);
  assert.equal(s1, 'an open field of prompts');
  // The scene list cycles rather than running out.
  assert.equal(sceneForLevel(1), sceneForLevel(1 + 8));
  for (let l = 1; l < 30; l++) assert.ok(typeof sceneForLevel(l) === 'string');

  assert.equal(badgeForLevel(1).key, 'sprout');
  assert.equal(badgeForLevel(2).key, 'sprout', 'still the first band at level 2');
  assert.equal(badgeForLevel(3).key, 'tender');
  assert.equal(badgeForLevel(5).key, 'vinedresser');
  assert.equal(badgeForLevel(20).key, 'eternal');
  assert.equal(badgeForLevel(999).key, 'eternal', 'the top badge is sticky');

  // Only badges crossed BETWEEN the two levels are reported.
  const crossed = badgesUnlockedBetween(1, 5).map((b) => b.key);
  assert.deepEqual(crossed, ['tender', 'vinedresser']);
  assert.deepEqual(badgesUnlockedBetween(3, 3), [], 'no movement -> no badges');
});

// ----------------------------------------------------------- the clamp

test('clampAttended bounds a claim by the server ceiling', () => {
  // A 10-second-old session: the client cannot claim 100000.
  assert.equal(clampAttended(100000, 10), 13); // 10 + tolerance 3
  assert.equal(clampAttended(100000, MAX_WAIT_SECONDS), MAX_WAIT_SECONDS);

  // Honest claims pass through untouched.
  assert.equal(clampAttended(7, 10), 7);
  assert.equal(clampAttended(10, 10), 10);

  // Garbage in -> at least a real second, never negative, never NaN.
  assert.equal(clampAttended(-5, 10), 0);
  assert.equal(clampAttended('abc', 10), 0);
  assert.equal(clampAttended(null, 10), 0);
  assert.equal(clampAttended(undefined, 10), 0);
  assert.equal(clampAttended(1, 0), 1, 'a real session always gets 1 second');

  // The ceiling itself is bounded by the hard per-wait maximum.
  assert.ok(clampAttended(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) <= MAX_WAIT_SECONDS);
});

test('formatMicro renders whole and fractional micro-units', () => {
  assert.equal(formatMicro(7_000_000), '7');
  assert.equal(formatMicro(0), '0');
  assert.equal(formatMicro(3_000_003), '3.0000');
  assert.equal(formatMicro(500_000), '0.5000');
});

// -------------------------------------------------------- reward math

test('the builder/sponsor split is exact and never mints', () => {
  const { builder, subsidy } = splitReward(1000);
  assert.equal(builder, 700);
  assert.equal(subsidy, 300);
  assert.equal(builder + subsidy, 1000, 'the split must sum back to the whole');

  // Integer micro-units: no float dust, and no over-payment.
  for (const n of [1, 7, 11, 999, 12345, 1_000_001]) {
    const s = splitReward(n);
    assert.equal(s.builder + s.subsidy, n, `split of ${n} must be exact`);
    assert.ok(Number.isInteger(s.builder) && Number.isInteger(s.subsidy));
    assert.ok(s.builder <= n && s.subsidy >= 0);
  }
  assert.equal(BUILDER_SHARE, 0.70);
});

test('revShareForTicks prices per thousand attentive ticks', () => {
  const d = { cpm: 2000 }; // 2000 micro per 1000 ticks
  assert.equal(revShareForTicks(d, 1000), 2000);
  assert.equal(revShareForTicks(d, 500), 1000);
  assert.equal(revShareForTicks(d, 0), 0);
});

test('upgrade effects shift the split without minting extra value', () => {
  const discovery = { id: 1, sponsor: 'X', title: 't', category: 'tool', surface: 's', cpm: 10_000 };
  const base = buildRewardBundle({
    discovery, attendedTicks: 1000, waitXp: 1000, waitCoins: 1000, effects: effectBps({}),
  });
  const boosted = buildRewardBundle({
    discovery, attendedTicks: 1000, waitXp: 1000, waitCoins: 1000,
    effects: effectBps({ sponsor_mult: 3 }),
  });
  // The sponsor pays the SAME network amount either way...
  assert.equal(base.discovery.networkMicro, boosted.discovery.networkMicro,
    'an upgrade must not increase what the sponsor is charged');
  // ...the builder just keeps more of it.
  assert.ok(boosted.discovery.builderCoins > base.discovery.builderCoins,
    'the builder share must grow with the upgrade');
  assert.ok(boosted.discovery.builderCoins + boosted.discovery.computeSubsidy
            <= boosted.discovery.networkMicro + boosted.discovery.computeSubsidy,
    'the split can never exceed the network value');
});

test('discovery selection is deterministic per session and honours cpm weighting', () => {
  const pool = [
    { id: 1, sponsor: 'A', cpm: 1000 },
    { id: 2, sponsor: 'B', cpm: 5000 },
    { id: 3, sponsor: 'C', cpm: 2000 },
  ];
  // Same session + user -> same pick, every time (the surface relies on this
  // so a reconnect doesn't swap the sponsor mid-wait).
  const first = pickDiscovery(pool, 42, 7);
  for (let i = 0; i < 20; i++) {
    assert.equal(pickDiscovery(pool, 42, 7).id, first.id, 'the pick must be stable');
  }
  // A different session can pick differently.
  const picks = new Set();
  for (let s = 1; s <= 60; s++) picks.add(pickDiscovery(pool, s, 7).id);
  assert.ok(picks.size > 1, 'selection must vary across sessions');
  // Every eligible sponsor can win — higher cpm just wins more often.
  assert.deepEqual([...picks].sort(), [1, 2, 3], 'all eligible sponsors are reachable');

  // Degenerate pools must not throw.
  assert.equal(pickDiscovery([], 1, 1), null);
  assert.equal(pickDiscovery(null, 1, 1), null);
  assert.ok(pickDiscovery([{ id: 9, cpm: 0 }], 1, 1));
});

// -------------------------------------------------------- attestation

test('attestation classifies by what the server actually observed', () => {
  // No stream at all -> unverified, never promoted.
  assert.equal(classifyAttestation({ streamBanked: 0, attendedSeconds: 10 }), 'declared');
  assert.equal(classifyAttestation({}), 'declared');
  assert.equal(classifyAttestation({ streamBanked: -5, attendedSeconds: 10 }), 'declared');

  // Fully or over-covered -> watched.
  assert.equal(classifyAttestation({ streamBanked: 10, attendedSeconds: 10 }), 'sponsored');
  assert.equal(classifyAttestation({ streamBanked: 12, attendedSeconds: 10 }), 'sponsored');

  // A stream that ran but covered only a fraction of the claim -> partial.
  assert.equal(classifyAttestation({ streamBanked: 3, attendedSeconds: 600 }), 'streamed');
  assert.equal(classifyAttestation({ streamBanked: 1, attendedSeconds: 100 }), 'streamed');

  // Tick-level slack is tolerance, not a downgrade: a watched 10s wait that
  // banked 9 (one in-flight tick lost to a disconnect) is still watched.
  assert.equal(classifyAttestation({ streamBanked: 9, attendedSeconds: 10 }), 'sponsored');
  assert.equal(classifyAttestation({ streamBanked: 8, attendedSeconds: 10 }), 'sponsored');
  // But missing a quarter of the wait is genuinely partial.
  assert.equal(classifyAttestation({ streamBanked: 7, attendedSeconds: 10 }), 'streamed');

  // Streaming with nothing claimed against it is still watched evidence.
  assert.equal(classifyAttestation({ streamBanked: 5, attendedSeconds: 0 }), 'sponsored');
});

// -------------------------------------------------------------- the shop

test('upgrade prices escalate and cap at maxLevel', () => {
  const up = findUpgrade('compute_mult');
  assert.ok(up);
  // Assert the SHAPE, not exact numbers — the economy is a tuning knob and
  // hardcoding 250/750/2250 here meant every price change broke the suite.
  const p0 = upgradePrice(up, 0);
  assert.ok(p0 > 0 && Number.isInteger(p0));
  assert.ok(p0 <= 60, `the first upgrade must be reachable after a short wait (got ${p0})`);
  assert.equal(upgradePrice(up, up.maxLevel), null, 'a maxed upgrade has no next price');
  assert.equal(upgradePrice(null, 0), null);

  // Every level costs strictly more than the one before it.
  for (let l = 0; l < up.maxLevel - 1; l++) {
    assert.ok(upgradePrice(up, l + 1) > upgradePrice(up, l),
      `level ${l + 1} must cost more than ${l}`);
  }
  // Every upgrade's first level is affordable off one short wait + the welcome
  // grant, so a new builder can always buy something.
  for (const u of UPGRADES) {
    assert.ok(upgradePrice(u, 0) <= 180,
      `${u.key} L1 costs ${upgradePrice(u, 0)} — too far from the onboarding grant`);
  }
});

test('effect basis points map to the documented bonuses', () => {
  assert.deepEqual(effectBps({}), { sponsorBonusBps: 0, builderShareBonusBps: 0, xpBonusPer10s: 0 });
  const e = effectBps({ compute_mult: 2, sponsor_mult: 3, xp_boost: 1 });
  assert.equal(e.sponsorBonusBps, 400);      // +2% per level
  assert.equal(e.builderShareBonusBps, 900); // +3% per level
  assert.equal(e.xpBonusPer10s, 1);
  // Missing/unknown keys degrade to zero rather than NaN.
  assert.equal(effectBps({ nonsense: 5 }).sponsorBonusBps, 0);
  assert.equal(effectBps(null).xpBonusPer10s, 0);
});
