// DB layer: PostgreSQL via `pg`. Async, integer micro-units only.
// Connection comes from WAITSI_DATABASE_URL || DATABASE_URL (never hardcoded —
// the secret lives in env/Render, not the repo).
//
// Test isolation: when WAITSI_DB_SCHEMA is set, every table is created and
// queried inside that schema (tables are schema-qualified in SQL). The smoke
// suite sets a fresh schema per run so tests never collide on the shared Neon
// DB. We intentionally DON'T use `options: search_path` — Neon's pooled
// connection rejects that startup parameter (08P01).
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { formatMicro } from './world.js';
import { MICRO, buildRewardBundle } from './engine.js';

const { Pool } = pg;

const RAW_URL = process.env.WAITSI_DATABASE_URL || process.env.DATABASE_URL;
if (!RAW_URL) {
  throw new Error('No database configured. Set WAITSI_DATABASE_URL (or DATABASE_URL) to a PostgreSQL connection string.');
}

// node-pg doesn't consume `sslmode`/`channel_binding` query params from the URL
// reliably; strip them and control TLS via the `ssl` option (Neon requires it).
const connectionString = RAW_URL.split('?')[0];

const SCHEMA = process.env.WAITSI_DB_SCHEMA || null;
if (SCHEMA && !/^[A-Za-z0-9_]+$/.test(SCHEMA)) {
  throw new Error('WAITSI_DB_SCHEMA must be a bare identifier (letters/digits/underscore).');
}
// Schema-qualifier for every table reference. Public schema has no qualifier.
export const S = SCHEMA ? `${SCHEMA}.` : '';

// Explicit column lists for the rows we hand back. This Neon DB is SHARED with
// other apps, so `SELECT *` on users/worlds leaks columns this service doesn't
// own — and the shared `public.users` has a uuid `id` in another project.
export const USER_COLS = 'id, handle, created_at';
export const WORLD_COLS = 'user_id, xp, level, coins, looking, updated_at';

export const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// ---- small async helpers ---------------------------------------------------
async function one(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] ?? null;
}
async function all(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

export async function initSchema() {
  if (SCHEMA) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${S}users (
      id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      handle      TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Persistent world state: grows with every wait (Repeatability 15%)
    CREATE TABLE IF NOT EXISTS ${S}worlds (
      user_id     INTEGER PRIMARY KEY REFERENCES ${S}users(id),
      xp          INTEGER NOT NULL DEFAULT 0,
      level       INTEGER NOT NULL DEFAULT 1,
      coins       INTEGER NOT NULL DEFAULT 0,
      looking     TEXT NOT NULL DEFAULT 'the commons',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A single agent wait session (the unit of Waiting Experience 30%)
    CREATE TABLE IF NOT EXISTS ${S}wait_sessions (
      id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES ${S}users(id),
      agent_key    TEXT NOT NULL DEFAULT 'default',
      status       TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','completed','abandoned')),
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at     TIMESTAMPTZ,
      seconds      INTEGER NOT NULL DEFAULT 0,
      xp_earned    INTEGER NOT NULL DEFAULT 0,
      coins_earned INTEGER NOT NULL DEFAULT 0,
      token        TEXT
    );

    -- Builder claim payouts. Each voucher is unique + redeemed once
    -- (replay-proof). Claimable = earned (wait_xp + discovery builder-share)
    -- MINUS what's already been claimed.
    CREATE TABLE IF NOT EXISTS ${S}payouts (
      id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES ${S}users(id),
      amount_micro INTEGER NOT NULL,
      voucher      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'claimed'
                     CHECK(status IN ('claimed','revoked')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Sponsor discovery catalog (the Builder Ad Network revenue engine).
    -- v2: a real campaign — lifetime budget + daily pacing cap + spend window
    -- + attestation requirement, with status derived from those.
    CREATE TABLE IF NOT EXISTS ${S}discoveries (
      id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sponsor          TEXT NOT NULL,
      title            TEXT NOT NULL,
      category         TEXT NOT NULL CHECK(category IN ('model','infra','tool','brand')),
      surface          TEXT NOT NULL,
      budget_remaining INTEGER NOT NULL DEFAULT 100000,   -- micro-CMNS left
      active           BOOLEAN NOT NULL DEFAULT true,
      cpm              INTEGER NOT NULL DEFAULT 2000,      -- micro-CMNS / 1000 attentive ticks
      -- v2 campaign fields
      budget_total      INTEGER NOT NULL DEFAULT 100000,
      daily_cap_micro   INTEGER,                            -- NULL = uncapped
      starts_at         TIMESTAMPTZ,
      ends_at           TIMESTAMPTZ,
      landing_url       TEXT,
      require_attested  BOOLEAN NOT NULL DEFAULT false
    );

    -- Attribution ledger: every reward + revenue event (Everything Counts)
    CREATE TABLE IF NOT EXISTS ${S}reward_ledger (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES ${S}users(id),
      session_id    INTEGER REFERENCES ${S}wait_sessions(id),
      discovery_id  INTEGER REFERENCES ${S}discoveries(id),
      kind          TEXT NOT NULL CHECK(kind IN ('wait_xp','wait_coins','discovery','sponsor_rev')),
      amount_micro  INTEGER NOT NULL,   -- micro-units (integer, no floats)
      reason        TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- v2: spend on DELIVERY. One row per served ad-second, idempotent on
    -- (session_id, second_index), so a retried/replayed tick can never charge
    -- a sponsor twice. This is what makes the reports trustworthy.
    CREATE TABLE IF NOT EXISTS ${S}ad_spend (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      discovery_id  INTEGER NOT NULL REFERENCES ${S}discoveries(id),
      session_id    INTEGER NOT NULL REFERENCES ${S}wait_sessions(id),
      user_id       INTEGER NOT NULL REFERENCES ${S}users(id),
      second_index  INTEGER NOT NULL,
      amount_micro  INTEGER NOT NULL,
      builder_micro INTEGER NOT NULL,
      subsidy_micro INTEGER NOT NULL,
      attested      BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, second_index)
    );

    -- v2: owned upgrades (coin sink with real effects — see shop.js)
    CREATE TABLE IF NOT EXISTS ${S}upgrades (
      user_id    INTEGER NOT NULL REFERENCES ${S}users(id),
      key        TEXT NOT NULL,
      level      INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );

    -- v2: owned cosmetics (scene/core unlocks), permanent
    CREATE TABLE IF NOT EXISTS ${S}cosmetics (
      user_id    INTEGER NOT NULL REFERENCES ${S}users(id),
      key        TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );

    -- v2: daily activity — drives streaks (repeatability) + the activity chart
    CREATE TABLE IF NOT EXISTS ${S}daily_activity (
      user_id        INTEGER NOT NULL REFERENCES ${S}users(id),
      day            DATE NOT NULL,
      seconds        INTEGER NOT NULL DEFAULT 0,
      sessions       INTEGER NOT NULL DEFAULT 0,
      xp             INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    -- v2: streak state. 'shields' = charges bought from the shop; a missed day
    -- consumes one charge instead of resetting the streak.
    CREATE TABLE IF NOT EXISTS ${S}streaks (
      user_id       INTEGER PRIMARY KEY REFERENCES ${S}users(id),
      current       INTEGER NOT NULL DEFAULT 0,
      longest       INTEGER NOT NULL DEFAULT 0,
      last_day      DATE,
      shields       INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- v2: in-app events feed (milestones, badges, level-ups) — the "things
    -- happened while you waited" stream rendered on the surface + profile.
    CREATE TABLE IF NOT EXISTS ${S}events (
      id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES ${S}users(id),
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      meta       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Idempotent column adds for DBs created by v1 (CREATE TABLE IF NOT EXISTS
  // never adds columns — see the migration note in skills/zerodep-node-backend).
  await pool.query(`ALTER TABLE ${S}wait_sessions ADD COLUMN IF NOT EXISTS token TEXT`);
  await pool.query(`ALTER TABLE ${S}wait_sessions ADD COLUMN IF NOT EXISTS stream_banked INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ${S}wait_sessions ADD COLUMN IF NOT EXISTS attested_tier TEXT`);
  await pool.query(`ALTER TABLE ${S}wait_sessions ADD COLUMN IF NOT EXISTS discovery_id INTEGER`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS budget_total INTEGER NOT NULL DEFAULT 100000`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS daily_cap_micro INTEGER`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS landing_url TEXT`);
  await pool.query(`ALTER TABLE ${S}discoveries ADD COLUMN IF NOT EXISTS require_attested BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE ${S}payouts ADD COLUMN IF NOT EXISTS tx_ref TEXT`);
  await pool.query(`ALTER TABLE ${S}payouts ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${SCHEMA ? SCHEMA + '_' : ''}payouts_voucher_uniq ON ${S}payouts (voucher)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${SCHEMA ? SCHEMA + '_' : ''}ad_spend_discovery_day ON ${S}ad_spend (discovery_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${SCHEMA ? SCHEMA + '_' : ''}ledger_user_created ON ${S}reward_ledger (user_id, created_at)`);
}

// ---------- users ----------
export async function getOrCreateUser(handle) {
  let u = await one(`SELECT * FROM ${S}users WHERE handle = $1`, [handle]);
  if (!u) {
    u = await one(`INSERT INTO ${S}users (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING RETURNING *`, [handle]);
    if (!u) u = await one(`SELECT * FROM ${S}users WHERE handle = $1`, [handle]);
  }
  // ALWAYS ensure the world row exists — not just when the user is new.
  //
  // The v1 code returned early on the existing-user path, so any user created
  // by another route (POST /users, a payout claim) had no `worlds` row. A later
  // `startWait` then read `world = null` and called `applyLevels(null.level)`,
  // throwing a TypeError the route reported as a 500 — with the session already
  // created. Idempotent upsert here makes the world row unconditional.
  await pool.query(
    `INSERT INTO ${S}worlds (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [u.id],
  );
  return u;
}

export async function getUserById(id) {
  return one(`SELECT * FROM ${S}users WHERE id = $1`, [id]);
}

// ---------- worlds ----------
export async function getWorld(userId) {
  return one(`SELECT * FROM ${S}worlds WHERE user_id = $1`, [userId]);
}

// ATOMIC increment — a read-modify-write here loses updates when ticks
// interleave (SSE stream tick + client poll + complete all target one row).
// Postgres applies `xp = xp + $1` under a row lock, so N concurrent callers
// produce exactly N increments. Measured before this fix: 12 concurrent ticks
// banked only 2 XP (10 lost) while the ledger recorded all 12.
export async function spendTimeInWorld(userId, ds) {
  return one(
    `UPDATE ${S}worlds SET xp = xp + $1, coins = coins + $1, updated_at = now() WHERE user_id = $2 RETURNING *`,
    [ds, userId],
  );
}

// Spend coins. GUARDED in the statement: `coins >= price` is evaluated under
// the row lock, so two concurrent purchases can't both pass an app-level
// affordability check and drive the balance negative. Returns null when the
// builder can't afford it (0 rows updated) — callers treat that as 409.
export async function spendCoins(userId, price) {
  return one(
    `UPDATE ${S}worlds SET coins = coins - $1, updated_at = now()
     WHERE user_id = $2 AND coins >= $1 RETURNING *`,
    [price, userId],
  );
}

export async function grantCoins(userId, amount) {
  return one(
    `UPDATE ${S}worlds SET coins = coins + $1, updated_at = now() WHERE user_id = $2 RETURNING *`,
    [amount, userId],
  );
}

export async function setScene(userId, scene) {
  return one(
    `UPDATE ${S}worlds SET looking = $1, updated_at = now() WHERE user_id = $2 RETURNING *`,
    [scene, userId],
  );
}

// Best level — used by the leaderboard / profile so the commons never
// regresses on a concurrent settle.
export async function raiseLevel(userId, newLevel, newLooking) {
  return one(
    `UPDATE ${S}worlds SET level = GREATEST(level, $1), looking = $2, updated_at = now()
     WHERE user_id = $3 RETURNING *`,
    [newLevel, newLooking, userId],
  );
}

export async function bumpLevel(userId, newLevel, newLooking) {
  return one(
    `UPDATE ${S}worlds SET level = $1, looking = $2, updated_at = now() WHERE user_id = $3 RETURNING *`,
    [newLevel, newLooking, userId],
  );
}

// ---------- wait sessions ----------
export async function startSession(userId, agentKey) {
  const token = await newSessionToken();
  return one(
    `INSERT INTO ${S}wait_sessions (user_id, agent_key, status, token)
     VALUES ($1, $2, 'active', $3) RETURNING *`,
    [userId, agentKey || 'default', token],
  );
}

async function newSessionToken() {
  let t = '';
  do {
    t = 'wv_' + randomBytes(24).toString('hex');
  } while (await one(`SELECT 1 AS x FROM ${S}wait_sessions WHERE token = $1`, [t]));
  return t;
}

export async function getActiveSession(sessionId) {
  return one(`SELECT * FROM ${S}wait_sessions WHERE id = $1`, [sessionId]);
}

// Every ACTIVE session for a user — a builder runs several agents at once, and
// the surface shows all of them growing the same commons in parallel.
export async function listActiveSessions(userId) {
  return all(
    `SELECT id, agent_key, status, started_at, seconds, xp_earned, coins_earned, token, stream_banked
     FROM ${S}wait_sessions WHERE user_id = $1 AND status = 'active' ORDER BY started_at, id`,
    [userId],
  );
}

export async function getSessionByToken(token) {
  if (!token) return null;
  return one(`SELECT * FROM ${S}wait_sessions WHERE token = $1`, [token]);
}

// ---------- discoveries / campaigns ----------
// Eligible = active, in window, under lifetime budget, under today's pacing
// cap. The caps are enforced HERE (at selection) and ATOMICALLY at charge
// time (chargeDiscoveryBudget), because a selection-time check alone races.
export async function listActiveDiscoveries() {
  return all(
    `SELECT * FROM ${S}discoveries
     WHERE active = true
       AND budget_remaining > 0
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at > now())
       AND (daily_cap_micro IS NULL OR daily_cap_micro > COALESCE((
             SELECT SUM(amount_micro) FROM ${S}ad_spend s
             WHERE s.discovery_id = ${S}discoveries.id
               AND s.created_at >= date_trunc('day', now())
           ), 0))
     ORDER BY id`,
  );
}

// Every campaign, with spend + derived status — the sponsor-ops view.
export async function listCampaigns() {
  return all(
    `SELECT d.*,
       COALESCE((SELECT SUM(amount_micro) FROM ${S}ad_spend s WHERE s.discovery_id = d.id), 0)::float8 AS spent_micro,
       COALESCE((SELECT SUM(amount_micro) FROM ${S}ad_spend s WHERE s.discovery_id = d.id
                 AND s.created_at >= date_trunc('day', now())), 0)::float8 AS spent_today_micro,
       COALESCE((SELECT COUNT(*) FROM ${S}ad_spend s WHERE s.discovery_id = d.id), 0)::int AS impressions,
       COALESCE((SELECT COUNT(DISTINCT s.user_id) FROM ${S}ad_spend s WHERE s.discovery_id = d.id), 0)::int AS reach,
       (SELECT COUNT(*)::int FROM ${S}ad_spend s WHERE s.discovery_id = d.id AND s.attested) AS attested_impressions
     FROM ${S}discoveries d
     ORDER BY d.id`,
  );
}

export async function getDiscovery(id) {
  return one(`SELECT * FROM ${S}discoveries WHERE id = $1`, [id]);
}

// Create (id === null) or patch a campaign. `budget_total` is only set on
// create — patching a live campaign must not silently reset its lifetime spend
// accounting, so an update adjusts `budget_remaining` by the delta instead.
export async function upsertCampaign(c) {
  if (!c.id) {
    return one(
      `INSERT INTO ${S}discoveries
         (sponsor, title, category, surface, cpm, budget_remaining, budget_total,
          daily_cap_micro, starts_at, ends_at, landing_url, require_attested, active)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [c.sponsor, c.title, c.category, c.surface, c.cpm, c.budgetMicro,
       c.dailyCapMicro, c.startsAt, c.endsAt, c.landingUrl, c.requireAttested, c.active],
    );
  }
  const existing = await one(`SELECT * FROM ${S}discoveries WHERE id = $1`, [c.id]);
  if (!existing) {
    const e = new Error('no such campaign');
    e.status = 404;
    throw e;
  }
  const delta = c.budgetMicro - existing.budget_total;
  return one(
    `UPDATE ${S}discoveries SET
       sponsor=$1, title=$2, category=$3, surface=$4, cpm=$5,
       budget_total=budget_total + $6,
       budget_remaining=GREATEST(budget_remaining + $6, 0),
       daily_cap_micro=$7, starts_at=$8, ends_at=$9, landing_url=$10,
       require_attested=$11, active=$12
     WHERE id=$13 RETURNING *`,
    [c.sponsor, c.title, c.category, c.surface, c.cpm, delta, c.dailyCapMicro,
     c.startsAt, c.endsAt, c.landingUrl, c.requireAttested, c.active, c.id],
  );
}

// Atomic decrement with a floor at 0. A read-then-write here would both lose
// concurrent charges and let the budget go negative under parallel settles.
export async function chargeDiscoveryBudget(id, micro) {
  return one(
    `UPDATE ${S}discoveries SET budget_remaining = GREATEST(budget_remaining - $1, 0) WHERE id = $2 RETURNING *`,
    [micro, id],
  );
}

// ATOMIC, idempotent ad charge. One row per (session, second). A replayed or
// retried delivery tick hits the unique constraint and returns null — the
// sponsor is charged exactly once per served second, and the builder is
// credited exactly once. This is the integrity core of the ad network.
export async function recordAdSpend({ discoveryId, sessionId, userId, secondIndex, amountMicro, builderMicro, subsidyMicro, attested }) {
  return one(
    `INSERT INTO ${S}ad_spend (discovery_id, session_id, user_id, second_index, amount_micro, builder_micro, subsidy_micro, attested)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (session_id, second_index) DO NOTHING
     RETURNING *`,
    [discoveryId, sessionId, userId, secondIndex, amountMicro, builderMicro, subsidyMicro, attested],
  );
}

export async function adSpendTotal(userId) {
  return all(
    `SELECT kind, COALESCE(SUM(amount_micro),0)::float8 AS total FROM ${S}reward_ledger WHERE user_id = $1 GROUP BY kind`,
    [userId],
  );
}

// ---------- ledger ----------
export async function appendLedger({ user_id, session_id = null, discovery_id = null, kind, amount_micro, reason }) {
  const r = await pool.query(
    `INSERT INTO ${S}reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user_id, session_id, discovery_id, kind, amount_micro, reason],
  );
  return r.rows[0].id;
}

// Multi-row ledger insert in ONE round-trip. The hot path (a 1-second stream
// tick) wrote up to three separate rows; against a managed DB at ~300ms per
// query that is most of a second of latency per second waited. Entries are
// validated so a malformed one can't take down the whole batch.
export async function appendLedgerBatch(entries) {
  const rows = (entries || []).filter((e) => e && e.kind && e.reason && Number.isFinite(e.amount_micro));
  if (!rows.length) return 0;
  const values = [];
  const params = [];
  let i = 1;
  for (const e of rows) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(e.user_id, e.session_id ?? null, e.discovery_id ?? null, e.kind, e.amount_micro, e.reason);
  }
  const r = await pool.query(
    `INSERT INTO ${S}reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
     VALUES ${values.join(',')} RETURNING id`,
    params,
  );
  return r.rowCount;
}

// Multi-second ad delivery in ONE round-trip. Returns how many NEW seconds
// were charged (a replayed second conflicts and is skipped, never double-
// billed) plus the totals to charge the budget and credit the builder.
export async function recordAdSpendBatch({ discoveryId, sessionId, userId, firstSecond, seconds, perSecond }) {
  const n = Math.max(0, Math.floor(seconds));
  if (n <= 0) return { charged: 0, amountMicro: 0, builderMicro: 0, subsidyMicro: 0 };
  const values = [];
  const params = [];
  let i = 1;
  for (let k = 0; k < n; k++) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(
      discoveryId, sessionId, userId, firstSecond + k,
      perSecond.amountMicro, perSecond.builderMicro, perSecond.subsidyMicro, perSecond.attested,
    );
  }
  const r = await pool.query(
    `INSERT INTO ${S}ad_spend (discovery_id, session_id, user_id, second_index, amount_micro, builder_micro, subsidy_micro, attested)
     VALUES ${values.join(',')}
     ON CONFLICT (session_id, second_index) DO NOTHING
     RETURNING amount_micro, builder_micro, subsidy_micro`,
    params,
  );
  const charged = r.rowCount;
  const sum = (col) => r.rows.reduce((s, row) => s + row[col], 0);
  return {
    charged,
    amountMicro: r.rows.length ? sum('amount_micro') : 0,
    builderMicro: r.rows.length ? sum('builder_micro') : 0,
    subsidyMicro: r.rows.length ? sum('subsidy_micro') : 0,
  };
}

export async function sumLedger(userId) {
  return (await one(`SELECT COALESCE(SUM(amount_micro),0)::float8 AS total FROM ${S}reward_ledger WHERE user_id = $1`, [userId])).total;
}

export async function tallyByKind(userId) {
  return all(`SELECT kind, COALESCE(SUM(amount_micro),0)::float8 AS total FROM ${S}reward_ledger WHERE user_id = $1 GROUP BY kind`, [userId]);
}

export async function sessionCount(userId) {
  return (await one(
    `SELECT COUNT(*)::int AS n FROM ${S}wait_sessions WHERE user_id = $1 AND status='completed'`, [userId],
  )).n;
}

// ---------- payouts (Builder paid to wait — money moves) ----------
export async function sumEarnedMicro(userId) {
  return (await one(
    `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}reward_ledger
     WHERE user_id = $1 AND kind IN ('wait_xp','discovery')`, [userId],
  )).t;
}

export async function sumClaimedMicro(userId) {
  return (await one(
    `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}payouts WHERE user_id = $1 AND status='claimed'`, [userId],
  )).t;
}

export async function createPayout({ user_id, amount_micro, voucher }) {
  return one(
    `INSERT INTO ${S}payouts (user_id, amount_micro, voucher, status) VALUES ($1, $2, $3, 'claimed') RETURNING *`,
    [user_id, amount_micro, voucher],
  );
}

export async function listPayouts(userId) {
  return all(`SELECT * FROM ${S}payouts WHERE user_id = $1 ORDER BY id DESC`, [userId]);
}

export async function completeSession(sessionId, { seconds, xp, coins }) {
  return one(
    `UPDATE ${S}wait_sessions SET status='completed', ended_at=now(), seconds=$1, xp_earned=$2, coins_earned=$3
     WHERE id=$4 RETURNING *`,
    [seconds, xp, coins, sessionId],
  );
}

export async function totalVaultMicro() {
  return (await one(`SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}payouts WHERE status='claimed'`)).t;
}

// ---- leaderboard (the $CMNS Vault as a public scoreboard) ----
export async function leaderboard(limit = 20) {
  const rows = await all(
    `SELECT
       u.id AS user_id, u.handle,
       COALESCE(SUM(l.amount_micro),0)::float8 AS total_micro,
       COALESCE(SUM(CASE WHEN l.kind='discovery' OR l.kind='sponsor_rev' THEN l.amount_micro ELSE 0 END),0)::float8 AS sponsor_micro,
       (SELECT COALESCE(SUM(xp),0)::float8 FROM ${S}worlds w WHERE w.user_id = u.id) AS xp,
       (SELECT COALESCE(level,1) FROM ${S}worlds w WHERE w.user_id = u.id) AS level,
       (SELECT COUNT(*)::int FROM ${S}wait_sessions s WHERE s.user_id=u.id AND s.status='completed') AS waits,
       MIN(l.created_at) AS first_activity
     FROM ${S}users u
     LEFT JOIN ${S}reward_ledger l ON l.user_id = u.id
     GROUP BY u.id
     HAVING COALESCE(SUM(l.amount_micro),0)::float8 > 0
     ORDER BY total_micro DESC, first_activity ASC, u.handle ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

export async function rankOf(userId) {
  const lb = await leaderboard(10000);
  const idx = lb.findIndex((r) => r.user_id === userId);
  return idx === -1 ? null : idx + 1;
}

export async function abandonSession(sessionId) {
  return one(
    `UPDATE ${S}wait_sessions SET status='abandoned', ended_at=now() WHERE id=$1 AND status='active' RETURNING *`,
    [sessionId],
  );
}

// Revert an mistaken settlement (operator audit path on an un-quoted run).
export async function revertSession(sessionId) {
  await pool.query(`DELETE FROM ${S}reward_ledger WHERE session_id = $1`, [sessionId]);
  const s = await getActiveSession(sessionId);
  if (s) await pool.query(`DELETE FROM ${S}wait_sessions WHERE id = $1`, [sessionId]);
  return s;
}

// ---------- upgrades / cosmetics (the coin sink) ----------
export async function listUpgrades(userId) {
  return all(`SELECT key, level FROM ${S}upgrades WHERE user_id = $1`, [userId]);
}

// Owned upgrades as a { key: level } map — the shape the shop effect math and
// the board both want.
export async function ownedUpgrades(userId) {
  const rows = await listUpgrades(userId);
  const owned = {};
  for (const r of rows) owned[r.key] = r.level;
  return owned;
}

export async function getUpgradeLevel(userId, key) {
  const r = await one(`SELECT level FROM ${S}upgrades WHERE user_id = $1 AND key = $2`, [userId, key]);
  return r ? r.level : 0;
}

// Upsert to an absolute level — callers pass level+1 only after a successful
// spendCoins, so a failed purchase never grants the upgrade.
export async function setUpgradeLevel(userId, key, level) {
  return one(
    `INSERT INTO ${S}upgrades (user_id, key, level, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id, key) DO UPDATE SET level = $3, updated_at = now()
     RETURNING *`,
    [userId, key, level],
  );
}

export async function listCosmetics(userId) {
  return all(`SELECT key, acquired_at FROM ${S}cosmetics WHERE user_id = $1`, [userId]);
}

export async function ownCosmetic(userId, key) {
  return one(
    `INSERT INTO ${S}cosmetics (user_id, key) VALUES ($1,$2)
     ON CONFLICT (user_id, key) DO NOTHING RETURNING *`,
    [userId, key],
  );
}

// ---------- streaks / daily activity ----------
// Fetch the streak, returning `last_day` as a plain 'YYYY-MM-DD' STRING.
//
// Casting to ::text in SQL avoids a whole class of timezone bug: node-pg turns
// a `DATE` into a JS Date at LOCAL midnight, and stringifying that with
// toISOString() can land on the previous or next calendar day. Text in, text
// out — no Date object, no ambiguity.
const STREAK_COLS = 'user_id, current, longest, shields, last_day::text AS last_day, updated_at';

export async function getStreak(userId) {
  let s = await one(`SELECT ${STREAK_COLS} FROM ${S}streaks WHERE user_id = $1`, [userId]);
  if (!s) {
    await one(`INSERT INTO ${S}streaks (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [userId]);
    s = await one(`SELECT ${STREAK_COLS} FROM ${S}streaks WHERE user_id = $1`, [userId]);
  }
  return s;
}

export async function setStreak(userId, { current, longest, lastDay, shields }) {
  return one(
    `UPDATE ${S}streaks SET current=$1, longest=$2, last_day=$3, shields=$4, updated_at=now()
     WHERE user_id=$5 RETURNING *`,
    [current, longest, lastDay, shields, userId],
  );
}

export async function consumeShield(userId) {
  return one(
    `UPDATE ${S}streaks SET shields = shields - 1, updated_at = now()
     WHERE user_id = $1 AND shields > 0 RETURNING *`,
    [userId],
  );
}

export async function addShields(userId, n) {
  return one(
    `UPDATE ${S}streaks SET shields = shields + $1, updated_at = now() WHERE user_id = $2 RETURNING *`,
    [n, userId],
  );
}

// Atomic daily rollup — one row per (user, day), summed under the row lock.
// The day is passed IN by the caller, not taken from `CURRENT_DATE`. The streak
// logic computes the day in JS (UTC) and stores it in `streaks.last_day`; if
// this function used the database's local `CURRENT_DATE` instead, the two would
// disagree on a host where local != UTC (this VM runs a day ahead of UTC), the
// "already counted today?" check would never match, and a single day would
// increment the streak repeatedly.
export async function bumpDailyActivity(userId, { seconds, sessions, xp, day }) {
  return one(
    `INSERT INTO ${S}daily_activity (user_id, day, seconds, sessions, xp)
     VALUES ($1, COALESCE($5::date, CURRENT_DATE), $2, $3, $4)
     ON CONFLICT (user_id, day) DO UPDATE SET
       seconds  = ${S}daily_activity.seconds  + $2,
       sessions = ${S}daily_activity.sessions + $3,
       xp       = ${S}daily_activity.xp       + $4
     RETURNING *`,
    [userId, seconds, sessions, xp, day || null],
  );
}

// Last N days of activity (most recent first) — the repeatability chart.
export async function recentActivity(userId, days = 14) {
  return all(
    `SELECT day, seconds, sessions, xp FROM ${S}daily_activity
     WHERE user_id = $1 AND day > CURRENT_DATE - ($2::int)
     ORDER BY day DESC`,
    [userId, days],
  );
}

export async function activityDays(userId) {
  return (await one(
    `SELECT COUNT(*)::int AS n FROM ${S}daily_activity WHERE user_id = $1 AND seconds > 0`, [userId],
  )).n;
}

// ---------- events feed ----------
export async function addEvent(userId, kind, message, meta = null) {
  return one(
    `INSERT INTO ${S}events (user_id, kind, message, meta) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, kind, message, meta ? JSON.stringify(meta) : null],
  );
}

export async function listEvents(userId, limit = 20) {
  return all(
    `SELECT id, kind, message, meta, created_at FROM ${S}events WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
}

// ---------- payouts lifecycle (voucher is now redeemable) ----------
export async function getPayoutByVoucher(voucher) {
  if (!voucher) return null;
  return one(`SELECT * FROM ${S}payouts WHERE voucher = $1`, [voucher]);
}

// ATOMIC single-use redemption: only one caller can flip redeemed_at from
// NULL. A replayed voucher redeems zero rows → 409, never a second payout.
export async function redeemVoucher(voucher, txRef) {
  return one(
    `UPDATE ${S}payouts SET redeemed_at = now(), tx_ref = $2
     WHERE voucher = $1 AND redeemed_at IS NULL RETURNING *`,
    [voucher, txRef || null],
  );
}

export async function listPayoutsWithStatus(userId) {
  return all(
    `SELECT id, amount_micro, voucher, status, created_at, redeemed_at, tx_ref
     FROM ${S}payouts WHERE user_id = $1 ORDER BY id DESC`,
    [userId],
  );
}

// Sum of vouchers that have been ISSUED but not yet redeemed — the vault's
// outstanding liability. (The old board only knew what had been claimed.)
export async function sumOutstandingMicro(userId) {
  return (await one(
    `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}payouts
     WHERE user_id = $1 AND status = 'claimed' AND redeemed_at IS NULL`, [userId],
  )).t;
}

// Global vault stats for the sponsor-ops / judge view.
export async function vaultStats() {
  return one(
    `SELECT
       COALESCE((SELECT SUM(amount_micro) FROM ${S}payouts WHERE status='claimed'),0)::float8 AS issued_micro,
       COALESCE((SELECT SUM(amount_micro) FROM ${S}payouts WHERE status='claimed' AND redeemed_at IS NOT NULL),0)::float8 AS redeemed_micro,
       COALESCE((SELECT SUM(amount_micro) FROM ${S}ad_spend),0)::float8 AS sponsor_spend_micro,
       COALESCE((SELECT COUNT(*) FROM ${S}users),0)::int AS builders,
       COALESCE((SELECT COUNT(*) FROM ${S}wait_sessions WHERE status='completed'),0)::int AS waits,
       COALESCE((SELECT SUM(seconds) FROM ${S}wait_sessions WHERE status='completed'),0)::int AS waited_seconds`,
  );
}

// Sessions left 'active' but gone quiet — the stall sweep's input.
//
// v2 note: this keys off `stalledAfter` seconds since the session opened ONLY
// as a backstop. The real signal is that no stream is currently attached and
// the last bank was long ago, which `sweepStalledSessions` combines with the
// in-memory `streams` registry. Passing `stalledAfter: 0` means "close every
// active session with no live stream", which is what an operator force-sweep
// wants and what the tests exercise.
export async function stalledSessions(stalledAfter = 300) {
  return all(
    `SELECT id, user_id, agent_key, started_at, stream_banked FROM ${S}wait_sessions
     WHERE status = 'active'
       AND started_at < now() - ($1::int * interval '1 second')
     ORDER BY id`,
    [stalledAfter],
  );
}

// Atomically claim the right to bank up to `ceiling` seconds on a session.
//
// This is the concurrency guard the poll path NEEDS. Computing
// `grant = ceiling - banked` in application code is a read-modify-write: 12
// concurrent polls all read the same `banked`, all compute the same grant, and
// the session banks 12x the wall clock it actually witnessed (measured: 33
// seconds banked over 6 seconds of real time). Doing the comparison INSIDE the
// UPDATE — against the pre-update value, under the row lock — makes Postgres
// serialize it, and each caller learns exactly how much IT was allowed to bank.
//
// The old value is read from the WHERE clause via a CTE-free trick: we select
// it first in the same statement using `prev`, so the returned `granted` is
// this caller's exclusive share.
export async function claimBankWindow(sessionId, ceiling) {
  const cap = Math.max(0, Math.floor(ceiling));
  const r = await one(
    `WITH prev AS (
       SELECT stream_banked AS before FROM ${S}wait_sessions WHERE id = $2
     )
     UPDATE ${S}wait_sessions s
     SET stream_banked = $1
     FROM prev
     WHERE s.id = $2 AND prev.before < $1
     RETURNING prev.before AS before, s.stream_banked AS after`,
    [cap, sessionId],
  );
  if (!r) return { granted: 0, banked: cap };
  return { granted: r.after - r.before, banked: r.after };
}

// Every session still marked active, regardless of age — the operator
// force-sweep path (the live-stream registry decides what's really running).
export async function allActiveSessions() {
  return all(
    `SELECT id, user_id, agent_key, started_at, stream_banked FROM ${S}wait_sessions
     WHERE status = 'active' ORDER BY id`,
  );
}

export async function markStreamBanked(sessionId, seconds) {
  return one(
    `UPDATE ${S}wait_sessions SET stream_banked = GREATEST(stream_banked, $1) WHERE id = $2 RETURNING *`,
    [seconds, sessionId],
  );
}

export async function getSessionById(sessionId) {
  return one(`SELECT * FROM ${S}wait_sessions WHERE id = $1`, [sessionId]);
}

export async function closeDb() {
  try { await pool.end(); } catch {}
}

// Atomically bank `seconds` into a builder's world IF their session is still
// active, advancing the session's verified counter in the same transaction.
//
// This closes a TOCTOU between "is this session still live?" and "credit the
// world": a settle landing in that window used to leave the world credited for
// a second the settle had already priced (and paid a sponsor for). Both writes
// now happen together, under the session row lock, and a settled session makes
// the whole thing a no-op.
//
// Returns null when the session is no longer active (the caller stops), else
// { world, banked } with the session's new verified total.
export async function bankIfActive({ userId, sessionId, seconds, ceiling }) {
  const grant = Math.max(0, Math.floor(seconds));
  if (grant <= 0) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sess = (await client.query(
      `SELECT id, stream_banked FROM ${S}wait_sessions
       WHERE id = $1 AND status = 'active' FOR UPDATE`, [sessionId],
    )).rows[0];
    if (!sess) { await client.query('ROLLBACK'); return null; }

    const banked = Math.min(
      Math.max(0, sess.stream_banked || 0) + grant,
      Math.max(0, Math.floor(ceiling || 0)) || Number.MAX_SAFE_INTEGER,
    );
    const applied = banked - (sess.stream_banked || 0);

    const world = applied > 0
      ? (await client.query(
          `UPDATE ${S}worlds SET xp = xp + $1, coins = coins + $1, updated_at = now()
           WHERE user_id = $2 RETURNING ${WORLD_COLS}`,
          [applied, userId],
        )).rows[0]
      : (await client.query(`SELECT ${WORLD_COLS} FROM ${S}worlds WHERE user_id = $1`, [userId])).rows[0];

    await client.query(
      `UPDATE ${S}wait_sessions SET stream_banked = $1 WHERE id = $2`, [banked, sessionId],
    );
    await client.query('COMMIT');
    return { world, banked, applied };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ---------- transactional settle (the all-or-nothing path) ----------
// Why a transaction: the settle used to be a sequence of independent writes.
// A ledger INSERT that overflowed INTEGER threw *after* the world had already
// been credited — the user kept the XP, the session stayed 'active' forever,
// and the ledger disagreed with the world that the payout is computed from.
// Now either the whole settle lands or none of it does.
export async function settleWait({
  user, session, ticks, unsettledSeconds, discovery, discoveryId, effects, agentKey, attestedTier,
  firstWaitBonus = 0,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const before = (await client.query(
      `SELECT level FROM ${S}worlds WHERE user_id = $1 FOR UPDATE`, [user.id],
    )).rows[0] || { level: 1 };

    // 1) bank the un-charged tail of the wait (the stream already banked and
    //    charged the seconds it observed, so we only account the remainder).
    const tail = Math.max(0, Math.floor(unsettledSeconds));
    const bonusXp = Math.floor((ticks / 10) * (effects ? effects.xpBonusPer10s : 0));
    const grant = tail + bonusXp; // stream tail + upgrade XP bonus
    // The first-wait bonus is COINS ONLY. Crediting it to XP too would hand a
    // new builder a free level, which would muddy the progression curve the
    // whole repeatability hook rests on.
    const bonusCoins = Math.max(0, Math.floor(firstWaitBonus || 0));
    const world = (grant > 0 || bonusCoins > 0)
      ? (await client.query(
          `UPDATE ${S}worlds SET xp = xp + $1, coins = coins + $1 + $3, updated_at = now()
           WHERE user_id = $2 RETURNING ${WORLD_COLS}`,
          [grant, user.id, bonusCoins],
        )).rows[0]
      : (await client.query(`SELECT ${WORLD_COLS} FROM ${S}worlds WHERE user_id = $1`, [user.id])).rows[0];

    if (!world) throw Object.assign(new Error('world missing for user'), { status: 500 });

    // The welcome grant is a separate, labelled ledger-free credit (it is not
    // earnings, so it must never appear in the payout basis).
    if (bonusCoins > 0) {
      await client.query(
        `INSERT INTO ${S}events (user_id, kind, message, meta)
         VALUES ($1, 'welcome', $2, $3)`,
        [user.id, `Welcome — ${bonusCoins} coins to try the shop`, JSON.stringify({ coins: bonusCoins })],
      );
    }

    // 2) ledger — integer-safe by construction (grant is bounded by
    //    MAX_WAIT_SECONDS, so grant * MICRO can never overflow INTEGER).
    if (grant > 0) {
      await client.query(
        `INSERT INTO ${S}reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
         VALUES ($1,$2,$3,'wait_xp',$4,$5)`,
        [user.id, session.id, discoveryId, grant * MICRO, `wait xp for ${ticks}s ${agentKey || 'agent'} wait`],
      );
    }

    // 3) the discovery credit for the un-charged tail (per-second rows already
    //    paid the stream-observed seconds).
    let bundle = null;
    if (discovery && tail > 0) {
      const b = buildRewardBundle({
        discovery, attendedTicks: tail, waitXp: tail, waitCoins: tail, effects,
      });
      bundle = b;
      if (b.discovery && b.discovery.networkMicro > 0) {
        await client.query(
          `INSERT INTO ${S}reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
           VALUES ($1,$2,$3,'discovery',$4,$5)`,
          [user.id, session.id, discovery.id, b.discovery.builderCoins, `builder share (${tail}s tail @ ${discovery.sponsor})`],
        );
        await client.query(
          `INSERT INTO ${S}reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
           VALUES ($1,$2,$3,'sponsor_rev',$4,$5)`,
          [user.id, session.id, discovery.id, b.discovery.computeSubsidy, `compute subsidy from ${discovery.sponsor}`],
        );
        await client.query(
          `UPDATE ${S}discoveries SET budget_remaining = GREATEST(budget_remaining - $1, 0) WHERE id = $2`,
          [b.discovery.networkMicro, discovery.id],
        );
        await client.query(
          `INSERT INTO ${S}ad_spend (discovery_id, session_id, user_id, second_index, amount_micro, builder_micro, subsidy_micro, attested)
           VALUES ($1,$2,$3,-1,$4,$5,$6,$7)
           ON CONFLICT (session_id, second_index) DO NOTHING`,
          [discovery.id, session.id, user.id, b.discovery.networkMicro, b.discovery.builderCoins, b.discovery.computeSubsidy, attestedTier === 'declared' ? false : true],
        );
      }
    }

    // 4) store the discovery on the session (needed by the sponsor report).
    const settled = (await client.query(
      `UPDATE ${S}wait_sessions
       SET status='completed', ended_at=now(), seconds=$1, xp_earned=$2, coins_earned=$3,
           attested_tier=$4, discovery_id=COALESCE($5, discovery_id)
       WHERE id=$6 AND status='active' RETURNING *`,
      [ticks, grant, grant, attestedTier, discoveryId, session.id],
    )).rows[0];

    // If another path settled it first, roll the whole thing back.
    if (!settled) {
      await client.query('ROLLBACK');
      return { conflicted: true };
    }

    await client.query('COMMIT');
    return {
      conflicted: false,
      world,
      levelBefore: before.level,
      banked: { xp: grant, coins: grant },
      bundle,
      session: settled,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Close a session that went quiet without settling. Keeps whatever the stream
// verified (banked) and marks the session expired so it can never be settled
// later against a stale client number.
export async function expireSession(sessionId, keepSeconds = 0) {
  return one(
    `UPDATE ${S}wait_sessions SET status='abandoned', ended_at=now(), seconds=$1
     WHERE id=$2 AND status='active' RETURNING *`,
    [Math.max(0, Math.floor(keepSeconds)), sessionId],
  );
}

// Claim guard: re-read earned/claimed INSIDE the write under a row lock on the
// user, so N concurrent claims produce exactly one payout instead of N
// vouchers for the same balance.
export async function createPayoutGuarded({ user_id, amount_micro, voucher }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM ${S}users WHERE id = $1 FOR UPDATE`, [user_id]);
    const earned = (await client.query(
      `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}reward_ledger
       WHERE user_id = $1 AND kind IN ('wait_xp','discovery')`, [user_id],
    )).rows[0].t;
    const claimed = (await client.query(
      `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}payouts
       WHERE user_id = $1 AND status='claimed'`, [user_id],
    )).rows[0].t;
    const claimable = earned - claimed;
    if (claimable <= 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const row = (await client.query(
      `INSERT INTO ${S}payouts (user_id, amount_micro, voucher, status)
       VALUES ($1,$2,$3,'claimed') RETURNING *`,
      [user_id, Math.min(amount_micro, claimable), voucher],
    )).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Sponsor report — per-campaign delivery, spend, pacing and the
// verified/declared split that a real advertiser would demand.
export async function sponsorReport(discoveryId) {
  const campaign = await one(`SELECT * FROM ${S}discoveries WHERE id = $1`, [discoveryId]);
  if (!campaign) return null;
  const spend = await one(
    `SELECT
       COALESCE(SUM(amount_micro),0)::float8      AS spent_micro,
       COALESCE(SUM(builder_micro),0)::float8     AS builder_micro,
       COALESCE(SUM(subsidy_micro),0)::float8     AS subsidy_micro,
       COUNT(*)::int                              AS served_seconds,
       COUNT(*) FILTER (WHERE attested)::int      AS attested_seconds,
       COUNT(DISTINCT user_id)::int               AS reach,
       COUNT(DISTINCT session_id)::int            AS sessions,
       MIN(created_at)                            AS first_served,
       MAX(created_at)                            AS last_served
     FROM ${S}ad_spend WHERE discovery_id = $1`, [discoveryId],
  );
  const today = await one(
    `SELECT COALESCE(SUM(amount_micro),0)::float8 AS t FROM ${S}ad_spend
     WHERE discovery_id = $1 AND created_at >= date_trunc('day', now())`, [discoveryId],
  );
  const topAgents = await all(
    `SELECT s.agent_key, COUNT(*)::int AS seconds, COUNT(DISTINCT s.user_id)::int AS builders
     FROM ${S}ad_spend a JOIN ${S}wait_sessions s ON s.id = a.session_id
     WHERE a.discovery_id = $1 GROUP BY s.agent_key ORDER BY seconds DESC LIMIT 5`, [discoveryId],
  );
  const now = Date.now();
  const starts = campaign.starts_at ? Date.parse(campaign.starts_at) : null;
  const ends = campaign.ends_at ? Date.parse(campaign.ends_at) : null;
  let status = 'active';
  if (!campaign.active) status = 'paused';
  else if (ends && now >= ends) status = 'ended';
  else if (starts && now < starts) status = 'scheduled';
  else if (campaign.budget_remaining <= 0) status = 'exhausted';

  return {
    campaign: {
      id: campaign.id, sponsor: campaign.sponsor, title: campaign.title,
      category: campaign.category, surface: campaign.surface, cpm: campaign.cpm,
      landingUrl: campaign.landing_url || null,
      requireAttested: campaign.require_attested,
      active: campaign.active, status,
      startsAt: campaign.starts_at, endsAt: campaign.ends_at,
      budgetTotalMicro: campaign.budget_total,
      budgetRemainingMicro: campaign.budget_remaining,
      dailyCapMicro: campaign.daily_cap_micro,
      spentMicro: spend.spent_micro,
      spentTodayMicro: today.t,
      budgetTotalStr: formatMicro(campaign.budget_total),
      budgetRemainingStr: formatMicro(campaign.budget_remaining),
      spentStr: formatMicro(spend.spent_micro),
      spentTodayStr: formatMicro(today.t),
      dailyCapStr: campaign.daily_cap_micro == null ? null : formatMicro(campaign.daily_cap_micro),
      deliveryPct: campaign.budget_total > 0
        ? Math.round((spend.spent_micro / campaign.budget_total) * 1000) / 10 : 0,
    },
    delivery: {
      servedSeconds: spend.served_seconds,
      verifiedSeconds: spend.attested_seconds,
      unverifiedSeconds: spend.served_seconds - spend.attested_seconds,
      verificationRate: spend.served_seconds > 0
        ? Math.round((spend.attested_seconds / spend.served_seconds) * 1000) / 10 : 0,
      reach: spend.reach,
      sessions: spend.sessions,
      builderMicro: spend.builder_micro,
      subsidyMicro: spend.subsidy_micro,
      firstServed: spend.first_served,
      lastServed: spend.last_served,
    },
    topAgents,
  };
}
