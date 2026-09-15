# WAITSI — Technical Document

Engineering detail behind the build. For the system view and the judged-value
loop, see `ARCHITECTURE.md`.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node ≥ 22** | Built-in `node:test`, modern JS; zero toolchain |
| Backend | **Zero-framework HTTP + SSE** (`src/index.js`, `src/service.js`) | Thinnest artifact; full control of the SSE stream |
| Storage | **PostgreSQL (Neon)** via `pg` | Only runtime dependency; schema `waitsi` isolates the shared DB |
| Sessions | **Opaque bearer tokens + HttpOnly cookies** | Session-scoped auth on paid endpoints |
| Passwords | **scrypt** with per-user salt | Native auth, no external provider |
| On-chain | **viem** | x402 settlement + VaultAnchor receipt writer |
| Frontend | **Dependency-free SPA** (`public/`) | No build step; served by the same backend |

Dependency footprint (`package.json`): `pg`, `viem`. That's all.

---

## 2. Data model (schema `waitsi`)

| Table | Purpose | Key integrity rule |
|---|---|---|
| `users` | Builder identity | `handle` unique |
| `worlds` | Persistent world per user (XP/coins/level/streak) | atomic increments only, never read-modify-write |
| `sessions` | Active wait sessions | bearer token, server-clamped attendance |
| `ledger` | Every rewarded event, integer micro-units | **reconciles exactly to world state** |
| `campaigns` / `discoveries` | Sponsor catalog + lifecycle/budget caps | deterministic allocation, spend-on-delivery |
| `ad_spend` | Per-served-second sponsor charges | idempotent per (session, second) |
| `payouts` | Claims + `WV-…` vouchers | single claim, single redeem (409-safe) |
| `payments` | x402 replay ring keyed by `tx_hash` | one transfer = one top-up |

**Every table name is schema-qualified** (`waitsi.<table>`) in both DDL and
queries — see `src/db.js`. This is what keeps WAITSI isolated on a Neon DB
whose `public` schema belongs to another app, and it is the fix for the
`search_path`-as-connection-param crash that Neon's pooler rejects.

Schema init runs under an **advisory lock** so parallel deploys can't race the
DDL.

---

## 3. The reward / anti-gaming core

- **Integer micro-units** everywhere (`amount_micro`, 1e6 = 1 $CMNS). No floats
  in the ledger, so nothing mints or vanishes on split.
- **70 / 30 split**, remainder-derived: `builder = floor(network × 0.70)`,
  `subsidy = network − builder`. Shop upgrades shift the split in the builder's
  favour by taking from the sponsor's side **first** (sponsor spend never grows;
  the builder keeps more of what was already paid).
- **Server clamp**: `complete` accepts `min(client claim, server ceiling +
  tolerance, MAX_WAIT_SECONDS)`. The ceiling is `max(stream-banked seconds,
  wall-clock since open)` — a client cannot mint a wait it didn't have.
- **Attestation tiers** (what the server *actually* observed, never what the
  client claims): `sponsored` (server banked the stream itself), `streamed`
  (stream covered part), `declared` (no live attendance — banked but flagged
  unverified to sponsors).
- **Atomicity**: world and budget mutations are single SQL increments
  (`xp = xp + $1` under row lock), not read-modify-write. This fixes the
  measured 12-ticks→2-XP lost-update bug (`test/multiagent.test.js` guards it).
- **Replay-proof**: double-`complete` → 409, double-claim → 409, double-redeem
  → 409. A test asserts each.
- **Deterministic discovery**: selection is seeded by
  `sha256(sessionId:userId)` and cpm-weighted, so the surface shown at start is
  exactly the one attributed at complete (re-derive, never re-randomize).

---

## 4. Auth

- **Session bearer tokens** on every state-changing call (`tick`/`complete`/
  `abandon`/`verify`), both SSE streams, and the payout claim. Missing → 401,
  valid-token-wrong-handle → 403, unknown session → 404. Constant-time compare.
- **Native accounts** (`/account/register|login|logout`, `/account/me`):
  scrypt passwords + per-user salt, opaque tokens in an HttpOnly
  `SameSite=Lax` cookie. **Saved results/history** per user via
  `POST|GET /api/saved` (auth-gated, per-user isolated). The public commons
  stays open; **starting a paid wait requires a real account** (the surface
  gates "Start waiting" behind create-account / log-in).
- **Admin ops** (`/admin/campaigns`, `/admin/sweep`) gated by
  `WAITSI_ADMIN_TOKEN` (Bearer). When unset the routes are open and the
  response *says so* (`unguarded: true`) — never a silent false gate.

### Google Sign-In (client-side only, Google Identity Services)

No client secret, no redirect URI. The account page loads GIS and renders a
"Continue with Google" button; `google.accounts.id` returns an **ID token** in
the browser, which is POSTed to `POST /auth/google/token`. The backend verifies
the token with `node:crypto` (RS256 against Google's published JWKS) plus
`aud`/`iss`/`exp`/`sub` checks — verification needs only the **public Client
ID** — then binds the `sub` via `users.google_sub` (unique, partial index) and
mints the normal HttpOnly session cookie. Env: `GOOGLE_CLIENT_ID` only.
`GET /auth/google/config` exposes `configured` + the full `clientId` to the
SPA; a malformed/invalid token is rejected `401`.

### Wallet identity (SIWE / EIP-4361)

Sign-in with an injected wallet (MetaMask et al.) and wallet-attach for payouts:

1. `POST /wallet/challenge {address}` → server stores a bound, **single-use
   TTL nonce** (`wallet_challenges`) and returns the full EIP-4361 message to sign.
2. The client `personal_sign`s that **exact** message.
3. `POST /wallet/login {address, message, signature}` → server verifies (a) an
   ECDSA `verifyMessage` (**`viem`, recovered off-chain**, no RPC) recovers to
   `address`, (b) the SIWE `nonce` matches a fresh, address-bound, unused
   challenge that is then consumed, (c) message version/fields, then creates/
   claims the user via `users.wallet_address` (unique, partial index) and mints
   the normal session cookie.

`POST /account/wallet/attach` (requires a session) uses the same verifier to bind
a wallet as the account's payout destination. Auth-gated; 401 when not signed in;
409 when the wallet is already attached to another account. The whole module is
`src/wallet.js` — no new dependencies.

---

## 5. On-chain (Base Sepolia, chain `84532`)

| Component | Value |
|---|---|
| Asset | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| payTo / executor | `0x3360DA7D976D7ED5Fe79Ee8022f539fb9af8f7C2` |
| Price per top-up | `0.1` USDC (`PRICE_ATOMIC=100000`, `DECIMALS=6`) |
| VaultAnchor | `0xECC0962C3Bf3C3c3e8C92d9d5f5F960B759bB7BD` (`receiptCount ≥ 1`) |
| RPC | `https://base-sepolia.publicnode.com` |

x402 flow (see also `ARCHITECTURE.md §3`): `POST /v1/sponsor/fund` → 402 +
signed challenge → sponsor pays USDC on-chain → replay with
`PAYMENT-SIGNATURE` → server verifies EIP-712 signature **and** the on-chain
`Transfer` to `payTo` (scanning `SCAN_BLOCKS`) → seeds budget → anchors a
`ReceiptRecorded` event on VaultAnchor. Honest degrade: without `PAYTO` the
gate answers `503 x402_not_configured`; without `ANCHOR_PK` the anchor reports
`mode:"logging"` rather than claiming to be on-chain.

Contract sources live under `test/contracts/` (`VaultAnchor.sol`,
`UnitToken.sol`) and are exercised hermetic in `test/x402.test.js` on a local
Anvil fork — no external funds.

---

## 6. API surface

Full route table is in `README.md`. The judged core:

```
GET  /health                      liveness (version, streams, maxWaitSeconds)
POST /wait/start                  open session → bearer token + discovery
GET  /waits/:id/stream            SSE live stream (1/s, banks + labels tier)
GET  /waits/hub                   multi-agent SSE (N agents, one world)
POST /waits/:id/{tick,complete,abandon,verify}
POST /payouts                     claim → WV-… voucher
POST /payouts/:voucher/redeem     cash once (409 replay)
GET  /board/:handle, /leaderboard, /profile/:handle, /vault, /shop/:handle
POST /v1/sponsor/fund             x402 sponsor top-up (402 → signed → 200)
GET  /admin/campaigns, POST /admin/{campaigns,sweep}
```

---

## 7. Test suite

Run: `npm run smoke` (= `node --test test/*.test.js`). Each file runs in its
own auto-created schema and its own port so parallel files never collide;
`test/harness.js` resolves the DB URL (env → `/tmp/wdb_url.txt`), forces
IPv4-first DNS, and fails loudly with the real boot error.

`test/units.test.js` (21 tests, ~180 ms, no server) covers level curve, clamp,
split math, pricing, and the Google-Sign-In + wallet-SIWE pure helpers. The
integration files cover auth, payouts/vouchers,
redemption, shop, streaks, attestation tiers, multi-agent concurrency, sponsor
ops, and the x402 loop.

> **Dev note:** on a slow VM the integration tests are latency-bound because
> they round-trip the **cloud** Neon DB (~10–28 s per test), not a local one.
> They pass, but are slow here; on a local DB/CI they are fast. This is dev-setup
> cost, not a product defect.