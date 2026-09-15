# WAITSI — Submission (Commons Made VibeFi · "Make Waiting for AI Fun")

Paste-ready answers for the entry form. Verify every live link on submission
day — all verified against the running host **2026-09-15**.

**Live URL:** https://waitsi-j9qk.onrender.com
**Repo (public):** https://github.com/norbert351/waitsi

---

## Pitch (one line)

WAITSI owns the waiting layer for AI — a persistent, paid, ever-growing commons
that takes over the dead load-time an agent thinks, so every second you wait
earns you real $CMNS toward the Vault.

## Theme picked

**Make Waiting for AI Fun** — the waiting layer, literally the "company that
owns the waiting layer" the closing rules line names.

## Description (text for the form)

Today you send a prompt and stare at a loader. WAITSI turns that dead time into
the product: open a session while Claude/Codex/any agent thinks, and the
wait-surface takes over the screen — a living commons that grows every second
(level, XP vine, coins, shop upgrades, scenes, streaks). It's a **layer**: it
attaches to any wait via a deep link (`/surface?handle=you&agent=tool`) or a CLI that
wraps any slow command (`npx -y github:norbert351/waitsi -- npm build`), and it
treats multi-agent builders as the norm (N agents, one shared commons). And it
**pays**: campaigns sponsor the waiting seconds (the Builder Ad Network from
the VibeFi manifesto), and the $CMNS economy is funded by **real on-chain USDC**
via an x402 rail (Base Sepolia) with tamper-evident VaultAnchor receipts — the
payouts you claim and redeem are asset-backed, not a simulation.

## What judges can click (verification paths)

- **The product:** `https://waitsi-j9qk.onrender.com/surface?handle=judge&agent=your-agent`
  — one-tap autostart of a real waiting session.
- **The Vault (on-chain):** `https://waitsi-j9qk.onrender.com/vaults`
- **The leaderboard (public "$CMNS Vault"):**
  `https://waitsi-j9qk.onrender.com/leaderboard?limit=10`
- **Real money rail status:** `https://waitsi-j9qk.onrender.com/api/vault`
  (rail `live:true`, anchor `configured:true`, `onChainReceipts ≥ 1`).

## Step-by-step replication (clone → env → run → verify)

```bash
git clone https://github.com/norbert351/waitsi && cd waitsi
npm ci --omit=dev                      # Node ≥ 22
# PostgreSQL ≥ 14 required:
export WAITSI_DATABASE_URL="postgresql://user:pass@host:5432/db"
export WAITSI_DB_SCHEMA=waitsi         # recommended on a shared DB
npm run seed && npm start              # backend + wait-surface at :3120
# verify the judged loop:
open http://localhost:3120/surface?handle=you&agent=demo
node bin/waitsi.mjs -- npm run build   # CLI-attached wait, banks + claims
```

Tests:

```bash
npm run smoke                         # unit + integration (88 tests)
```

On-chain (Base Sepolia, 84532): USDC `0x036C…CF7e`, payTo `0x3360DA…F7C2`,
VaultAnchor `0xECC096…B7BD`. `POST /v1/sponsor/fund` → 402 challenge → pay →
replay → budget seeded + on-chain receipt.

## Verified-vs-unverified matrix (audit 2026-09-15)

| Claim | Status | How verified |
|---|---|---|
| Wait-surface + SSE loop live | ✅ | Live HTTP + SSE money loop ran (clamp, bank, payout) |
| $CMNS payout mints redeemable `WV-…` voucher | ✅ | Live claim → `WV-18-7000013-3f33…` → redeem 200 / replay 409 |
| x402 rail funded by real USDC | ✅ | `/api/vault` rail live; VaultAnchor `receiptCount=1`; gate returns 402 |
| VaultAnchor on-chain receipts | ✅ | `eth_getCode` + live `receiptCount()` read |
| Native auth + session-gated paid endpoints | ✅ | Live 401/403 on missing/wrong token |
| Admin routes guarded | ✅ | `/admin/*` → `admin token required` w/o Bearer |
| Keep-alive through judging | ✅ | Render free-tier cron enabled (every 10 m) |
| Google Sign-In (client-side, GIS) | ✅ verified | `src/google-oauth.js`; ID token JWKS-verified (no secret); `/auth/google/config` serves the Client ID; token flow tested |
| Wallet login (SIWE) + payout attach | ✅ verified end-to-end | `src/wallet.js`; live E2E with a real viem key (challenge→sign→login 200, nonce-replay 400, wrong-signature 400); /account/me returns the wallet |
| Login-with-Commons (OIDC) | ⚠️ **Not integrated** | Auth-gated on Commons; creds pending — honest gap, not fake |

## Honest limits

- x402 funding settles on **Base Sepolia (testnet)** today; mainnet is a funded
  roadmap item, not a shipped claim.
- The platform's hosted **Login-with-Commons** is not wired (its module is
  auth-gated upstream). Native auth is in and paid endpoints are session-gated.