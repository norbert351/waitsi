# WAITSI — the waiting layer backend

## Problem
Inside AI-agent tools, builders stare at a loading screen for the seconds-to-minutes an agent "thinks." That dead-time generates nothing. WAITSI productizes that wait.

## Who it's for
High-frequency vibe-coders / agent-heavy builders who hit a *repeated, predictable* wait (reasoning, generating, testing, deploying) dozens of times a day. They are paid to wait (sponsored discovery + compute subsidy) and their persistent world grows the more they build.

## API

| Method | Path | Body/Query | What it does |
|---|---|---|---|
| GET | `/health` | — | Liveness |
| POST | `/users` | `{handle}` | Upsert a builder |
| POST | `/waits/start` | `{handle, agentKey}` | Start wait session + allocate discovery + **return a session bearer token** |
| **GET** | `/waits/:id/stream` | `?handle=&token=` | **SSE live stream** — pushes `open`→`hello`→a `tick` every second (world grows, ledger banks) while the session is active; ends on complete/abandon/disconnect. Requires the session token. |
| POST | `/waits/:id/tick` | `{handle, token}` | Fallback poll path (bank ~1 live second) |
| POST | `/waits/:id/complete` | `{handle, token, attendedTicks, agentKey}` | Settle world + discovery revenue + ledger |
| POST | `/waits/:id/abandon` | `{handle, token}` | Mark a live session abandoned (409 if already settled) |
| **POST** | `/payouts` | `{handle, token}` | **Builder paid to wait — claim earned balance.** Settles claimable (`wait_xp` + your share of `discovery` rev, minus already-claimed), returns a unique `WV-…` voucher. Replay → 409. |
| GET | `/board/:handle` | — | Persistent scoreboard: world, rank, ledger, total, **claimable/claimed** |
| GET | `/leaderboard?limit=` | — | Public "$CMNS Vault" scoreboard |
| GET | `/discoveries` | — | Sponsor discovery catalog |
| GET | `/` | — | **The wait-surface UI** (self-contained SPA served from `public/`) |

## Auth & integrity

- **Session-scoped bearer tokens.** `POST /waits/start` mints a unique `wv_…` token. Every
  state-changing call (`tick`/`complete`/`abandon`), the SSE stream, and the payout claim
  require it. Missing/wrong token → **401**; valid token presented under a different handle → **403**;
  unknown session id → **404**. Foreign agents can't operate someone else's wait or claim their payout.
- Replay-proof settlement: double-`complete` → **409**, double-claim → **409**, cross-handle clone → **403/404**.
- Integer micro-units (no float ledger drift); **everything counts** — every rewarded second is banked to the ledger.
- CORS is wide-open so the surface is embeddable into agent tools cross-origin. The surface carries the token automatically (SSE `?token=`, complete body).

## Builder payouts (the money moves)

`POST /payouts` closes the loop the pitch promises: the `$CMNS Vault` actually pays out.
Claimable = earned (`wait_xp` + your 70% builder-share of discovery revenue) **minus** what you've
already claimed. `sponsor_rev` (the 30% compute subsidy) is an infra credit and is *not* builder income,
so it's excluded from claims. Each claim writes a `payouts` row and issues a deterministic
`WV-<id>-<micro>-<digest>` voucher as the offramp proof; the board reflects `claimableStr`/`claimedStr`.

## Wait-surface

`GET /` serves the judged, self-contained wait-surface (`public/index.html`, no build
step). It drives the real backend: `POST /waits/start` → opens the **SSE stream**
(`EventSource`) → renders the living commons (level bloom, XP vine, coins, timer,
scene) + the sponsor card while an agent thinks → `POST /complete` → banked summary
+ ledger total + "$CMNS Vault" leaderboard. Mobile-first, dark living-commons
terminal identity (see `design.md`).

## Repeatability (15%) — how it's wired

The repeat hook is the **persistent world**: `worlds` is keyed by user (not by wait), so
every session builds on the same growing commons — XP/coins/level accumulate forever,
levels expose rotating "looking at" scenes, and the leaderboard compounds lifetime totals.
Returning for slow jobs is *rewarded*, not reset. Covered by a dedicated test that runs
two waits on one handle and asserts the world strictly grew, never reset.

## Run

```bash
npm start        # :3120 — backend + wait-surface at /
npm run seed     # seed sponsor discovery catalog
npm run smoke    # 21 integration tests (auth, payouts, repeatability, …)
```

## Deploy note
Zero external deps (only `node:sqlite`, Node ≥22). PORT is read from env. The persistent DB lives at `data/waitsi.db` (or `WAITSI_DB_PATH`), which is git-ignored so a fresh deploy starts clean unless you ship it.

## Judging alignment
- Waiting Experience (30%): the wait becomes a fun, growing, paid experience
- Originality (25%): productizes the waiting *layer* itself — the company Commons says it wants to back
- Fit (20%): native to the agent moment (only appears while an agent thinks)
- Repeatability (15%): progression makes you WANT slow jobs again
- Execution (10%): a thin, self-demoing prototype