// Service layer: orchestrates wait sessions -> world + discovery + ledger.
import * as db from './db.js';
import { createHash } from 'node:crypto';
import { applyLevels, formatMicro } from './world.js';
import { pickDiscovery, buildRewardBundle, MICRO } from './engine.js';

export function getOrCreateUser(handle) {
  return db.getOrCreateUser(handle);
}

// ---- Session-scoped authorization -----------------------------------------
// Every state-changing call is scoped to an owned session via its bearer token:
//   404  session id unknown (nothing here, nothing to learn)
//   401  missing / mismatched session token
//   403  token is valid but the presented handle isn't that session's owner
function authorize({ sessionId, handle, token }) {
  const session = db.getActiveSession(sessionId);
  if (!session) {
    const err = new Error('session not found');
    err.status = 404;
    throw err;
  }
  if (!token || session.token !== token) {
    const err = new Error('invalid or missing session token');
    err.status = 401;
    throw err;
  }
  if (handle) {
    const owner = db.getUserById(session.user_id);
    if (!owner || owner.handle !== handle) {
      const err = new Error('session not yours');
      err.status = 403;
      throw err;
    }
  }
  return session;
}

// ---- SSE live stream — pushes a world tick every second so the surface
// animates WITHOUT the client polling. Each tick banks 1s into the world and
// the ledger (Everything Counts). Ends when the session leaves 'active'
// (completed/abandoned) or the client disconnects. Returns a stop() fn.
export function streamWait({ handle, sessionId, token, onEvent }) {
  authorize({ sessionId, handle, token });
  const user = db.getOrCreateUser(handle);
  let session = db.getActiveSession(sessionId);

  // initial snapshot: world + level so the surface hydrates instantly.
  const w0 = db.getWorld(user.id);
  const l0 = applyLevels(w0.level, w0.xp);
  onEvent({
    type: 'hello',
    session: { id: session.id, status: session.status, startedAt: session.started_at },
    world: { ...w0, xpIntoLevel: l0.intoLevel, needForNext: l0.needForNext, looking: l0.looking },
  });

  const timer = setInterval(() => {
    session = db.getActiveSession(sessionId); // re-read so an external complete ends it
    if (!session) return stop();
    if (session.status !== 'active') return stop(); // completed/abandoned elsewhere
    const world = db.spendTimeInWorld(user.id, 1); // bank 1 live second
    db.appendLedger({
      user_id: user.id,
      session_id: session.id,
      kind: 'wait_xp',
      amount_micro: MICRO,
      reason: `live stream tick ${session.agent_key || 'agent'}`,
    });
    const lvl = applyLevels(world.level, world.xp);
    onEvent({
      type: 'tick',
      world: { ...world, xpIntoLevel: lvl.intoLevel, needForNext: lvl.needForNext, looking: lvl.looking },
      session: { id: session.id, status: session.status },
    });
  }, 1000);

  function stop() { clearInterval(timer); }
  return stop;
}

// Start a wait: create the session, return world state + an allocated discovery
// surface so the client can render the fun layer WHILE the agent thinks.
export function startWait({ handle, agentKey }) {
  const user = db.getOrCreateUser(handle);
  const session = db.startSession(user.id, agentKey);

  const world = db.getWorld(user.id);
  const discoveries = db.listActiveDiscoveries();
  const discovery = pickDiscovery(discoveries, session.id, user.id);

  return {
    session: {
      id: session.id,
      status: session.status,
      startedAt: session.started_at,
      token: session.token, // bearer — required on tick/complete/abandon/stream
    },
    user: { id: user.id, handle: user.handle },
    world,
    discovery: discovery
      ? {
          id: discovery.id,
          sponsor: discovery.sponsor,
          title: discovery.title,
          category: discovery.category,
          surface: discovery.surface,
        }
      : null,
  };
}

// During a wait, the client polls the world so the fun layer visibly grows.
export function getLiveWait({ handle, token, sessionId }) {
  authorize({ sessionId, handle, token });
  const user = db.getOrCreateUser(handle);
  const session = db.getActiveSession(sessionId);
  const world = db.spendTimeInWorld(user.id, 1); // live tick (client polls ~1/sec)
  // Every rewarded second counts toward the ledger (no attribution games) —
  // the live tick is banked immediately so board reconciles with world state.
  db.appendLedger({
    user_id: user.id,
    session_id: session.id,
    kind: 'wait_xp',
    amount_micro: MICRO,
    reason: `live wait tick ${session.agent_key || 'agent'}`,
  });
  return { world, session: { id: session.id, status: session.status } };
}

// Complete a wait: bank XP/coins into the world, attribute discovery revenue,
// write ledger entries. Everything counts; nothing is toggleable.
export function completeWait({ handle, token, sessionId, attendedTicks, agentKey }) {
  const session = authorize({ sessionId, handle, token });
  if (session.status === 'completed') {
    const err = new Error('session already completed');
    err.status = 409;
    throw err;
  }
  const user = db.getOrCreateUser(handle);

  const ticks = Math.max(1, Math.floor(attendedTicks || 0));
  // Re-derive the same discovery that was shown during startWait (deterministic
  // pick by session+user seed) so the attribution matches the surface rendered.
  const sessionsDiscovery = (() => {
    const all = db.listActiveDiscoveries();
    if (!all.length) return null;
    return pickDiscovery(all, session.id, user.id);
  })();

  // World reward: 1 xp + 1 coin per attended second.
  const bundle = buildRewardBundle({
    discovery: sessionsDiscovery,
    attendedTicks: ticks,
    waitXp: ticks,
    waitCoins: ticks,
  });

  // Bank world.
  const world = db.spendTimeInWorld(user.id, bundle.wait.xp);
  // Level-up roll.
  const leveled = applyLevels(world.level, world.xp);
  let finalWorld = world;
  if (leveled.level !== world.level) {
    finalWorld = db.bumpLevel(user.id, leveled.level, leveled.looking);
  }

  // Ledger.
  db.appendLedger({
    user_id: user.id,
    session_id: session.id,
    kind: 'wait_xp',
    amount_micro: bundle.wait.xp * MICRO,
    reason: `wait xp for ${ticks}s ${agentKey || 'agent'} wait`,
  });
  if (bundle.discovery) {
    db.appendLedger({
      user_id: user.id,
      session_id: session.id,
      discovery_id: bundle.discovery.discoveryId,
      kind: 'discovery',
      amount_micro: bundle.discovery.builderCoins,
      reason: `builder share (${bundle.discovery.attendedTicks}s @ ${bundle.discovery.sponsor})`,
    });
    // Sponsor pays the network for reach; also credit compute subsidy.
    db.appendLedger({
      user_id: user.id,
      session_id: session.id,
      discovery_id: bundle.discovery.discoveryId,
      kind: 'sponsor_rev',
      amount_micro: bundle.discovery.computeSubsidy,
      reason: `compute subsidy from ${bundle.discovery.sponsor}`,
    });
    db.chargeDiscoveryBudget(bundle.discovery.discoveryId, bundle.discovery.networkMicro);
  }

  db.db.prepare(
    `UPDATE wait_sessions SET status='completed', ended_at=datetime('now'), seconds=?,
       xp_earned=?, coins_earned=? WHERE id=?`
  ).run(ticks, bundle.wait.xp, bundle.wait.coins, session.id);

  return {
    session: {
      id: session.id, status: 'completed', seconds: ticks,
      xpEarned: bundle.wait.xp, coinsEarned: bundle.wait.coins,
    },
    world: db.getWorld(user.id),
    level: leveled,
    discovery: bundle.discovery
      ? {
          sponsor: bundle.discovery.sponsor,
          title: bundle.discovery.title,
          attendedTicks: bundle.discovery.attendedTicks,
          builderCoins: bundle.discovery.builderCoins,
          computeSubsidy: bundle.discovery.computeSubsidy,
          builderCoinsStr: formatMicro(bundle.discovery.builderCoins),
          computeSubsidyStr: formatMicro(bundle.discovery.computeSubsidy),
        }
      : null,
  };
}

// Summary board — the persistent scoreboard tying everything to "$CMNS vault".
export function getBoard(userIdOrHandle) {
  const user = typeof userIdOrHandle === 'number'
    ? db.getUserById(userIdOrHandle)
    : db.getOrCreateUser(userIdOrHandle);
  const world = db.getWorld(user.id);
  const level = applyLevels(world.level, world.xp);
  const earned = db.sumEarnedMicro(user.id);
  const claimed = db.sumClaimedMicro(user.id);
  return {
    user: { id: user.id, handle: user.handle },
    world: { ...world, xpIntoLevel: level.intoLevel, needForNext: level.needForNext },
    rank: db.rankOf(user.id),
    leaderboardSize: db.leaderboard(10000).length,
    ledger: db.tallyByKind(user.id),
    totalMicro: db.sumLedger(user.id),
    totalStr: formatMicro(db.sumLedger(user.id)),
    // claimable = earned (wait_xp + builder share) minus already-claimed
    earnedMicro: earned,
    claimedMicro: claimed,
    claimableMicro: earned - claimed,
    claimableStr: formatMicro(earned - claimed),
    claimedStr: formatMicro(claimed),
    completedWaits: db.sessionCount(user.id),
  };
}

// Builder paid to wait — the money moves. Claim the earned (wait XP + builder
// share of discovery revenue) less anything already claimed. Replay-proof:
// a second claim with nothing new settles returns 409. A session bearer token
// proves ownership (any valid owned token).
function voucherFor(userId, micro) {
  const digest = createHash('sha256').update(`waitsi:${userId}:${micro}:claim`).digest('hex').slice(0, 20);
  return `WV-${userId}-${micro}-${digest}`;
}

export function claimPayout({ handle, token }) {
  const user = db.getOrCreateUser(handle);
  if (!token) {
    const err = new Error('session token required');
    err.status = 401;
    throw err;
  }
  const sess = db.getSessionByToken(token);
  if (!sess || sess.user_id !== user.id) {
    const err = new Error('invalid session token or not yours');
    err.status = 401;
    throw err;
  }
  const earned = db.sumEarnedMicro(user.id);
  const claimed = db.sumClaimedMicro(user.id);
  const claimable = earned - claimed;
  if (claimable <= 0) {
    const err = new Error('nothing to claim — balance already settled');
    err.status = 409;
    throw err;
  }
  const payout = db.createPayout({
    user_id: user.id,
    amount_micro: claimable,
    voucher: voucherFor(user.id, claimable),
  });
  return {
    payout: {
      id: payout.id,
      amountMicro: payout.amount_micro,
      amountStr: formatMicro(payout.amount_micro),
      voucher: payout.voucher,
      status: payout.status,
    },
    claimableRemaining: 0,
    earnedStr: formatMicro(earned),
    claimedStr: formatMicro(claimed),
  };
}

// Public leaderboard — the "$CMNS Vault as a public scoreboard."
export function getLeaderboard(limit = 20) {
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  return db.leaderboard(n).map((r) => ({
    rank: r.rank,
    handle: r.handle,
    totalStr: formatMicro(r.total_micro),
    totalMicro: r.total_micro,
    sponsorStr: formatMicro(r.sponsor_micro),
    xp: r.xp,
    level: r.level,
    waits: r.waits,
  }));
}

// Abandon an active session (builder closed the app mid-wait).
export function abandonWait({ handle, token, sessionId }) {
  const session = authorize({ sessionId, handle, token });
  if (session.status !== 'active') {
    const err = new Error('session not active');
    err.status = 409;
    throw err;
  }
  const ended = db.abandonSession(sessionId);
  return { session: { id: ended.id, status: ended.status, seconds: ended.seconds } };
}