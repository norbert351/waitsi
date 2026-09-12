// Spend layer — the coin sink, plus the streak/milestone bookkeeping that
// turns a pile of coins into progression.
//
// Invariants (all enforced against the DB, never in app memory):
//   1. You can only buy what you can afford: the debit is a guarded UPDATE
//      (`WHERE coins >= price`), so the balance can never go negative even
//      under concurrent purchases.
//   2. The debit happens BEFORE the grant; if the grant fails the coins are
//      refunded. No purchase can grant an upgrade it didn't pay for.
//   3. Cosmetics/upgrades are permanent and idempotent (ON CONFLICT DO NOTHING
//      + unique guards), so a double-click can't double-charge.
import * as db from './db.js';
import { findUpgrade, findCosmetic, upgradePrice, UPGRADES, COSMETICS, effectBps } from './shop.js';
import { badgeForLevel, badgesUnlockedBetween, sceneForLevel } from './world.js';

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

// ---- effects ---------------------------------------------------------------
export async function effectsFor(userId) {
  const rows = await db.listUpgrades(userId);
  const owned = {};
  for (const r of rows) owned[r.key] = r.level;
  return effectBps(owned);
}

export async function ownedUpgrades(userId) {
  return db.ownedUpgrades(userId);
}

// ---- the shop catalog, priced for this builder ----------------------------
export async function catalog(userId) {
  const owned = await ownedUpgrades(userId);
  const cosmetics = await db.listCosmetics(userId);
  const ownedCos = new Set(cosmetics.map((c) => c.key));
  const world = await db.getWorld(userId);
  return {
    coins: world.coins,
    upgrades: UPGRADES.map((u) => {
      const level = owned[u.key] || 0;
      const next = upgradePrice(u, level);
      return {
        key: u.key, name: u.name, kind: u.kind, blurb: u.blurb, effect: u.effect,
        level, maxLevel: u.maxLevel, nextPrice: next, maxed: next === null,
        affordable: next !== null && world.coins >= next,
      };
    }),
    cosmetics: COSMETICS.map((c) => ({
      key: c.key, name: c.name, blurb: c.blurb, price: c.price,
      owned: ownedCos.has(c.key),
      affordable: world.coins >= c.price,
    })),
  };
}

// ---- purchases ------------------------------------------------------------
export async function buyUpgrade({ handle, key }) {
  const user = await db.getOrCreateUser(handle);
  const upg = findUpgrade(key);
  if (!upg) fail(`unknown upgrade: ${key}`, 404);

  const level = await db.getUpgradeLevel(user.id, key);
  const price = upgradePrice(upg, level);
  if (price === null) fail(`${upg.name} is already at max level`, 409);

  const charged = await db.spendCoins(user.id, price);   // guarded debit
  if (!charged) fail(`not enough coins — ${upg.name} L${level + 1} costs ${price}`, 409);

  try {
    await db.setUpgradeLevel(user.id, key, level + 1);
  } catch (e) {
    await db.grantCoins(user.id, price);                 // refund on failure
    throw e;
  }
  if (key === 'streak_shield') await db.addShields(user.id, 1);

  await db.addEvent(user.id, 'upgrade', `${upg.name} → L${level + 1} (${price} coins)`, { key, level: level + 1 });
  const refreshed = await db.getWorld(user.id);
  return {
    upgrade: { key, name: upg.name, level: level + 1, maxLevel: upg.maxLevel, effect: upg.effect },
    spentCoins: price,
    coins: refreshed.coins,
  };
}

export async function buyCosmetic({ handle, key }) {
  const user = await db.getOrCreateUser(handle);
  const cos = findCosmetic(key);
  if (!cos) fail(`unknown cosmetic: ${key}`, 404);

  const owned = (await db.listCosmetics(user.id)).some((c) => c.key === key);
  if (owned) fail(`${cos.name} is already yours`, 409);

  const charged = await db.spendCoins(user.id, cos.price);
  if (!charged) fail(`not enough coins — ${cos.name} costs ${cos.price}`, 409);

  try {
    await db.ownCosmetic(user.id, key);
  } catch (e) {
    await db.grantCoins(user.id, cos.price);
    throw e;
  }
  // A scene cosmetic equips immediately — you bought it to look at it.
  if (cos.scene) await db.setScene(user.id, cos.scene);

  await db.addEvent(user.id, 'cosmetic', `Unlocked ${cos.name} (${cos.price} coins)`, { key });
  const refreshed = await db.getWorld(user.id);
  return {
    cosmetic: { key, name: cos.name, scene: cos.scene || null },
    spentCoins: cos.price,
    coins: refreshed.coins,
  };
}

// ---- streaks --------------------------------------------------------------
// The day boundary is UTC EVERYWHERE, deliberately.
//
// The first cut computed "today" in JS with `toISOString()` (UTC) while
// `bumpDailyActivity` used Postgres `CURRENT_DATE` (server-local). On a host
// where local != UTC — this VM is a day ahead — the two disagree, so the
// `last_day === today` check never matched and two waits on the SAME day
// incremented the streak twice (measured: expected 1, got 2). One clock, one
// boundary: UTC, computed in JS, and passed to the DB explicitly.
function dayString(d) {
  // Already a 'YYYY-MM-DD' string (the DB hands us one via ::text) — pass it
  // through rather than round-tripping through a Date and risking a day shift.
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date(d).toISOString().slice(0, 10);
}
export function todayUtc() {
  return dayString(new Date());
}
function daysBetween(aIso, bIso) {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Record that a wait landed today and roll the streak forward. A gap of one
// missed day is absorbed by a shield charge if the builder bought one.
export async function touchStreak(userId, { xp = 0, seconds = 0, sessions = 1 } = {}) {
  const streak = await db.getStreak(userId);
  const today = todayUtc();
  // `last_day` is a Postgres DATE; node-pg hands it back as a JS Date at local
  // midnight, so stringify it the same UTC way we wrote it. Reading it raw
  // (e.g. with toString) can land on the previous or next day.
  const last = streak.last_day ? dayString(streak.last_day) : null;

  let current = 0, longest = streak.longest || 0, shields = streak.shields || 0, shielded = false;

  if (last === today) {
    current = streak.current || 1;                    // already counted today
  } else if (!last) {
    current = 1;
  } else {
    const gap = daysBetween(last, today);
    if (gap === 1) {
      current = (streak.current || 0) + 1;            // consecutive
    } else if (gap === 2 && shields > 0) {
      shields -= 1;                                   // one day missed — shield absorbs it
      shielded = true;
      current = (streak.current || 0) + 1;
    } else {
      current = 1;                                    // streak broke
    }
  }
  longest = Math.max(longest, current);
  await db.setStreak(userId, { current, longest, lastDay: today, shields });

  await db.bumpDailyActivity(userId, { seconds, sessions, xp, day: today });

  // Milestone events at 3/7/14/30 days — the repeat hook, made visible.
  const MILESTONES = [3, 7, 14, 30, 60, 100];
  if (MILESTONES.includes(current) && last !== today) {
    await db.addEvent(userId, 'streak', `${current}-day streak — the commons remembers`, { current });
  }
  return { current, longest, shields, shielded };
}

// ---- milestones / badges at settle time -----------------------------------
export async function recordMilestones(userId, { fromLevel, toLevel, seconds, sponsor }) {
  const events = [];
  for (const b of badgesUnlockedBetween(fromLevel, toLevel)) {
    const msg = `Badge unlocked — ${b.name}: ${b.blurb}`;
    await db.addEvent(userId, 'badge', msg, { badge: b.key });
    events.push({ kind: 'badge', badge: b.key, name: b.name, message: msg });
  }
  // Wait-length milestones.
  const WAIT_MILESTONES = [300, 900, 1800, 3600, 7200];
  for (const m of WAIT_MILESTONES) {
    if (seconds >= m) {
      const label = m >= 3600 ? `${m / 3600}h` : `${m / 60}m`;
      const msg = `A single ${label} wait — banked in one sitting`;
      const already = await db.listEvents(userId, 200);
      if (!already.some((e) => e.kind === 'wait_milestone' && e.message === msg)) {
        await db.addEvent(userId, 'wait_milestone', msg, { seconds: m });
        events.push({ kind: 'wait_milestone', message: msg, seconds: m });
      }
    }
  }
  if (sponsor) {
    const msg = `Sponsored wait cleared — ${sponsor} saw your attention`;
    await db.addEvent(userId, 'sponsor', msg, { sponsor });
    events.push({ kind: 'sponsor', message: msg, sponsor });
  }
  return events;
}

export function badgeSummary(level) {
  return badgeForLevel(level);
}

export function sceneFor(level) {
  return sceneForLevel(level);
}
