// Service layer: orchestrates wait sessions -> world + discovery + ledger.
// Async: the underlying store is PostgreSQL (see db.js).
import * as db from './db.js';
import { createHash } from 'node:crypto';
import { applyLevels, formatMicro } from './world.js';
import { pickDiscovery, buildRewardBundle, MICRO } from './engine.js';

export async function getOrCreateUser(handle) {
  return db.getOrCreateUser(handle);
}

// ---- Session-scoped authorization -----------------------------------------
// Every state-changing call is scoped to an owned session via its bearer token:
//   404  session id unknown (nothing here, nothing to learn)
//   401  missing / mismatched session token
//   403  token is valid but the presented handle isn't that session's owner
async function authorize({ sessionId, handle, token }) {
  const session = await db.getActiveSession(sessionId);
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
    const owner = await db.getUserById(session.user_id);
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
// the ledger (Everything Counts). Ends when the session leaves 'active'.
// Returns a stop() fn.
export async function streamWait({ handle, sessionId, token, onEvent }) {
  await authorize({ sessionId, handle, token });
  const user = await db.getOrCreateUser(handle);

  // initial snapshot: world + level so the surface hydrates instantly.
  const w0 = await db.getWorld(user.id);
  const l0 = applyLevels(w0.level, w0.xp);
  const session0 = await db.getActiveSession(sessionId);
  onEvent({
    type: 'hello',
    session: { id: session0.id, status: session0.status, startedAt: session0.started_at },
    world: { ...w0, xpIntoLevel: l0.intoLevel, needForNext: l0.needForNext, looking: l0.looking },
  });

  let timer;
  async function tick() {
    try {
      const session = await db.getActiveSession(sessionId); // re-read so an external complete ends it
      if (!session || session.status !== 'active') return stop(); // completed/abandoned elsewhere
      const world = await db.spendTimeInWorld(user.id, 1); // bank 1 live second
      await db.appendLedger({
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
    } catch (e) {
      stop(); // a DB error kills the stream rather than spam errors
    }
  }

  function stop() { if (timer) clearInterval(timer); }
  timer = setInterval(() => { tick(); }, 1000);
  return stop;
}

// Start a wait: create the session, return world state + an allocated discovery
// surface so the client can render the fun layer WHILE the agent thinks.
export async function startWait({ handle, agentKey }) {
  const user = await db.getOrCreateUser(handle);
  const session = await db.startSession(user.id, agentKey);

  const world = await db.getWorld(user.id);
  const discoveries = await db.listActiveDiscoveries();
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
export async function getLiveWait({ handle, token, sessionId }) {
  await authorize({ sessionId, handle, token });
  const user = await db.getOrCreateUser(handle);
  const session = await db.getActiveSession(sessionId);
  const world = await db.spendTimeInWorld(user.id, 1); // live tick (client polls ~1/sec)
  await db.appendLedger({
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
export async function completeWait({ handle, token, sessionId, attendedTicks, agentKey }) {
  const session = await authorize({ sessionId, handle, token });
  if (session.status === 'completed') {
    const err = new Error('session already completed');
    err.status = 409;
    throw err;
  }
  const user = await db.getOrCreateUser(handle);

  const ticks = Math.max(1, Math.floor(attendedTicks || 0));
  // Re-derive the same discovery that was shown during startWait (deterministic
  // pick by session+user seed) so the attribution matches the surface rendered.
  const all = await db.listActiveDiscoveries();
  const sessionsDiscovery = all.length ? pickDiscovery(all, session.id, user.id) : null;

  // World reward: 1 xp + 1 coin per attended second.
  const bundle = buildRewardBundle({
    discovery: sessionsDiscovery,
    attendedTicks: ticks,
    waitXp: ticks,
    waitCoins: ticks,
  });

  // Bank world.
  let world = await db.spendTimeInWorld(user.id, bundle.wait.xp);
  // Level-up roll.
  const leveled = applyLevels(world.level, world.xp);
  if (leveled.level !== world.level) {
    world = await db.bumpLevel(user.id, leveled.level, leveled.looking);
  }

  // Ledger.
  await db.appendLedger({
    user_id: user.id,
    session_id: session.id,
    kind: 'wait_xp',
    amount_micro: bundle.wait.xp * MICRO,
    reason: `wait xp for ${ticks}s ${agentKey || 'agent'} wait`,
  });
  if (bundle.discovery) {
    await db.appendLedger({
      user_id: user.id,
      session_id: session.id,
      discovery_id: bundle.discovery.discoveryId,
      kind: 'discovery',
      amount_micro: bundle.discovery.builderCoins,
      reason: `builder share (${bundle.discovery.attendedTicks}s @ ${bundle.discovery.sponsor})`,
    });
    await db.appendLedger({
      user_id: user.id,
      session_id: session.id,
      discovery_id: bundle.discovery.discoveryId,
      kind: 'sponsor_rev',
      amount_micro: bundle.discovery.computeSubsidy,
      reason: `compute subsidy from ${bundle.discovery.sponsor}`,
    });
    await db.chargeDiscoveryBudget(bundle.discovery.discoveryId, bundle.discovery.networkMicro);
  }

  await db.completeSession(session.id, { seconds: ticks, xp: bundle.wait.xp, coins: bundle.wait.coins });
  const finalWorld = await db.getWorld(user.id);

  return {
    session: {
      id: session.id, status: 'completed', seconds: ticks,
      xpEarned: bundle.wait.xp, coinsEarned: bundle.wait.coins,
    },
    world: finalWorld,
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
export async function getBoard(userIdOrHandle) {
  const user = typeof userIdOrHandle === 'number'
    ? await db.getUserById(userIdOrHandle)
    : await db.getOrCreateUser(userIdOrHandle);
  const world = await db.getWorld(user.id);
  const level = applyLevels(world.level, world.xp);
  const earned = await db.sumEarnedMicro(user.id);
  const claimed = await db.sumClaimedMicro(user.id);
  const [rank, lbSize, ledger, totalMicro, completedWaits] = await Promise.all([
    db.rankOf(user.id),
    db.leaderboard(10000).then((l) => l.length),
    db.tallyByKind(user.id),
    db.sumLedger(user.id),
    db.sessionCount(user.id),
  ]);
  return {
    user: { id: user.id, handle: user.handle },
    world: { ...world, xpIntoLevel: level.intoLevel, needForNext: level.needForNext },
    rank,
    leaderboardSize: lbSize,
    ledger,
    totalMicro,
    totalStr: formatMicro(totalMicro),
    earnedMicro: earned,
    claimedMicro: claimed,
    claimableMicro: earned - claimed,
    claimableStr: formatMicro(earned - claimed),
    claimedStr: formatMicro(claimed),
    completedWaits,
  };
}

// Builder paid to wait — the money moves. Claim the earned (wait XP + builder
// share of discovery revenue) less anything already claimed. Replay-proof.
function voucherFor(userId, micro) {
  const digest = createHash('sha256').update(`waitsi:${userId}:${micro}:claim`).digest('hex').slice(0, 20);
  return `WV-${userId}-${micro}-${digest}`;
}

export async function claimPayout({ handle, token }) {
  const user = await db.getOrCreateUser(handle);
  if (!token) {
    const err = new Error('session token required');
    err.status = 401;
    throw err;
  }
  const sess = await db.getSessionByToken(token);
  if (!sess || sess.user_id !== user.id) {
    const err = new Error('invalid session token or not yours');
    err.status = 401;
    throw err;
  }
  const earned = await db.sumEarnedMicro(user.id);
  const claimed = await db.sumClaimedMicro(user.id);
  const claimable = earned - claimed;
  if (claimable <= 0) {
    const err = new Error('nothing to claim — balance already settled');
    err.status = 409;
    throw err;
  }
  const payout = await db.createPayout({
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
export async function getLeaderboard(limit = 20) {
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const rows = await db.leaderboard(n);
  return rows.map((r) => ({
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
export async function abandonWait({ handle, token, sessionId }) {
  const session = await authorize({ sessionId, handle, token });
  if (session.status !== 'active') {
    const err = new Error('session not active');
    err.status = 409;
    throw err;
  }
  const ended = await db.abandonSession(sessionId);
  return { session: { id: ended.id, status: ended.status, seconds: ended.seconds } };
}