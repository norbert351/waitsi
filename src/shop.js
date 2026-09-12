// Monetization catalog — the coin sink. Coins earned by waiting are SPENT
// here, which is what turns the reward from a number into progression:
//
//   utility  — permanent, one-time purchases that change how a wait earns
//              (compute multiplier, sponsor multiplier, level, streak shield)
//   cosmetic — permanently unlocked scenes/badges, visible on /me + profile
//
// PRICING (v2, after the attendance clamp made seconds honest).
// Coins accrue 1/second of VERIFIED waiting, plus a first-wait bonus
// (see world.js FIRST_WAIT_BONUS) so a builder can try the shop immediately
// rather than after four unbroken minutes. Against that:
//
//   ~45s  -> the first upgrade (compute_mult L1) — one real build
//   ~3min -> several upgrades + a scene
//   ~20min -> the top cosmetic
//
// Every price is a whole number of coins. The multiplier apply path is in
// spend.js and is deliberately boring: integer basis points, computed
// server-side only.

export const UPGRADES = [
  {
    key: 'compute_mult',
    name: 'Compute Subsidy',
    kind: 'utility',
    blurb: 'Permanently raises the compute subsidy on every sponsored wait.',
    maxLevel: 5,
    price: (lvl) => 45 * Math.pow(3, lvl),       // 45, 135, 405, 1215, 3645
    effect: 'sponsor +2% per level',
  },
  {
    key: 'sponsor_mult',
    name: 'Sponsor Rolodex',
    kind: 'utility',
    blurb: 'Better sponsors find you — a bigger builder share multiplier.',
    maxLevel: 5,
    price: (lvl) => 70 * Math.pow(3, lvl),
    effect: 'builder share +3% per level',
  },
  {
    key: 'streak_shield',
    name: 'Streak Shield',
    kind: 'utility',
    blurb: 'Protects your daily streak for one missed day, once per purchase.',
    maxLevel: 3,
    price: (lvl) => 180 * Math.pow(2, lvl),
    effect: '1 protected day per charge',
  },
  {
    key: 'xp_boost',
    name: 'Vine Graft',
    kind: 'utility',
    blurb: 'The commons grows faster — bonus XP per waited second.',
    maxLevel: 5,
    price: (lvl) => 60 * Math.pow(3, lvl),
    effect: '+1 XP per 10 waited seconds per level',
  },
];

export const COSMETICS = [
  { key: 'scene_neon',    name: 'Neon Log Stream',   price: 120,  scene: 'a neon log stream',        blurb: 'Unlock a scene the commons only shows the persistent.' },
  { key: 'scene_market',  name: 'Agent Marketplace', price: 400,  scene: 'a marketplace of agents',  blurb: 'A busier horizon for your wait.' },
  { key: 'scene_datacenter', name: 'Humming Data Center', price: 900, scene: 'a humming data center', blurb: 'For builders who live in the rack.' },
  { key: 'core_gold',     name: 'Amber Core',        price: 2000, blurb: 'Your growth core burns amber instead of sprout.' },
];

export function findUpgrade(key) {
  return UPGRADES.find((u) => u.key === key) || null;
}
export function findCosmetic(key) {
  return COSMETICS.find((c) => c.key === key) || null;
}

// Price of the NEXT level of an upgrade (level = what you already own).
export function upgradePrice(upgrade, ownedLevel) {
  if (!upgrade || ownedLevel >= upgrade.maxLevel) return null;
  return Math.floor(upgrade.price(ownedLevel));
}

// Integer basis-point effects. 10_000 bps = 1.0x (no bonus).
export function effectBps(upgrades) {
  const u = upgrades || {};
  return {
    sponsorBonusBps: 200 * (u.compute_mult || 0),      // +2% per level
    builderShareBonusBps: 300 * (u.sponsor_mult || 0), // +3% per level
    xpBonusPer10s: 1 * (u.xp_boost || 0),              // +1 xp / 10s per level
  };
}
