// DB layer: SQLite via node:sqlite. Zero external deps.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.WAITSI_DB_PATH
  ? resolve(process.env.WAITSI_DB_PATH)
  : resolve(process.cwd(), 'data', 'waitsi.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

export function initSchema() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      handle        TEXT UNIQUE NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Persistent world state: grows with every wait (Repeatability 15%)
    CREATE TABLE IF NOT EXISTS worlds (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id),
      xp           INTEGER NOT NULL DEFAULT 0,
      level        INTEGER NOT NULL DEFAULT 1,
      coins        INTEGER NOT NULL DEFAULT 0,
      looking      TEXT NOT NULL DEFAULT 'the commons',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A single agent wait session (the unit of Waiting Experience 30%)
    CREATE TABLE IF NOT EXISTS wait_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      agent_key    TEXT NOT NULL DEFAULT 'default',
      status       TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','completed','abandoned')),
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      seconds      INTEGER NOT NULL DEFAULT 0,
      xp_earned    INTEGER NOT NULL DEFAULT 0,
      coins_earned INTEGER NOT NULL DEFAULT 0
    );

    -- Builder claim payouts — money moves (Builder paid to wait). Each voucher
    -- is unique + claimed once (replay-proof). Claimable = earned (wait_xp +
    -- discovery builder-share) MINUS what's already been claimed.
    CREATE TABLE IF NOT EXISTS payouts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      amount_micro INTEGER NOT NULL,
      voucher      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'claimed'
                     CHECK(status IN ('claimed','revoked')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sponsor discovery catalog (the Builder Ad Network revenue engine)
    CREATE TABLE IF NOT EXISTS discoveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sponsor         TEXT NOT NULL,
      title           TEXT NOT NULL,
      category        TEXT NOT NULL CHECK(category IN ('model','infra','tool','brand')),
      surface         TEXT NOT NULL,
      budget_remaining INTEGER NOT NULL DEFAULT 100000,   -- micro-CMNS/ticks
      active          INTEGER NOT NULL DEFAULT 1,
      cpm             INTEGER NOT NULL DEFAULT 2000        -- micro-CMNS per 1000 "attentive" ticks
    );

    -- Attribution ledger: every reward + revenue event (Everything Counts)
    -- One entry per (session, discovery); no toggles/attribution games.
    CREATE TABLE IF NOT EXISTS reward_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      session_id    INTEGER REFERENCES wait_sessions(id),
      discovery_id  INTEGER REFERENCES discoveries(id),
      kind          TEXT NOT NULL CHECK(kind IN ('wait_xp','wait_coins','discovery','sponsor_rev')),
      amount_micro  INTEGER NOT NULL,   -- micro-units (integer, no floats)
      reason        TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Migration: add session token to existing DBs + backfill any old rows ---
  const cols = db.prepare('PRAGMA table_info(wait_sessions)').all().map((c) => c.name);
  if (!cols.includes('token')) {
    db.exec(`ALTER TABLE wait_sessions ADD COLUMN token TEXT`);
  }
  db.exec(`UPDATE wait_sessions SET token = 'wv_' || hex(randomblob(24)) WHERE token IS NULL OR token = ''`);
}

// ---------- users ----------
export function getOrCreateUser(handle) {
  const existing = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
  if (existing) return existing;
  db.prepare('INSERT INTO users (handle) VALUES (?)').run(handle);
  const u = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
  db.prepare('INSERT INTO worlds (user_id) VALUES (?)').run(u.id);
  return u;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---------- worlds ----------
export function getWorld(userId) {
  return db.prepare('SELECT * FROM worlds WHERE user_id = ?').get(userId);
}

export function spendTimeInWorld(userId, ds) {
  // Advance the world by a duration slice (seconds) — the fun layer.
  const w = getWorld(userId);
  if (!w) return null;
  const xp = (w.xp || 0) + ds;
  const coins = (w.coins || 0) + ds;
  db.prepare('UPDATE worlds SET xp = ?, coins = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
    .run(xp, coins, userId);
  return getWorld(userId);
}

export function bumpLevel(userId, newLevel, newLooking) {
  db.prepare('UPDATE worlds SET level = ?, looking = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
    .run(newLevel, newLooking, userId);
  return getWorld(userId);
}

// ---------- wait sessions ----------
// Session-scoped bearer token: issued at start, required on every state-changing
// call (tick/complete/abandon) so a foreign agent can't operate another's
// session and every write is replay-scoped to an owned session (401/403).
export function startSession(userId, agentKey) {
  const res = db.prepare(
    `INSERT INTO wait_sessions (user_id, agent_key, status, token) VALUES (?, ?, 'active', ?)`
  ).run(userId, agentKey || 'default', newSessionToken());
  return db.prepare('SELECT * FROM wait_sessions WHERE id = ?').get(res.lastInsertRowid);
}

function newSessionToken() {
  let t = '';
  do {
    t = 'wv_' + randomBytes(24).toString('hex');
  } while (db.prepare('SELECT 1 FROM wait_sessions WHERE token = ?').get(t)); // collision-proof
  return t;
}

export function getActiveSession(sessionId) {
  return db.prepare('SELECT * FROM wait_sessions WHERE id = ?').get(sessionId);
}

// Resolve the owner of a session token (unique). Returns the session or null.
export function getSessionByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM wait_sessions WHERE token = ?').get(token);
}

// ---------- discoveries ----------
export function listActiveDiscoveries() {
  return db.prepare('SELECT * FROM discoveries WHERE active = 1 AND budget_remaining > 0').all();
}

export function getDiscovery(id) {
  return db.prepare('SELECT * FROM discoveries WHERE id = ?').get(id);
}

export function chargeDiscoveryBudget(id, micro) {
  db.prepare('UPDATE discoveries SET budget_remaining = budget_remaining - ? WHERE id = ?')
    .run(micro, id);
  return getDiscovery(id);
}

// ---------- ledger ----------
export function appendLedger({ user_id, session_id = null, discovery_id = null, kind, amount_micro, reason }) {
  const res = db.prepare(
    `INSERT INTO reward_ledger (user_id, session_id, discovery_id, kind, amount_micro, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user_id, session_id, discovery_id, kind, amount_micro, reason);
  return res.lastInsertRowid;
}

export function sumLedger(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount_micro),0) AS total FROM reward_ledger WHERE user_id = ?`
  ).get(userId).total;
}

export function tallyByKind(userId) {
  return db.prepare(
    `SELECT kind, COALESCE(SUM(amount_micro),0) AS total FROM reward_ledger WHERE user_id = ? GROUP BY kind`
  ).all(userId);
}

export function sessionCount(userId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM wait_sessions WHERE user_id = ? AND status='completed'`
  ).get(userId).n;
}

// ---------- payouts (Builder paid to wait — money moves) ----------
// Earned balance = what the builder actually banked (wait XP + their share of
// discovery revenue). Compute subsidy (sponsor_rev) is NOT claimable — it's an
// infra credit, not builder income.
export function sumEarnedMicro(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount_micro),0) AS t FROM reward_ledger
     WHERE user_id = ? AND kind IN ('wait_xp','discovery')`
  ).get(userId).t;
}

export function sumClaimedMicro(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount_micro),0) AS t FROM payouts WHERE user_id = ? AND status='claimed'`
  ).get(userId).t;
}

export function createPayout({ user_id, amount_micro, voucher }) {
  const r = db.prepare(
    `INSERT INTO payouts (user_id, amount_micro, voucher, status) VALUES (?, ?, ?, 'claimed')`
  ).run(user_id, amount_micro, voucher);
  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(r.lastInsertRowid);
}

export function listPayouts(userId) {
  return db.prepare('SELECT * FROM payouts WHERE user_id = ? ORDER BY id DESC').all(userId);
}

export function totalVaultMicro() {
  return db.prepare('SELECT COALESCE(SUM(amount_micro),0) AS t FROM payouts WHERE status=\'claimed\'').get().t;
}

// ---- leaderboard (the $CMNS Vault as a public scoreboard) ----
// Ranks every builder by total earned micro-units. Ties broken by earlier
// first activity (older = higher), then handle for determinism.
export function leaderboard(limit = 20) {
  const rows = db.prepare(
    `SELECT
       u.id AS user_id, u.handle,
       COALESCE(SUM(l.amount_micro),0) AS total_micro,
       COALESCE(SUM(CASE WHEN l.kind='discovery' OR l.kind='sponsor_rev' THEN l.amount_micro ELSE 0 END),0) AS sponsor_micro,
       (SELECT COALESCE(SUM(xp),0) FROM worlds w WHERE w.user_id = u.id) AS xp,
       (SELECT COALESCE(level,1) FROM worlds w WHERE w.user_id = u.id) AS level,
       (SELECT COUNT(*) FROM wait_sessions s WHERE s.user_id=u.id AND s.status='completed') AS waits,
       MIN(l.created_at) AS first_activity
     FROM users u
     LEFT JOIN reward_ledger l ON l.user_id = u.id
     GROUP BY u.id
     HAVING total_micro > 0
     ORDER BY total_micro DESC, first_activity ASC, u.handle ASC
     LIMIT ?`
  ).all(limit);
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

// A builder's rank among all builders (1-based; null if none earned yet).
export function rankOf(userId) {
  const lb = leaderboard(10000);
  const idx = lb.findIndex((r) => r.user_id === userId);
  return idx === -1 ? null : idx + 1;
}

// Mark a live session abandoned (user closed the app mid-wait).
export function abandonSession(sessionId) {
  db.prepare(
    `UPDATE wait_sessions SET status='abandoned', ended_at=datetime('now') WHERE id=? AND status='active'`
  ).run(sessionId);
  return db.prepare('SELECT * FROM wait_sessions WHERE id = ?').get(sessionId);
}

// Revert an mistaken settlement by removing a ledger row + its session entries.
// (Audit path for the operator; only works on an un-quoted run.)
export function revertSession(sessionId) {
  db.prepare(`DELETE FROM reward_ledger WHERE session_id = ?`).run(sessionId);
  const s = db.prepare('SELECT * FROM wait_sessions WHERE id = ?').get(sessionId);
  if (s) db.prepare('DELETE FROM wait_sessions WHERE id = ?').run(sessionId);
  return s;
}

// close on exit (WAL flush)
export function closeDb() {
  try { db.close(); } catch {}
}