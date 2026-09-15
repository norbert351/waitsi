# WAITSI — Architecture

> **One line:** WAITSI owns the waiting layer for AI — a persistent, paid, growing
> commons that takes over an agent's dead load-time wherever it happens.

This doc describes how the running system actually fits together. It is the
home of the *spine*: the core value loop the whole app exists to run, and the
one thing a judge should be able to point at. A rendered system diagram lives
in `waitsi-architecture.html` / `waitsi-architecture.png` (dark living-commons
theme).

---

## 1. System diagram

```
                ┌──────────────────────────────────────────────┐
   agent tool   │            WAITSI backend (Node 22)          │
   (CLI / SPA)  │                                              │
                │   HTTP API + SSE   ┌──────────────────────────┼── on-chain
   wait-surface ▼   src/index.js     │  src/service.js (SSE)    │   x402 rail
  public/*.html   src/auth/shop/...  │  1s tick → world+ledger  │   src/x402.js
   (EventSource)                     │                          │   src/onchain.js
                │   ┌───────────────►  engine/world/attest      │      │
                │   │   core loop     (rewar, split, plank)     │      ▼
                │   └────────────────►  db.js  ──────────────────►  Neon PG (waitsi)
                │                      (pg, schema-qualified)   │       │
                └──────────────────────────────────────────────┼───────┼────────
                                                               VaultAnchor
                                                              (Base Sepolia)
```

Notes on the boxes:

- **The wait-surface** (`public/index.html`) is a dependency-free, self-contained
  SPA—no build step—served at **`/surface`**; the **marketing landing**
  (`public/landing.html`, same brand) is served at **`/`**. A judge opens the
  surface deep-link and it *is* the product; the landing funnels there.
  (`public/vault.html` at `/vaults`, `public/account.html` at `/account`.)
- **The SSE stream** (`src/service.js`) is the heartbeat of the waiting
  layer: one 1-second tick that banks elapsed second into the world *and*
  writes its ledger row in the same interval. Frame emission is decoupled
  from ledger writes so the surface stays smooth even under load.
- **Storage** is one Neon PostgreSQL database, every table namespaced under
  the `waitsi` schema (the shared DB's `public` schema belongs to another
  project). `src/db.js` qualifies every query/DDL so nothing leaks into
  `public`.
- **On-chain** is supplementary to the core loop but *load-bearing for the
  `$CMNS` money story*: the x402 rail asset-backs the sponsor budgets and the
  VaultAnchor writes tamper-evident on-chain receipts (Base Sepolia, 84532).

---

## 2. The core value loop (the judged axis, made visible)

The top-weighted judging axis is **Waiting Experience (30%)**. The loop below
is what that axis is — every node is code a judge can watch, and every arrow
is a real HTTP call on the live host.

1. A job starts waiting → `POST /waits/start` → server creates a session,
   **mints a session-scoped bearer token** (`wv_…`), deterministically picks a
   sponsor discovery (`sha256(sessionId:userId)` seeded, cpm-weighted).
2. Client opens `GET /waits/:id/stream` (SSE) → the surface renders the living
   commons (level bloom, XP vine, coins, timer, scenes) **while the agent
   thinks.**
3. Each second the stream banks **1 verified second** into the world (atomic
   `xp = xp + 1`) and writes a ledger row — the same second is charged to the
   sponsor on delivery (`ad_spend`, idempotent per session+second) and credited
   to the builder's 70% `sponsor_rev`.
4. On completion `POST /waits/:id/complete` **clamps** the claim to what the
   server itself observed (attestation tier `sponsored` / `streamed` /
   `declared`), settles all-or-nothing in a transaction.
5. Coins and XP accrue → shop upgrades/cosmetics (`/shop/:handle`), streaks,
   levels → **`POST /payouts`** claims the balance and mints a single-use
   `WV-…` voucher → `POST /payouts/:voucher/redeem` cashes it.
6. `GET /leaderboard` and `@/vault` turn the invisible ledger into the public
   "$CMNS Vault" scoreboard.

**This is the whole product.** WAITSI does not bolt the waiting layer onto a
bigger platform; waiting is the product and everything else feeds it.

---

## 3. The sponsor economy (VAULT play)

Separate from the core loop is the **money rail** — what makes WAITSI a real
revenue story, not a simulation.

- Sponsor campaigns live in the `campaigns`/`discoveries` tables with
  budget/lifetime/pacing caps and a computed status.
- `POST /v1/sponsor/fund {discoveryId}` → **HTTP 402** + x402 challenge
  (`PAYMENT-REQUIRED`, exact USDC amount, `payTo`). The sponsor pays USDC
  on-chain (Base Sepolia), replays with `PAYMENT-SIGNATURE`, and WAITSI
  verifies the EIP-712 signature **and** the on-chain `Transfer` to `payTo`
  before seeding the budget. A replay ring (keyed by `tx_hash`) guarantees one
  transfer funds exactly one top-up.
- Each funded top-up is anchored to **`VaultAnchor`** (`0xECC096…B7BD`,
  Base Sepolia) as a hash-chained, tamper-evident `ReceiptRecorded` event.

Why remove-it-breaks is true here: **the `$CMNS` payout claim you can redeem is
only credible because the sponsor budgets are asset-backed by verified on-chain
USDC.** Strip the x402 rail and the "pay you to wait / 80% of revenue" pitch
collapses to a made-up counter.

---

## 4. After-removing-<X> → what happens

| Removed | What happens to the product |
|---|---|
| **SSE stream + wait-surface** (`service.js`, `public/`) | The 30% axis disappears. No waiting experience; the loop is headless API only. **Core breaks.** |
| **Persistent world + integer ledger** (`world.js`, `db.js`) | Repeatability (15%) and the payout math both die — no progression, no claimable balance, no scoreboard. **Core breaks.** |
| **Server clamp / attestation** (`attest.js`) | The anti-gaming integrity contract falls away; a client could claim waits it never had, and the "no toggles / everything counts" rule a judge reads is gone. **Core breaks.** |
| **x402 on-chain funding + VaultAnchor** (`x402.js`, `onchain.js`) | The `$CMNS` money story becomes a simulation. Payouts still issue vouchers, but they redeeem a budget nobody funded. **VAULT axis (and integrity of the revenue claim) breaks** — soft for the demo, hard for the pitch. |
| **Native auth / session tokens** (`auth.js`) | The paid endpoints (`/wait`, `/tick`, `/complete`, `/payouts`) become un-gated; the "one build, no toggles" anti-gaming rule is unenforceable. **Integrity breaks.** |

Load-bearing and *intentionally additive*: the multi-agent hub and shop are
solo-safe amplifiers, not core — removing them degrades depth but not the loop.

---

## 5. Key modules

| File | Responsibility |
|---|---|
| `src/index.js` | HTTP router, static SPA server, all admin/account/vault routes, x402 fund gate |
| `src/service.js` | SSE stream orchestration, heartbeat banking, hub stream |
| `src/engine.js` | Discovery selection (deterministic, cpm-weighted), revenue split (70/30), reward bundling |
| `src/world.js` | World growth / level curve (`60 × 1.6^(n-1)`), badges, scenes |
| `src/attest.js` | Server-truth attestation tiers (`sponsored`/`streamed`/`declared`) |
| `src/db.js` | Postgres client, schema-qualified DDL/DDL, advisory-locked schema init |
| `src/auth.js` | scrypt passwords, HttpOnly session cookies, saved-history isolation |
| `src/google-oauth.js` | Google Sign-In (client-side GIS): ID-token JWKS verification, no secret |
| `src/wallet.js` | SIWE wallet sign-in + payout-wallet attachment (ECDSA verify via viem) |
| `src/shop.js` | Coin-sink upgrades/cosmetics (guarded debit, price escalation) |
| `src/spend.js` | Milestones/streaks/shields (the repeat hook), activity records |
| `src/seed.js` | Idempotent sponsor catalog + demo-builder seeding |
| `src/x402.js` | EIP-712 challenge, signature + on-chain Transfer verification, replay ring |
| `src/onchain.js` | VaultAnchor writer (on-chain receipts; honest `mode:"logging"` fallback) |

See `docs/TECHNICAL.md` for the data model and per-module detail.