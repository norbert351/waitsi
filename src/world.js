// World Progression Engine — makes the wait FUN and REPEATABLE.
// Design: the user's persistent "commons" grows the more time they spend
// waiting on agents. XP and coins accrue continuously during a wait.
// Crossing a threshold advances the level and unlocks a new "looking" scene.

// Level thresholds: exponential-ish. Level n needs cumulativeTicks(n).
const BASE = 60;       // ticks to level 1 (60s of waiting)
const GROWTH = 1.6;    // each level needs ~1.6x the prior
const TICK = 1;        // 1 second of real wait = 1 tick

export function ticksNeeded(level) {
  return Math.round(BASE * Math.pow(GROWTH, level - 1));
}

// The "looking at" vocabulary — rotating flavor so each level feels new.
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

export function sceneForLevel(level) {
  return SCENES[(level - 1) % SCENES.length];
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
  while (totalXp >= cumTicksForLevel(level + 1)) {
    level += 1;
  }
  return {
    level,
    intoLevel: totalXp - cumTicksForLevel(level),
    needForNext: ticksNeeded(level),
    looking: sceneForLevel(level),
  };
}

// Human-readable reward format. Everything is integer micro-units.
export function formatMicro(micro) {
  const units = micro / 1_000_000;
  return units.toFixed(units === Math.round(units) ? 0 : 4);
}