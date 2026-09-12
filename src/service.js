// Service layer: orchestrates wait sessions -> world + discovery + ledger.
// Async: the underlying store is PostgreSQL (see db.js).
//
// v2 (2026-09) hardening — every change below closes a way to mint value:
//   1. ATTENDANCE IS CLAMPED. A client no longer dictates how many seconds it
//      earned: `complete` accepts min(reported, serverObserved + tolerance,
//      MAX_WAIT_SECONDS). Measured hole before this: a 7-second-old session
//      claiming attendedTicks:100000 banked +100,000 XP with a zero ledger.
//   2. XP-per-second is CAPPED on the fallback poll path so a naive loop can't
//      out-earn the stream it replaces.
//   3. SPEND HAPPENS ON DELIVERY. Every attended stream second writes one
//      idempotent ad_spend row (unique on session+second) that charges the
//      sponsor budget and credits the builder — sponsor money is no longer
//      invisible until settle time.
//   4. SETTLE IS ALL-OR-NOTHING in a transaction, and the ledger insert can no
//      longer overflow INTEGER and abort mid-settle (the old 200s wait threw
//      `value "100000000000" is out of range for type integer` AFTER the world
//      had already been credited, leaving a permanently-active session).
//   5. Payloads are shrunk to the columns the API actually exposes, which
//      keeps every response far inside the 1MB read-body/JSON budget and stops
//      leaking other apps' columns from the shared Neon DB.
import * as db from './db.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { applyLevels, formatMicro, MAX_WAIT_SECONDS, clampAttended } from './world.js';
import { pickDiscovery, buildRewardBundle, MICRO, BUILDER_SHARE, CATEGORIES } from './engine.js';
import { classifyAttestation } from './attest.js';
import { effectsFor, touchStreak, recordMilestones } from './spend.js';

// Columns we are willing to hand back for a user row. The Neon DB is SHARED
// with other apps, so `SELECT *` leaks columns this service doesn't own.
const USER_COLS = 'id, handle, created_at';
const WORLD_COLS = 'user_id, xp, level, coins, looking, updated_at';

// The per-second delivery path must price each second at the SPONSOR's raw
// rate — builder upgrades are applied once, to the whole wait, at settle time.
// Applying them per second too would pay them twice.
const ZERO_EFFECTS = { sponsorBonusBps: 0, builderShareBonusBps: 0, xpBonusPer10s: 0 };

export async function getOrCreateUser(handle) {
  return db.getOrCreateUser(handle);
}

// ---- Session-scoped authorization -----------------------------------------
// Every state-changing call is scoped to an owned session via its bearer token:
//   404  session id unknown (nothing here, nothing to learn)
//   401  missing / mismatched session token
//   403  token is valid but the presented handle isn't that session's owner
// Token comparison is constant-time: a byte-by-byte early-exit comparison
// leaks how much of a guessed token was right.
function tokenMatches(expected, given) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function authorize({ sessionId, handle, token }) {
  const session = await db.getActiveSession(sessionId);
  if (!session) {
    const err = new Error('session not found');
    err.status = 404;
    throw err;
  }
  if (!tokenMatches(session.token, token)) {
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

// ---- Live stream registry ------------------------------------------------
// One interval per ACTIVE session. A builder runs several agents at once, so a
// single global timer would be both wrong (it can only stop one session) and
// unfair (unattended sessions would keep banking XP). Keyed by session id.
//
// v2: also the multi-agent HUB. Every stream opens a lightweight "watcher"
// connection alongside its billing interval, so all N agent panels on one
// page share a single source of truth instead of each polling.
const streams = new Map(); // sessionId -> { stop, startedAt, banked, agentKey, userId }
const watchers = new Map(); // sessionId -> Set<emitFn>

// Wait for a session's in-flight tick to finish before a settle reads it.
// Each stream entry carries the promise of its current tick; a `complete` that
// arrives mid-tick awaits it, so the settle always sees a consistent
// `stream_banked`. Resolves immediately when nothing is streaming.
export async function awaitStreamQuiet(sessionId, timeoutMs = 4000) {
  const entry = streams.get(sessionId);
  if (!entry || !entry.inFlight) return null;
  await Promise.race([
    entry.inFlight.catch(() => {}),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  return db.getActiveSession(sessionId);
}

export function activeStreamCount() {
  return streams.size;
}

export function stopStream(sessionId) {
  const s = streams.get(sessionId);
  if (!s) return false;
  s.stop();
  streams.delete(sessionId);
  return true;
}

export function stopAllStreams() {
  for (const [id, s] of streams) { s.stop(); streams.delete(id); }
  watchers.clear();
}

export function registerWatcher(sessionId, emit) {
  if (!watchers.has(sessionId)) watchers.set(sessionId, new Set());
  watchers.get(sessionId).add(emit);
  return () => {
    const set = watchers.get(sessionId);
    if (!set) return;
    set.delete(emit);
    if (!set.size) watchers.delete(sessionId);
  };
}

function broadcast(sessionId, event) {
  const set = watchers.get(sessionId);
  if (!set) return;
  for (const emit of set) { try { emit(event); } catch { /* dropped watcher */ } }
}

// The public shape of a session for API responses (no token, no internals).
function sessionView(s, extra = {}) {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    agentKey: s.agent_key,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    seconds: s.seconds,
    xpEarned: s.xp_earned,
    coinsEarned: s.coins_earned,
    streamBanked: s.stream_banked,
    attestedTier: s.attested_tier,
    ...extra,
  };
}

// ---- SSE live stream — pushes a world tick every second so the surface
// animates WITHOUT the client polling. Each tick banks 1s into the world, the
// ledger AND the sponsor (spend on delivery). Ends when the session leaves
// 'active'. Returns a stop() fn.
export async function streamWait({ handle, sessionId, token, onEvent }) {
  await authorize({ sessionId, handle, token });
  const user = await db.getOrCreateUser(handle);
  const effects = await effectsFor(user.id);

  const w0 = await db.getWorld(user.id);
  const l0 = applyLevels(w0.level, w0.xp);
  const session0 = await db.getActiveSession(sessionId);

  // The discovery this session is showing (deterministic → stable across
  // reconnects, and the same one `complete` will settle against).
  const eligible = await db.listActiveDiscoveries();
  const discovery = pickDiscovery(eligible, session0.id, user.id);

  onEvent({
    type: 'hello',
    session: sessionView(session0),
    world: { ...w0, xpIntoLevel: l0.intoLevel, needForNext: l0.needForNext, looking: l0.looking, badge: l0.badge },
    discovery: discovery ? publicDiscovery(discovery) : null,
    effects,
    maxWaitSeconds: MAX_WAIT_SECONDS,
  });

  let banked = 0;                 // seconds this stream has banked
  let lastTickAt = Date.now();    // when the previous tick completed
  let streamEntry = null;         // the registry entry, assigned after registration
  // Both timers live in one place so teardown can never miss one. A leaked
  // bank timer keeps charging sponsors after the client is gone.
  let timers = [];
  const stop = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    const entry = streams.get(sessionId);
    if (entry && entry.token === streamToken) {
      entry.stoppedAt = Date.now();
      streams.delete(sessionId);
    }
  };

  async function tick() {
    try {
      const session = await db.getActiveSession(sessionId); // re-read: an external complete ends it
      if (!session || session.status !== 'active') { stop(); return; }
      // Re-check the registry: `stop()` is called on settle/abandon, and an
      // in-flight tick must not keep banking after it. Without this, a settle
      // that landed mid-tick was followed by that tick crediting the world
      // again (measured: world xp 5 -> 7 after the session had completed).
      if (!streams.has(sessionId)) return;
      if (banked >= MAX_WAIT_SECONDS) { stop(); return; }  // hard ceiling per wait

      // ---- Why elapsed-time instead of +1 per tick -------------------------
      // Each tick makes several sequential round-trips to the DB. Against Neon
      // that can exceed the 1s interval, so `setInterval` fires late and the
      // wall clock drifts ahead of the banked total — an 8s wait banked only 4
      // seconds. We bank the ACTUAL elapsed seconds since the last successful
      // tick, so the ledger tracks real time no matter how slow the DB is.
      // The delivery charge still bills one row per second, so the sponsor
      // accounting stays per-second-accurate.
      const nowMs = Date.now();
      const elapsedSec = Math.max(1, Math.round((nowMs - lastTickAt) / 1000));
      const grant = Math.min(elapsedSec, MAX_WAIT_SECONDS - banked);
      lastTickAt = nowMs;
      if (grant <= 0) { stop(); return; }
      const firstSecond = banked + 1;

      // ---- Bank the elapsed seconds ---------------------------------------
      // The credit is CONDITIONAL on the session still being active, checked in
      // the same statement that does the work. A plain `spendTimeInWorld` after
      // an app-level status read is a TOCTOU: a `complete` landing in that
      // window left the world credited for a second the settle had already
      // priced (measured: world xp 5 -> 7 after the session completed).
      const claim = await db.bankIfActive({ userId: user.id, sessionId, seconds: grant, ceiling: MAX_WAIT_SECONDS });
      if (!claim) { stop(); return; }   // the session settled underneath us
      const world = claim.world;
      banked = claim.banked;

      // Commit the applied seconds IMMEDIATELY, in the same statement that
      // advances the world. Everything downstream (attestation, the settle
      // clamp, the hub's verified count) reads `stream_banked`, so it must be
      // durable before this tick can be observed as done. Deferring it to the
      // end of the tick meant an aborted/disconnected stream left the counter
      // behind the seconds it had actually banked — which downgraded a fully
      // watched wait from 'sponsored' to 'streamed'.
      await db.markStreamBanked(sessionId, banked);

      // The hub reads `banked` off the REGISTRY entry, not the closure, so
      // per-agent verified seconds show up live on the multi-agent view.
      if (streamEntry) streamEntry.banked = banked;

      // ---- Delivery + ledger, batched into as few round-trips as possible --
      // A tick makes 1 (bank) + 2-3 (ledger/ad) + 1 (re-read) queries instead of
      // 6+. Against a managed DB at ~300ms/query that is the difference between
      // the stream keeping up with the wall clock and falling behind it.
      const ledgerRows = [{
        user_id: user.id, session_id: session.id,
        kind: 'wait_xp', amount_micro: grant * MICRO,
        reason: `live stream tick x${grant} ${session.agent_key || 'agent'}`,
      }];

      if (discovery) {
        // Price the batch off the sponsor's raw rate (upgrades apply once, at
        // settle, not per second).
        const fresh = await db.getDiscovery(discovery.id);
        const unit = fresh && fresh.active && fresh.budget_remaining > 0
          ? buildRewardBundle({ discovery: fresh, attendedTicks: 1, waitXp: 1, waitCoins: 1, effects: ZERO_EFFECTS })
          : null;
        if (unit && unit.discovery && unit.discovery.networkMicro > 0) {
          // Never bill more seconds than the sponsor can still afford.
          const affordable = Math.max(0, Math.floor(fresh.budget_remaining / unit.discovery.networkMicro));
          const billSeconds = Math.min(grant, affordable || 0);
          if (billSeconds > 0) {
            const paid = await db.recordAdSpendBatch({
              discoveryId: fresh.id,
              sessionId: session.id,
              userId: user.id,
              firstSecond,
              seconds: billSeconds,
              perSecond: {
                amountMicro: unit.discovery.networkMicro,
                builderMicro: unit.discovery.builderCoins,
                subsidyMicro: unit.discovery.computeSubsidy,
                attested: true,
              },
            });
            if (paid.charged > 0) {
              await db.chargeDiscoveryBudget(fresh.id, paid.amountMicro);
              ledgerRows.push({
                user_id: user.id, session_id: session.id, discovery_id: fresh.id,
                kind: 'discovery', amount_micro: paid.builderMicro,
                reason: `builder share x${paid.charged} @ ${fresh.sponsor}`,
              });
              ledgerRows.push({
                user_id: user.id, session_id: session.id, discovery_id: fresh.id,
                kind: 'sponsor_rev', amount_micro: paid.subsidyMicro,
                reason: `compute subsidy x${paid.charged} @ ${fresh.sponsor}`,
              });
            }
          }
        }
      }
      await db.appendLedgerBatch(ledgerRows);

      // Re-read the world so the frame we push is the world we actually
      // committed — pushing the pre-tick row made the surface show a number
      // that was one bank behind.
      const committed = await db.getWorld(user.id);
      const lvl = applyLevels(committed.level, committed.xp);
      const raisePromise = lvl.level > committed.level
        ? db.raiseLevel(user.id, lvl.level, lvl.looking)
        : Promise.resolve(null);
      // Publish the committed world so the (cheap, 1s) frame loop renders the
      // real totals instead of a stale snapshot.
      if (streamEntry && streamEntry.onCommitted) {
        streamEntry.onCommitted(
          { ...committed, xpIntoLevel: lvl.intoLevel, needForNext: lvl.needForNext, looking: lvl.looking, badge: lvl.badge },
        );
      }
      // Push the BANKED frame too, so a listener that only watches committed
      // frames (a test, a log) sees the ledger move without waiting for the
      // next provisional one.
      const event = {
        type: 'tick',
        world: { ...committed, xpIntoLevel: lvl.intoLevel, needForNext: lvl.needForNext, looking: lvl.looking, badge: lvl.badge },
        session: { id: session.id, status: session.status, agentKey: session.agent_key, verifiedSeconds: banked },
        grantedSeconds: grant,
        provisional: false,
      };
      onEvent(event);
      broadcast(sessionId, event); // hub subscribers (the multi-agent view)
      await raisePromise;
    } catch (e) {
      // A DB error kills this stream rather than spamming the connection — but
      // it must never be SILENT: a swallowed tick error is indistinguishable
      // from "the wait finished", and it made a broken billing loop look like a
      // working one. Log it, remember it on the entry, then stop.
      console.error(`stream tick failed (session ${sessionId}):`, e.message);
      const entry = streams.get(sessionId);
      if (entry) entry.error = e.message;
      stop();
    }
  }

  stopStream(sessionId);
  // A per-connection identity, so a *replaced* stream (client reconnected) can
  // never delete the NEW registry entry when its own teardown runs.
  const streamToken = randomBytes(8).toString('hex');
  const entry = { stop, token: streamToken, startedAt: Date.now(), banked: 0, agentKey: session0.agent_key, userId: user.id, inFlight: null, onCommitted: null };
  streams.set(sessionId, entry);
  streamEntry = entry;   // tick() reads its banked count + onCommitted hook

  // Two cadences, on purpose:
  //
  //   • BANK (1s): commits elapsed seconds to the world + sponsor. Each tick
  //     makes several round-trips, so against a managed DB it can take 2-3s.
  //   • FRAME (1s): pushes the surface's tick event. This is cheap (pure local
  //     state) and must fire every second so the wait animates smoothly.
  //
  // Coupling them made the surface stutter: a slow bank delayed the frame that
  // was waiting on it, so a 12-second wait delivered only 3 visible frames
  // (measured on Neon). The surface is the product; it must not be hostage to
  // the ledger's write latency.
  let frameSecond = 0;
  let frameWorld = { ...w0, xpIntoLevel: l0.intoLevel, needForNext: l0.needForNext, looking: l0.looking, badge: l0.badge };

  // The frame loop animates the wait. It reports `min(frameSecond, banked)` as
  // the verified count so the surface never shows more progress than the ledger
  // has actually committed — the clock ticks, the number doesn't run ahead.
  const frameTimer = setInterval(() => {
    if (!streams.has(sessionId)) return;
    frameSecond += 1;
    // Report the ELAPSED seconds this connection has been live, not the
    // committed count. The two differ for a real reason: a bank makes several
    // round-trips, so against a managed DB the ledger can lag the wall clock by
    // a couple of seconds. Both numbers are honest — the surface shows the
    // elapsed clock ticking, and the ledger catches up underneath.
    //
    // Reporting only the committed count made the stream look broken to any
    // client watching frames (measured: 1 reported on a 6-second wait, so a
    // client that settled on that number under-claimed by 5 seconds). The
    // settle path independently clamps against the server's wall clock, so a
    // frame can never be used to over-claim.
    onEvent({
      type: 'tick',
      world: frameWorld,
      session: {
        id: sessionId, status: 'active',
        agentKey: entry.agentKey,
        verifiedSeconds: Math.max(banked, frameSecond),
        committedSeconds: banked,
      },
      grantedSeconds: 0,
      provisional: true,   // animation frame, not a bank
    });
  }, 1000);

  const bankTimer = setInterval(() => {
    // Skip while a bank is still running — a slow DB must never let ticks pile
    // up and double-bank the same wall-clock seconds. The next tick banks the
    // elapsed seconds since the last SUCCESSFUL bank, so a stall costs nothing:
    // the seconds are credited as soon as the loop is free again.
    if (entry.inFlight) return;
    entry.inFlight = tick().finally(() => { entry.inFlight = null; });
  }, 1000);

  timers = [frameTimer, bankTimer];

  // tick() publishes each committed world here so the frame loop renders real
  // totals rather than a stale snapshot.
  entry.onCommitted = (world) => { frameWorld = world; };

  return stop;
}

// Charge exactly one delivery second, atomically and idempotently. Returns
// null when the second was already charged (replay) or the sponsor can't pay.
async function chargeDeliverySecond({ discovery, user, session, secondIndex, attested }) {
  const fresh = await db.getDiscovery(discovery.id);   // re-read pacing/budget
  if (!fresh || !fresh.active || fresh.budget_remaining <= 0) return null;

  const bundle = buildRewardBundle({
    discovery: fresh, attendedTicks: 1, waitXp: 1, waitCoins: 1,
    effects: { sponsorBonusBps: 0, builderShareBonusBps: 0, xpBonusPer10s: 0 },
  });
  if (!bundle.discovery || bundle.discovery.networkMicro <= 0) return null;

  const row = await db.recordAdSpend({
    discoveryId: fresh.id,
    sessionId: session.id,
    userId: user.id,
    secondIndex,
    amountMicro: bundle.discovery.networkMicro,
    builderMicro: bundle.discovery.builderCoins,
    subsidyMicro: bundle.discovery.computeSubsidy,
    attested,
  });
  if (!row) return null;                                // already charged this second
  await db.chargeDiscoveryBudget(fresh.id, bundle.discovery.networkMicro);
  return bundle.discovery;
}

function publicDiscovery(d) {
  return {
    id: d.id, sponsor: d.sponsor, title: d.title, category: d.category,
    surface: d.surface, landingUrl: d.landing_url || null,
  };
}

// ---- Multi-agent hub: ONE connection per page, all agent panels -----------
// N agents → 1 SSE stream. The hub emits a full snapshot every second so the
// page (and anyone watching a demo) sees every concurrent wait growing the
// same commons, with per-agent verified seconds and per-agent earnings.
export async function hubWait({ handle, onEvent }) {
  const user = await db.getOrCreateUser(handle);
  let lastSnapshot = '';

  async function snapshot() {
    const rows = await db.listActiveSessions(user.id);
    const world = await db.getWorld(user.id);
    const lvl = applyLevels(world.level, world.xp);
    const now = Date.now();
    const snap = {
      type: 'hub',
      user: { id: user.id, handle: user.handle },
      world: { ...world, xpIntoLevel: lvl.intoLevel, needForNext: lvl.needForNext, looking: lvl.looking, badge: lvl.badge },
      agents: rows.map((r) => ({
        sessionId: r.id,
        agentKey: r.agent_key,
        startedAt: r.started_at,
        elapsedSeconds: Math.max(0, Math.floor((now - new Date(r.started_at).getTime()) / 1000)),
        // Live verified seconds come from the in-memory stream (authoritative
        // while streaming); the DB column is the cold-start fallback after a
        // server restart.
        verifiedSeconds: streams.has(r.id)
          ? Math.max(streams.get(r.id).banked || 0, r.stream_banked || 0)
          : (r.stream_banked || 0),
        attended: streams.has(r.id),
      })),
      activeCount: rows.length,
      attendedCount: rows.filter((r) => streams.has(r.id)).length,
    };
    const encoded = JSON.stringify(snap);
    if (encoded === lastSnapshot) return;   // only push on change
    lastSnapshot = encoded;
    onEvent(snap);
  }

  await snapshot();
  const timer = setInterval(() => { snapshot().catch(() => {}); }, 1000);
  return () => clearInterval(timer);
}

// All concurrent waits for a handle — the multi-agent view (snapshot form,
// kept for the JSON API and for clients that can't hold an SSE connection).
export async function getActiveWaits({ handle }) {
  const user = await db.getOrCreateUser(handle);
  const rows = await db.listActiveSessions(user.id);
  const world = await db.getWorld(user.id);
  const lvl = applyLevels(world.level, world.xp);
  const now = Date.now();
  return {
    user: { id: user.id, handle: user.handle },
    world: { ...world, xpIntoLevel: lvl.intoLevel, needForNext: lvl.needForNext, looking: lvl.looking, badge: lvl.badge },
    agents: rows.map((r) => ({
      sessionId: r.id,
      agentKey: r.agent_key,
      startedAt: r.started_at,
      elapsedSeconds: Math.max(0, Math.floor((now - new Date(r.started_at).getTime()) / 1000)),
      verifiedSeconds: r.stream_banked || 0,
      attended: streams.has(r.id),
    })),
    activeCount: rows.length,
    attendedCount: rows.filter((r) => streams.has(r.id)).length,
  };
}

// Start a wait: create the session, return world state + an allocated
// discovery surface so the client can render the fun layer WHILE the agent
// thinks.
export async function startWait({ handle, agentKey }) {
  const user = await db.getOrCreateUser(handle);
  const session = await db.startSession(user.id, agentKey);

  // Belt and braces: getOrCreateUser guarantees the world row, but a null here
  // previously surfaced as an opaque 500 with a session already created. Fail
  // loudly and specifically instead.
  const world = await db.getWorld(user.id);
  if (!world) {
    const err = new Error(`world missing for @${handle} — user row exists without a worlds row`);
    err.status = 500;
    throw err;
  }
  const discoveries = await db.listActiveDiscoveries();
  const discovery = pickDiscovery(discoveries, session.id, user.id);
  const lvl = applyLevels(world.level, world.xp);

  return {
    session: {
      id: session.id,
      status: session.status,
      startedAt: session.started_at,
      token: session.token, // bearer — required on tick/complete/abandon/stream
    },
    user: { id: user.id, handle: user.handle },
    world: { ...world, badge: lvl.badge },
    discovery: discovery ? publicDiscovery(discovery) : null,
    maxWaitSeconds: MAX_WAIT_SECONDS,
  };
}

// Fallback poll path (client-side tick). v2: CAPPED and ELAPSED-AWARE.
//   - The poll can never out-earn the SSE stream it replaces: the ceiling is
//     min(wall-clock since the session opened, MAX_WAIT_SECONDS).
//   - It banks the seconds that ACTUALLY elapsed since the last tick, so a CLI
//     heartbeating every 5s during a 20-minute build banks 20 minutes — not
//     240 requests' worth of one-second ticks. This is what makes the CLI
//     useful for real (long, headless) agent waits.
//   - An over-poll returns `capped: true` with no bank and no charge.
export async function getLiveWait({ handle, token, sessionId }) {
  const session = await authorize({ sessionId, handle, token });
  if (session.status !== 'active') {
    const e = new Error('session not active'); e.status = 409; throw e;
  }
  const user = await db.getOrCreateUser(handle);
  const effects = await effectsFor(user.id);

  const banked = session.stream_banked || 0;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
  const ceiling = Math.min(elapsed, MAX_WAIT_SECONDS);

  // ATOMIC claim of this caller's share of the elapsed window. Computing
  // `grant = ceiling - banked` here in JS would be a read-modify-write: N
  // concurrent polls all read the same `banked`, all compute the same grant,
  // and the session banks Nx the wall clock it witnessed. Under load that
  // measured 33 seconds banked over 6 seconds of real time. The claim happens
  // inside the UPDATE so Postgres serializes it.
  const claim = await db.claimBankWindow(sessionId, ceiling);
  const grant = claim.granted;
  const bankedNow = claim.banked;

  if (grant <= 0) {
    // Nothing new to bank — report the ceiling rather than minting.
    const w = await db.getWorld(user.id);
    const lvl = applyLevels(w.level, w.xp);
    return {
      world: { ...w, badge: lvl.badge },
      session: { id: sessionId, status: session.status },
      capped: true,
      grantedSeconds: 0,
      verifiedSeconds: bankedNow,
      effects,
    };
  }

  const firstSecond = banked + 1;
  const world = await db.spendTimeInWorld(user.id, grant);

  const ledgerRows = [{
    user_id: user.id, session_id: sessionId,
    kind: 'wait_xp', amount_micro: grant * MICRO,
    reason: `live wait tick x${grant} ${session.agent_key || 'agent'}`,
  }];

  const eligible = await db.listActiveDiscoveries();
  const discovery = eligible.length ? pickDiscovery(eligible, sessionId, user.id) : null;
  if (discovery) {
    const fresh = await db.getDiscovery(discovery.id);
    const unit = fresh && fresh.active && fresh.budget_remaining > 0
      ? buildRewardBundle({ discovery: fresh, attendedTicks: 1, waitXp: 1, waitCoins: 1, effects: ZERO_EFFECTS })
      : null;
    if (unit && unit.discovery && unit.discovery.networkMicro > 0) {
      const affordable = Math.max(0, Math.floor(fresh.budget_remaining / unit.discovery.networkMicro));
      const billSeconds = Math.min(grant, affordable || 0);
      if (billSeconds > 0) {
        const paid = await db.recordAdSpendBatch({
          discoveryId: fresh.id, sessionId, userId: user.id, firstSecond, seconds: billSeconds,
          perSecond: {
            amountMicro: unit.discovery.networkMicro,
            builderMicro: unit.discovery.builderCoins,
            subsidyMicro: unit.discovery.computeSubsidy,
            attested: true,
          },
        });
        if (paid.charged > 0) {
          await db.chargeDiscoveryBudget(fresh.id, paid.amountMicro);
          ledgerRows.push({
            user_id: user.id, session_id: sessionId, discovery_id: fresh.id,
            kind: 'discovery', amount_micro: paid.builderMicro,
            reason: `builder share x${paid.charged} (poll) @ ${fresh.sponsor}`,
          });
        }
      }
    }
  }
  await db.appendLedgerBatch(ledgerRows);
  await db.markStreamBanked(sessionId, bankedNow);

  const committed = await db.getWorld(user.id);
  const lvl = applyLevels(committed.level, committed.xp);
  if (lvl.level > committed.level) await db.raiseLevel(user.id, lvl.level, lvl.looking);
  return {
    world: { ...committed, badge: lvl.badge },
    session: { id: sessionId, status: session.status },
    capped: false,
    grantedSeconds: grant,
    verifiedSeconds: bankedNow,
    effects,
  };
}

// Complete a wait: bank XP/coins into the world, attribute discovery revenue,
// write ledger entries. Everything counts; nothing is toggleable.
export async function completeWait({ handle, token, sessionId, attendedTicks, agentKey }) {
  await authorize({ sessionId, handle, token });
  // Re-read AFTER authorizing, and only after the session's in-flight tick has
  // settled. A `complete` that races a running tick would otherwise read
  // `stream_banked` mid-update and settle against a stale count — which
  // intermittently produced "undefined" bodies in the suite and, worse, would
  // under-credit a real builder who banked right as they hit Bank.
  const session = await awaitStreamQuiet(sessionId) || await db.getActiveSession(sessionId);
  if (!session) {
    const err = new Error('session not found');
    err.status = 404;
    throw err;
  }
  if (session.status === 'completed') {
    const err = new Error('session already completed');
    err.status = 409;
    throw err;
  }
  if (session.status !== 'active') {
    const err = new Error('session is not active');
    err.status = 409;
    throw err;
  }
  const user = await db.getOrCreateUser(handle);
  const effects = await effectsFor(user.id);

  // ---- THE FIX: the client does not get to say how much it earned. --------
  // Server ceiling = max(what the stream banked, what wall-clock justifies).
  // The client's number is clamped into that, and into MAX_WAIT_SECONDS.
  //
  // Note the ceiling is the SERVER's view, not the client's: `stream_banked`
  // (seconds the server itself observed and charged for) OR wall-clock elapsed
  // since the session opened, whichever is larger. A never-streamed session
  // therefore settles at its true wall-clock age, and a session claiming
  // 100,000 seconds from a 7-second-old handle settles at 7.
  //
  // Attestation is judged on what the STREAM banked against the request, NOT
  // against the wall-clock ceiling: the ceiling always runs a fraction ahead of
  // the stream (it counts time the stream hasn't ticked yet), so comparing
  // against it would label every fully-watched wait "partially verified".
  const banked = session.stream_banked || 0;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
  const ceiling = Math.max(banked, Math.min(elapsed, MAX_WAIT_SECONDS));
  const requested = Math.floor(Number(attendedTicks) || 0);
  const ticks = Math.max(1, clampAttended(requested, ceiling));
  const clamped = ticks < requested;
  const tier = classifyAttestation({ streamBanked: banked, attendedSeconds: requested });
  // Seconds the sponsor has NOT already been billed for one-by-one on the
  // stream/heartbeat path — settle charges the tail so the sponsor pays for
  // the whole wait exactly once.
  const alreadyCharged = banked;

  // Re-derive the same discovery shown during the stream (deterministic pick).
  const all = await db.listActiveDiscoveries();
  const sessionsDiscovery = all.length ? pickDiscovery(all, session.id, user.id) : null;
  const sessionDiscoveryId = session.discovery_id || (sessionsDiscovery ? sessionsDiscovery.id : null);

  // ---- SETTLE, ALL-OR-NOTHING -------------------------------------------
  // The world credit, the level-up, the streak/daily rollup, the settle tick
  // and the session flip happen in ONE transaction. Before this, a ledger
  // insert that overflowed INTEGER threw AFTER the world was credited, leaving
  // an un-settleable session and world value with no ledger behind it.
  const unsettled = Math.max(0, ticks - alreadyCharged);
  const result = await db.settleWait({
    user,
    session,
    ticks,
    unsettledSeconds: unsettled,
    discovery: sessionsDiscovery,
    discoveryId: sessionDiscoveryId,
    effects,
    agentKey: agentKey || session.agent_key,
    attestedTier: tier,
  });

  // A CONFLICTING settle means another path completed this session between our
  // status check and our write. settleWait rolls the whole thing back and says
  // so — surface that as the same 409 a duplicate complete gets, instead of
  // reading `.world` off an empty result and returning a malformed 200.
  if (result.conflicted) {
    const err = new Error('session already completed');
    err.status = 409;
    throw err;
  }

  const world = result.world;
  if (!world) {
    const err = new Error('settle produced no world state');
    err.status = 500;
    throw err;
  }
  const leveled = applyLevels(world.level, world.xp);
  const milestones = await recordMilestones(user.id, {
    fromLevel: session.stream_banked != null ? (result.levelBefore || 1) : 1,
    toLevel: leveled.level,
    seconds: ticks,
    sponsor: sessionsDiscovery ? sessionsDiscovery.sponsor : null,
  });
  const streak = await touchStreak(user.id, { xp: result.banked.xp, seconds: ticks, sessions: 1 });

  return {
    session: {
      id: session.id, status: 'completed', seconds: ticks,
      requestedSeconds: requested, clamped,
      // The XP/coins this wait was worth IN TOTAL (stream-banked seconds plus
      // the settle tail). Reporting only the tail made a fully-streamed wait
      // claim "+0 XP, +0 coins" at a total it had definitely earned.
      xpEarned: ticks, coinsEarned: ticks,
      tailBanked: result.banked.xp,
      attestedTier: tier, verifiedSeconds: banked,
    },
    world: { ...world, badge: leveled.badge },
    level: leveled,
    streak,
    milestones,
    discovery: result.bundle && result.bundle.discovery
      ? {
          sponsor: result.bundle.discovery.sponsor,
          title: result.bundle.discovery.title,
          attendedTicks: result.bundle.discovery.attendedTicks,
          builderCoins: result.bundle.discovery.builderCoins,
          computeSubsidy: result.bundle.discovery.computeSubsidy,
          builderCoinsStr: formatMicro(result.bundle.discovery.builderCoins),
          computeSubsidyStr: formatMicro(result.bundle.discovery.computeSubsidy),
          networkMicro: result.bundle.discovery.networkMicro,
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
  const [rank, lbSize, ledger, totalMicro, completedWaits, outstandingMicro, streak, activity, cosmetics, upgrades] = await Promise.all([
    db.rankOf(user.id),
    db.leaderboard(10000).then((l) => l.length),
    db.tallyByKind(user.id),
    db.sumLedger(user.id),
    db.sessionCount(user.id),
    db.sumOutstandingMicro(user.id),
    db.getStreak(user.id),
    db.recentActivity(user.id, 14),
    db.listCosmetics(user.id),
    db.ownedUpgrades(user.id),
  ]);
  return {
    user: { id: user.id, handle: user.handle },
    world: { ...world, xpIntoLevel: level.intoLevel, needForNext: level.needForNext, badge: level.badge },
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
    // v2: what has been ISSUED but not yet cashed. The old board treated every
    // claim as final money; a voucher is a liability until it is redeemed.
    outstandingMicro,
    outstandingStr: formatMicro(outstandingMicro),
    completedWaits,
    streak: { current: streak.current, longest: streak.longest, shields: streak.shields },
    activity,
    cosmetics,
    upgrades,
  };
}

// Builder paid to wait — the money moves. Claim the earned (wait XP + builder
// share of discovery revenue) less anything already claimed. Replay-proof.
//
// v2: the claim itself is serialized by an advisory-style guard — two
// concurrent claims can no longer both read the same `earned` and each issue a
// voucher for the full balance. The DB re-checks claimability inside the
// insert, so exactly one of N racing claims creates a payout.
function voucherFor(userId, micro, nonce) {
  const digest = createHash('sha256').update(`waitsi:${userId}:${micro}:${nonce}:claim`).digest('hex').slice(0, 20);
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
  const nonce = randomBytes(6).toString('hex');
  // Re-check affordability of the claim INSIDE the write. The transaction
  // re-reads earned/claimed under a row lock on the user.
  const payout = await db.createPayoutGuarded({
    user_id: user.id,
    amount_micro: claimable,
    voucher: voucherFor(user.id, claimable, nonce),
  });
  if (!payout) {
    const err = new Error('nothing to claim — balance already settled');
    err.status = 409;
    throw err;
  }
  await db.addEvent(user.id, 'payout', `Claimed ${formatMicro(payout.amount_micro)} $CMNS — voucher ${payout.voucher}`);
  return {
    payout: {
      id: payout.id,
      amountMicro: payout.amount_micro,
      amountStr: formatMicro(payout.amount_micro),
      voucher: payout.voucher,
      status: payout.status,
      redeemable: true,
    },
    claimableRemaining: 0,
    earnedStr: formatMicro(earned),
    claimedStr: formatMicro(claimed),
    redeemWith: `POST /payouts/${payout.voucher}/redeem`,
  };
}

// Redeem a voucher — the step that did not exist in v1. A voucher was a string
// with no state, so "cash your wait" was a promise the system couldn't keep.
// Redemption is single-use and atomic.
export async function redeemPayout({ voucher, txRef }) {
  const existing = await db.getPayoutByVoucher(voucher);
  if (!existing) {
    const err = new Error('unknown voucher');
    err.status = 404;
    throw err;
  }
  if (existing.status !== 'claimed') {
    const err = new Error('voucher revoked');
    err.status = 409;
    throw err;
  }
  const row = await db.redeemVoucher(voucher, txRef);
  if (!row) {
    const err = new Error('voucher already redeemed');
    err.status = 409;
    throw err;
  }
  await db.addEvent(row.user_id, 'redeem', `Voucher ${voucher} redeemed${txRef ? ` (tx ${txRef})` : ''}`);
  return {
    voucher: row.voucher,
    amountMicro: row.amount_micro,
    amountStr: formatMicro(row.amount_micro),
    status: 'redeemed',
    redeemedAt: row.redeemed_at,
    txRef: row.tx_ref,
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
    badge: applyLevels(r.level, r.xp).badge,
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
  stopStream(sessionId);
  return { session: { id: ended.id, status: ended.status, seconds: ended.seconds } };
}

// ---- Server-truth attendance verification ---------------------------------
// The CLI (or any external tool) reports how long it OBSERVED the wait. The
// server does not take that number on faith: it is clamped against wall-clock
// since the session opened and against MAX_WAIT_SECONDS, then stamped on the
// session as `stream_banked`, which is what `complete` will clamp against.
// This is the difference between "trust me, I waited" and "here is what the
// server can independently justify".
export async function verifyAttendance({ handle, token, sessionId, observedSeconds, source }) {
  const session = await authorize({ sessionId, handle, token });
  if (session.status !== 'active') {
    const err = new Error('session not active');
    err.status = 409;
    throw err;
  }
  const user = await db.getOrCreateUser(handle);
  const reported = Math.floor(Number(observedSeconds) || 0);
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
  // The server's own ceiling wins over the client's claim, always.
  const verified = Math.max(0, Math.min(reported, elapsed, MAX_WAIT_SECONDS));
  const prior = session.stream_banked || 0;
  const best = Math.max(prior, verified);
  if (best !== prior) await db.markStreamBanked(sessionId, best);

  const clamped = verified < reported;
  const tier = classifyAttestation({ streamBanked: best, attendedSeconds: best });
  return {
    session: { id: sessionId, status: session.status },
    reportedSeconds: reported,
    verifiedSeconds: best,
    serverElapsedSeconds: elapsed,
    clamped,
    source: source || 'external',
    attestedTier: tier,
    note: clamped
      ? `server could only justify ${best}s of the reported ${reported}s (wall-clock since session open)`
      : 'reported wait fits inside the server-observed window',
  };
}

// ---- Shop: the coin sink ---------------------------------------------------
export async function getShop(handle) {
  const user = await db.getOrCreateUser(handle);
  const { catalog } = await import('./spend.js');
  return catalog(user.id);
}

export async function buyUpgrade({ handle, key }) {
  const { buyUpgrade: buy } = await import('./spend.js');
  return buy({ handle, key });
}

export async function buyCosmetic({ handle, key }) {
  const { buyCosmetic: buy } = await import('./spend.js');
  return buy({ handle, key });
}

// ---- Sponsor ops ----------------------------------------------------------
export async function getDiscoveries() {
  const rows = await db.listActiveDiscoveries();
  return rows.map((d) => ({
    ...publicDiscovery(d),
    cpm: d.cpm,
    budgetRemainingMicro: d.budget_remaining,
    budgetRemainingStr: formatMicro(d.budget_remaining),
    dailyCapMicro: d.daily_cap_micro,
    requireAttested: d.require_attested,
  }));
}

export async function getCampaigns() {
  const rows = await db.listCampaigns();
  const now = Date.now();
  return rows.map((c) => {
    const starts = c.starts_at ? Date.parse(c.starts_at) : null;
    const ends = c.ends_at ? Date.parse(c.ends_at) : null;
    let status = 'active';
    if (!c.active) status = 'paused';
    else if (ends && now >= ends) status = 'ended';
    else if (starts && now < starts) status = 'scheduled';
    else if (c.budget_remaining <= 0) status = 'exhausted';
    return {
      id: c.id, sponsor: c.sponsor, title: c.title, category: c.category,
      surface: c.surface, cpm: c.cpm, status, active: c.active,
      startsAt: c.starts_at, endsAt: c.ends_at,
      landingUrl: c.landing_url || null,
      requireAttested: c.require_attested,
      budgetTotalMicro: c.budget_total,
      budgetRemainingMicro: c.budget_remaining,
      dailyCapMicro: c.daily_cap_micro,
      spentMicro: c.spent_micro,
      spentTodayMicro: c.spent_today_micro,
      impressions: c.impressions,
      attestedImpressions: c.attested_impressions,
      reach: c.reach,
      budgetTotalStr: formatMicro(c.budget_total),
      budgetRemainingStr: formatMicro(c.budget_remaining),
      spentStr: formatMicro(c.spent_micro),
      spentTodayStr: formatMicro(c.spent_today_micro),
      deliveryPct: c.budget_total > 0 ? Math.round((c.spent_micro / c.budget_total) * 1000) / 10 : 0,
      reportUrl: `/sponsor/${c.id}`,
    };
  });
}

// Create or update a campaign. Unknown `id` creates; otherwise it patches the
// fields supplied, so pausing/resuming/retargeting is one endpoint.
export async function upsertCampaign(body) {
  const sponsor = (body.sponsor || '').trim();
  const title = (body.title || '').trim();
  if (!sponsor || !title) {
    const e = new Error('sponsor and title are required');
    e.status = 400;
    throw e;
  }
  const category = CATEGORIES.includes(body.category) ? body.category : 'tool';
  const cpm = Math.max(1, Math.floor(Number(body.cpm) || 2000));
  const budgetMicro = Math.max(0, Math.floor(Number(body.budgetMicro) || 1_000_000));
  const dailyCapMicro = body.dailyCapMicro == null ? null : Math.max(0, Math.floor(Number(body.dailyCapMicro)));
  const surface = (body.surface || 'the commons').trim();
  const row = await db.upsertCampaign({
    id: body.id ? Number(body.id) : null,
    sponsor, title, category, surface, cpm,
    budgetMicro, dailyCapMicro,
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
    landingUrl: body.landingUrl || null,
    requireAttested: !!body.requireAttested,
    active: body.active === undefined ? true : !!body.active,
  });
  // The campaign event belongs to the operator, not a builder — there is no
  // user to attach it to, so it simply isn't written to a user's feed.
  return { campaign: { id: row.id, sponsor, title, status: row.active ? 'active' : 'paused' } };
}

export async function getVaultStats() {
  const v = await db.vaultStats();
  return {
    ...v,
    issuedStr: formatMicro(v.issued_micro),
    redeemedStr: formatMicro(v.redeemed_micro),
    outstandingMicro: v.issued_micro - v.redeemed_micro,
    outstandingStr: formatMicro(v.issued_micro - v.redeemed_micro),
    sponsorSpendStr: formatMicro(v.sponsor_spend_micro),
  };
}

// ---- Stall sweep ----------------------------------------------------------
// Sessions left 'active' by a crashed tab or a dropped server (Render's free
// tier sleeps) would otherwise sit open forever and could later be settled
// against a bogus client number, at whatever number the client felt like
// claiming. The sweep closes them honestly:
//
//   • a session with a LIVE stream attached is skipped — it's being banked
//     right now and will settle normally;
//   • everything else that is still 'active' gets closed, keeping whatever the
//     stream actually verified, and is marked abandoned so it can never be
//     settled later.
//
// `stalledAfter: 0` (an operator force-sweep) closes every streamless active
// session regardless of age.
export async function sweepStalledSessions({ stalledAfter = 300 } = {}) {
  const oldest = Math.max(0, Number(stalledAfter) || 0);
  const rows = oldest <= 0
    ? await db.allActiveSessions()
    : await db.stalledSessions(oldest);
  const closed = [];
  for (const s of rows) {
    if (streams.has(s.id)) continue; // a live stream will settle this normally
    const banked = s.stream_banked || 0;
    const done = await db.expireSession(s.id, banked);
    if (done) {
      await db.addEvent(s.user_id, 'stalled',
        `A ${s.agent_key || 'agent'} wait went quiet after ${banked}s — closed and banked what was verified.`,
        { sessionId: s.id });
      closed.push({ sessionId: s.id, banked });
    }
  }
  return closed;
}

// Public profile — the shareable page (was missing entirely; there was no way
// to link to a builder, so the leaderboard had nowhere to point).
export async function getProfile(handle) {
  const user = await db.getOrCreateUser(handle);
  const board = await getBoard(handle);
  const [events, payouts, activityDays] = await Promise.all([
    db.listEvents(user.id, 20),
    db.listPayoutsWithStatus(user.id),
    db.activityDays(user.id),
  ]);
  const totalSeconds = board.activity.reduce((s, a) => s + a.seconds, 0);
  return {
    ...board,
    handle: user.handle,
    joinedAt: user.created_at,
    events: events.map((e) => ({ id: e.id, kind: e.kind, message: e.message, at: e.created_at })),
    payouts: payouts.map((p) => ({
      id: p.id,
      amountStr: formatMicro(p.amount_micro),
      voucher: p.voucher,
      redeemed: !!p.redeemed_at,
      redeemedAt: p.redeemed_at,
      txRef: p.tx_ref,
      at: p.created_at,
    })),
    activityDays,
    totalSeconds,
  };
}

export { MAX_WAIT_SECONDS, formatMicro, BUILDER_SHARE };
