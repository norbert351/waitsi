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

    -- Builder claim payouts — money moves (Builder paid to wait). Each voucher
    -- is unique + claimed once (replay-proof). Claimable = earned (wait_xp +
    -- discovery builder-share) MINUS what's already been claimed.
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

    -- Sponsor discovery catalog (the Builder Ad Network revenue engine)
    CREATE TABLE IF NOT EXISTS ${S}discoveries (
      id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sponsor          TEXT NOT NULL,
      title            TEXT NOT NULL,
      category         TEXT NOT NULL CHECK(category IN ('model','infra','tool','brand')),
      surface          TEXT NOT NULL,
      budget_remaining INTEGER NOT NULL DEFAULT 100000,   -- micro-CMNS/ticks
      active           BOOLEAN NOT NULL DEFAULT true,
      cpm              INTEGER NOT NULL DEFAULT 2000        -- micro-CMNS per 1000 "attentive" ticks
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
  `);
  await pool.query(`ALTER TABLE ${S}wait_sessions ADD COLUMN IF NOT EXISTS token TEXT`);
}

// ---------- users ----------
export async function getOrCreateUser(handle) {
  let u = await one(`SELECT * FROM ${S}users WHERE handle = $1`, [handle]);
  if (u) return u;
  u = await one(`INSERT INTO ${S}users (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING RETURNING *`, [handle]);
  if (!u) u = await one(`SELECT * FROM ${S}users WHERE handle = $1`, [handle]);
  await pool.query(`INSERT INTO ${S}worlds (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u.id]);
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
    `SELECT id, agent_key, status, started_at, seconds, xp_earned, coins_earned, token
     FROM ${S}wait_sessions WHERE user_id = $1 AND status = 'active' ORDER BY started_at, id`,
    [userId],
  );
}

export async function getSessionByToken(token) {
  if (!token) return null;
  return one(`SELECT * FROM ${S}wait_sessions WHERE token = $1`, [token]);
}

// ---------- discoveries ----------
export async function listActiveDiscoveries() {
  return all(`SELECT * FROM ${S}discoveries WHERE active = true AND budget_remaining > 0 ORDER BY id`);
}

export async function getDiscovery(id) {
  return one(`SELECT * FROM ${S}discoveries WHERE id = $1`, [id]);
}

// Atomic decrement with a floor at 0. A read-then-write here would both lose
// concurrent charges and let the budget go negative under parallel settles.
export async function chargeDiscoveryBudget(id, micro) {
  return one(
    `UPDATE ${S}discoveries SET budget_remaining = GREATEST(budget_remaining - $1, 0) WHERE id = $2 RETURNING *`,
    [micro, id],
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

export async function closeDb() {
  try { await pool.end(); } catch {}
}