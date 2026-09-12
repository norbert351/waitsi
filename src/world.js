// World Progression Engine — makes the wait FUN and REPEATABLE.
// Design: the user's persistent "commons" grows the more time they spend
// waiting on agents. XP and coins accrue continuously during a wait.
// Crossing a threshold advances the level and unlocks a new "looking" scene.
//
// v2 (2026-09): progression got teeth. Coins are now SPENDABLE (spend.js),
// levels unlock badge scenes and emit milestone events, and the per-level
// curve carries the exponential growth the pitch sold. All math stays
// integer-only in the ledger; only the XP curve uses floats, and every
// value derived from it is floored to an integer before it touches the DB.

// Level thresholds: exponential-ish. Level n needs cumulativeTicks(n).
const BASE = 60;       // ticks to level 1 (60s of waiting)
const GROWTH = 1.6;    // each level needs ~1.6x the prior
const TICK = 1;        // 1 second of real wait = 1 tick

// Hard ceiling on a single settled wait, in seconds (4 hours). Closes the
// "complete with attendedTicks: 100000" mint hole and keeps every ledger
// value inside Postgres INTEGER range (xp * MICRO must stay < 2^31).
export const MAX_WAIT_SECONDS = 4 * 60 * 60;

// Server-side verification tolerance: the client may report more attended
// seconds than the server observed by at most this much (stream connection
// setup, tick-boundary rounding, one missed interval).
export const ATTENDANCE_TOLERANCE = 3;

export function ticksNeeded(level) {
  return Math.round(BASE * Math.pow(GROWTH, level - 1));
}

// The "looking at" vocabulary — rotating flavor so each level feels new.
// Past the end of the list the commons keeps describing itself; that is the
// point (there is no final level).
const SCENES = [
  'an open field of prompts',
  'a half-built scaffold',
  'a rising tower of generations',
  'a marketplace of agents',
  'a humming data center',
  'a neon log stream',
  'a city being vibed into existence',
  'the eternal loading bar',
];

// Badge per level band — unlocks are real, not decoration: the badge shows up
// in /me, on the leaderboard and on the public profile, and it is emitted as
// a `badge` event at settle time.
const BADGES = [
  { at: 1, key: 'sprout',      name: 'Sprout',      blurb: 'First wait banked. The commons noticed.' },
  { at: 3, key: 'tender',      name: 'Tender',      blurb: 'You tend a thing that grows while you wait.' },
  { at: 5, key: 'vinedresser', name: 'Vinedresser', blurb: 'Five levels of dead-time, reclaimed.' },
  { at: 8, key: 'architect',   name: 'Architect',   blurb: 'You build while nothing is building.' },
  { at: 12, key: 'oracle',     name: 'Oracle',      blurb: 'The wait tells you things now.' },
  { at: 20, key: 'eternal',    name: 'Eternal',     blurb: 'You are the loading bar.' },
];

export function sceneForLevel(level) {
  return SCENES[(level - 1) % SCENES.length];
}

// Highest badge unlocked at a level (null below the first band).
export function badgeForLevel(level) {
  let out = null;
  for (const b of BADGES) if (level >= b.at) out = b;
  return out ? { ...out } : null;
}

// Every badge newly crossed between two levels (for settle-time events).
export function badgesUnlockedBetween(fromLevel, toLevel) {
  return BADGES.filter((b) => b.at > fromLevel && b.at <= toLevel).map((b) => ({ ...b }));
}

// For a given level, how much cumulative XP got us there?
export function cumTicksForLevel(level) {
  let cum = 0;
  for (let l = 1; l < level; l++) cum += ticksNeeded(l);
  return cum;
}

// Advance a level after earning XP. Returns final {level, xp into level, newLooking}.
export function applyLevels(currentLevel, totalXp) {
  let level = currentLevel;
  // Guarded loop: a corrupt/absurd xp can't spin this forever.
  let guard = 0;
  while (totalXp >= cumTicksForLevel(level + 1) && guard < 10_000) {
    level += 1;
    guard += 1;
  }
  const badge = badgeForLevel(level);
  return {
    level,
    intoLevel: totalXp - cumTicksForLevel(level),
    needForNext: ticksNeeded(level),
    looking: sceneForLevel(level),
    badge,
  };
}

// Human-readable reward format. Everything is integer micro-units.
export function formatMicro(micro) {
  const units = micro / 1_000_000;
  return units.toFixed(units === Math.round(units) ? 0 : 4);
}

// Clamp a client-reported attended-seconds value into what the server can
// justify: never negative, never above MAX_WAIT_SECONDS, never above the
// server's own observed ceiling (+tolerance).
export function clampAttended(reported, serverCeiling) {
  const r = Math.floor(Number(reported));
  if (!Number.isFinite(r) || r < 0) return 0;
  const cap = Math.max(
    Math.min(MAX_WAIT_SECONDS, Math.floor(serverCeiling) + ATTENDANCE_TOLERANCE),
    1, // a real session always gets at least 1 second of credit
  );
  return Math.min(r, cap);
}
