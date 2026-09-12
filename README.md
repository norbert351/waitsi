# WAITSI — the waiting layer backend

## Problem
Inside AI-agent tools, builders stare at a loading screen for the seconds-to-minutes an agent "thinks." That dead-time generates nothing. WAITSI productizes that wait.

## Who it's for
High-frequency vibe-coders / agent-heavy builders who hit a *repeated, predictable* wait (reasoning, generating, testing, deploying) dozens of times a day. They are paid to wait (sponsored discovery + compute subsidy) and their persistent world grows the more they build.

## API

| Method | Path | Body/Query | What it does |
|---|---|---|---|
| GET | `/health` | — | Liveness (`version`, `streams`, `maxWaitSeconds`) |
| POST | `/users` | `{handle}` | Upsert a builder |
| POST | `/waits/start` | `{handle, agentKey}` | Start wait session + allocate discovery + **return a session bearer token** |
| **GET** | `/waits/:id/stream` | `?handle=&token=` | **SSE live stream** — 1/s frames while the session is active. Frames carry both `verifiedSeconds` (elapsed) and `committedSeconds` (settled). Requires the session token. |
| **GET** | `/waits/hub` | `?handle=` | **Multi-agent SSE** — ONE stream listing every concurrent agent with per-agent verified seconds + the shared world. |
| POST | `/waits/:id/tick` | `{handle, token}` | Fallback poll. Banks **elapsed** seconds; clamped to wall clock. |
| **POST** | `/waits/:id/verify` | `{handle, token, observedSeconds, source}` | **Server-truth attestation.** The server clamps the reported wait against wall-clock and stamps the session. |
| POST | `/waits/:id/complete` | `{handle, token, attendedTicks, agentKey}` | Settle. **Clamped** to what the server observed; returns `requestedSeconds` + `clamped` + `attestedTier`. |
| POST | `/waits/:id/abandon` | `{handle, token}` | Mark a live session abandoned (409 if already settled) |
| GET | `/waits/active` | `?handle=` | Multi-agent snapshot (JSON fallback for the hub) |
| POST | `/payouts` | `{handle, token}` | **Claim earned balance** → unique `WV-…` voucher. Replay → 409. |
| **POST** | `/payouts/:voucher/redeem` | `{txRef?}` | **Cash the voucher.** Single-use: replay → 409, unknown → 404. |
| GET | `/shop/:handle` | — | Coin-sink catalog (upgrades + cosmetics, priced for this builder) |
| POST | `/shop/:handle/buy` | `{key}` | Buy/level an upgrade. Guarded debit: 409 when unaffordable. |
| POST | `/shop/:handle/cosmetic` | `{key}` | Buy a cosmetic unlock (permanent; 409 if already owned) |
| GET | `/board/:handle` | — | Scoreboard: world, rank, ledger, claimable/claimed **+ outstanding** |
| GET | `/leaderboard` | `?limit=` | Public "$CMNS Vault" scoreboard |
| GET | `/profile/:handle` | — | **Shareable profile** — badge, streak, activity, voucher history, events |
| GET | `/vault` | — | Global stats: issued vs redeemed, sponsor spend, builders, waited seconds |
| GET | `/discoveries` | — | Eligible sponsor catalog (in-window, under budget + daily cap) |
| GET | `/sponsor/:id` | — | **Advertiser delivery report** — spend, pacing, reach, verified/declared split |
| GET | `/admin/campaigns` | — | Sponsor-ops view (all campaigns + status) |
| POST | `/admin/campaigns` | `{sponsor, title, cpm, budgetMicro, …}` | Create (`id` absent) or patch (pause/resume/retarget) a campaign |
| POST | `/admin/sweep` | `{stalledAfter}` | Close stalled sessions. `0` = every streamless active session. |
| GET | `/og.svg` | `?handle=` | Share image (links no longer preview bare) |
| GET | `/` | — | **The wait-surface UI** (self-contained SPA served from `public/`) |

### Attestation tiers — the honest-labelling contract

A wait is labelled by what the server actually observed, never by what the client claims:

| Tier | Meaning |
|---|---|
| `sponsored` | Watched on the live surface; the server banked the seconds itself over a stream it owned. |
| `streamed` | A stream ran but covered only part of the claimed wait. Server-clamped. |
| `declared` | No live attendance (headless/CI). Still banks — but marked unverified and flagged to sponsors. |

## Auth & integrity

- **Session-scoped bearer tokens.** `POST /waits/start` mints a unique `wv_…` token. Every
  state-changing call (`tick`/`complete`/`abandon`/`verify`), both SSE streams and the payout claim
  require it. Missing/wrong token → **401**; valid token under a different handle → **403**;
  unknown session id → **404**. Token comparison is constant-time.
- **Attendance is server-clamped.** `complete` accepts `min(client claim, server ceiling + tolerance, MAX_WAIT_SECONDS)`. The ceiling is `max(stream-banked seconds, wall-clock since open)` — a client cannot mint a wait it didn't have.
- **Spend happens on delivery.** Every attended second writes one idempotent `ad_spend` row (unique on session+second) charging the sponsor and crediting the builder, so sponsor money is never invisible until settle.
- **Settle is all-or-nothing** in a transaction; the ledger can no longer overflow INTEGER and abort mid-settle.
- Replay-proof: double-`complete` → **409**, double-claim → **409**, double-redeem → **409**.
- Integer micro-units (no float ledger drift); **everything counts** — every rewarded second is banked to the ledger.
- CORS is wide-open so the surface is embeddable into agent tools cross-origin.

## The integrity bugs this version fixes

Each of these was a real, measured defect in v1. All are covered by `test/v2.test.js`:

1. **Unbounded attendance (a mint hole).** A 7-second-old session claiming `attendedTicks: 100000` banked **+100,000 XP and +100,000 coins with an empty ledger**, and a second attempt crashed mid-write (`value "100000000000" is out of range for type integer`) *after* crediting the world — stranding the session `active` forever. Now clamped, and the ledger can't overflow by construction.
2. **Concurrent polls multi-banked.** `grant = ceiling - banked` computed in app code is a read-modify-write: 12 racing polls banked **33 seconds over 6 seconds of wall clock**. Now a single compare-and-set (`claimBankWindow`).
3. **An in-flight tick survived its own settle.** World XP crept 5 → 7 after the session completed. The settle now awaits the in-flight tick and the credit is guarded on session status in the same transaction.
4. **Streams banked wall-clock wrong.** `setInterval(fn, 1000)` does not fire every second when each tick makes several DB round-trips — an 8s wait banked 4s. Now banks elapsed time.
5. **The surface stuttered.** Frame delivery was coupled to ledger writes (one frame per ~3s). Now a cheap 1/s frame loop is independent of the 1/s bank loop.
6. **A settle could return a malformed 200** when two completes raced. Now a clean 409.
7. **A user created via another route had no `worlds` row**, so `/waits/start` threw an opaque 500 *after* creating the session.
8. **Vouchers had no lifecycle** — issued as a string with no redemption. Now redeemable and single-use.


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

### v2 surfaces (each one backed a route that had no UI before)

- **Multi-agent hub card** — subscribes to `GET /waits/hub` and lists every concurrent
  agent against the ONE commons they share, with per-agent `verifiedSeconds` and a
  watched/idle flag. Only appears when more than one agent is running. This is the
  originality hook made visible: N agents, one world.
- **Shop** (`Spend coins` on the summary) — the coin sink. Upgrades are permanent and
  change how every future wait pays; cosmetics unlock scenes. Guarded debit, so a
  purchase you can't afford is a 409, never a negative balance.
- **Profile** (`My commons`) — badge, streak, 14-day activity strip, and the voucher
  ledger split into issued-unredeemed vs redeemed.
- **Redeem** — the voucher lifecycle's missing step. Claim issues a `WV-…`; Redeem
  cashes it once (replay → 409).

## Progression (Repeatability 15%)

Waiting accrues XP and coins; crossing an exponential threshold (`60 × 1.6^(n-1)`)
advances the level, unlocks a badge, and rotates the scene. Coins are **spendable** in
the shop, upgrades have real effects (bigger builder share, compute subsidy bonus,
bonus XP, streak shields), and a daily streak rewards returning — with a shield charge
absorbing a single missed day.

### The coin economy

Coins accrue **1 per second of verified waiting**, plus a **one-time 100-coin welcome
grant** on a builder's first settled wait. That grant exists because once attendance is
server-clamped, real seconds are the only income — without it a new builder would need
four unbroken minutes before the cheapest upgrade became affordable, and the shop would
look broken to anyone evaluating the project in one sitting.

The grant is **coins only**: it writes no ledger row, so it is never claimable money and
never inflates XP. It is evented (`welcome`) and granted exactly once per builder.

Against that, the ladder is: first upgrade ~45 coins (≈45s of waiting), a full upgrade
tree + scene ~3 minutes, the top cosmetic ~20 minutes.

## Seeding

`npm run seed` is idempotent and does two things:

1. Seeds the sponsor catalog.
2. Seeds a few **demo builders** with real completed sessions, ledger rows, levels,
   badges and streaks, so the leaderboard has shape on first load rather than showing
   an empty table.

```bash
SEED_DEMO_BUILDERS=0 npm run seed   # catalog only
```

Demo handles are prefixed `demo_`. Their ledger rows are written on the same basis a
live settle uses (`cpm × seconds / 1000`, 70/30 split), so the board reconciles exactly
as production data does — nothing is faked, and their payouts are real vouchers.

## Attach it to a real wait (deep-link + CLI)

The surface is a *layer over any wait*, so it can attach itself with no clicks:

- **One-tap autostart** — `/?handle=<you>&agent=<tool>` starts a fresh paid wait
  instantly (paste this to a judge: `https://waitsi-j9qk.onrender.com/?handle=judge&agent=your-agent`).
- **CLI-attached** — a `waitsi` CLI/agent tool already opened the session
  (`POST /waits/start`) and hands the surface `?handle=&agent=&session=&token=`;
  the page attaches to the live SSE stream and the tool settles on exit.

### The `waitsi` CLI — wrap any slow command

```bash
# run it straight from this repo:
node bin/waitsi.mjs -- npm run build
# or via npx from the public repo (no local clone needed):
npx -y github:norbert351/waitsi --handle zubbycrypt -- npm test
# against a local instance:
WAITSI_BASE=http://localhost:3120 npm run waitsi -- -- node ./slow.js
```

What it does: `POST /waits/start` → opens the live surface in your browser →
runs your command (stdout/stderr pass through) → on exit **banks** every waited
second (XP + coins + your 70% share of discovery revenue) → **claims** the
balance and prints a `WV-…` voucher → final board line. Exit code is preserved
(so it's safe to chain in CI); a non-zero command still banks the wait — you
waited through it. `--no-browser` for headless/CI, `--no-claim` to leave the
balance claimable.

## Repeatability (15%) — how it's wired

The repeat hook is the **persistent world**: `worlds` is keyed by user (not by wait), so
every session builds on the same growing commons — XP/coins/level accumulate forever,
levels expose rotating "looking at" scenes, and the leaderboard compounds lifetime totals.
Returning for slow jobs is *rewarded*, not reset. Covered by a dedicated test that runs
two waits on one handle and asserts the world strictly grew, never reset.

## Multi-agent concurrency (the Originality hook)

A real builder runs **several agents at once** (Claude Code in one terminal, Codex in
another). Waitsi treats that as the normal case, not an edge case:

- **N agents, ONE commons.** `worlds` stays keyed by user, so parallel waits all grow the
  same persistent world — the waiting layer scales with the agent count, it doesn't
  fragment into N separate games.
- **Per-session streams.** Each active wait owns its own SSE interval (a registry keyed by
  session id), so streams can be started, settled, and abandoned independently. Settling
  one agent leaves the others running and untouched.
- **`GET /waits/active?handle=`** — the live multi-agent view: every active session with its
  `agentKey`, `elapsedSeconds`, and whether it's currently *attended* (streaming), plus the
  single shared `world` they're all growing.
- **Attribution stays honest.** Only an *attended* stream banks seconds, so opening three
  agents and watching one doesn't mint XP for the unattended two.

### Atomicity — why concurrency is safe here

All world mutations are **atomic SQL increments**, never read-modify-write:

```sql
UPDATE worlds SET xp = xp + $1, coins = coins + $1 WHERE user_id = $2 RETURNING *
```

Postgres applies `xp = xp + $1` under a row lock, so N concurrent callers produce exactly
N increments. This was a real, measured bug: the original read-then-write banked **2 XP
from 12 concurrent ticks (10 lost)** while the ledger recorded all 12 — the world silently
under-counted the very earnings the payout is computed from. Same fix applied to the
sponsor budget (`GREATEST(budget_remaining - $1, 0)`, floored so it can't go negative).

`test/multiagent.test.js` guards this permanently: it asserts the world total reconciles
with the ledger to the unit under parallel load, and that settling one agent can't disturb
another. A single-agent test suite **cannot** catch a lost-update bug like this.


## Run

Requires a PostgreSQL connection string (Neon, RDS, or any PG ≥ 14). Set it once:

```bash
export WAITSI_DATABASE_URL="postgresql://user:pass@host:5432/db"   # or DATABASE_URL
export WAITSI_DB_SCHEMA="waitsi"                                     # optional namespace; recommended when sharing a DB
```

```bash
npm start        # :3120 — backend + wait-surface at /
npm run seed     # seed sponsor discovery catalog
npm run smoke    # 71 tests: 12 pure unit tests + 59 integration (auth, payouts, vouchers,
                 # redemption, shop, streaks, attestation, multi-agent hub, sponsor ops)
```

The smoke suite runs each file in an isolated (auto-created) schema so tests never collide.
Every file also gets its own port — `node --test` runs test **files** in parallel, and two
servers on one port means requests land on the wrong service. `test/harness.js` resolves the
DB URL (env → `/tmp/wdb_url.txt`), forces IPv4-first DNS, captures the child's stderr, and
fails loudly with the real boot error instead of an opaque `fetch failed`.

Run the fast half alone while iterating — it needs no server:

```bash
node --test test/units.test.js     # 12 tests, ~140ms — level curve, clamp, split math, pricing
```

**Admin token.** `/admin/campaigns` and `/admin/sweep` are operator routes. Set
`WAITSI_ADMIN_TOKEN` to require `Authorization: Bearer <token>`; with it unset the routes are
open and the response says so (`unguarded: true`) rather than pretending to be safe.

## Deploy note
Node ≥22. The only runtime dependency is `pg` (PostgreSQL). `WAITSI_DATABASE_URL`
**must** be present or the service refuses to boot — the connection value lives in
env / Render, never in the repo. `render.yaml` ships a web service (not serverless,
because the SSE stream must hold an open connection); seed + start run on boot.
Set `WAITSI_DB_SCHEMA=waitsi` in Render to keep this service isolated when the Neon
DB also hosts other apps (as this one does — its `public` schema belongs to another
project).

## Judging alignment
- Waiting Experience (30%): the wait becomes a fun, growing, paid experience
- Originality (25%): productizes the waiting *layer* itself — the company Commons says it wants to back
- Fit (20%): native to the agent moment (only appears while an agent thinks)
- Repeatability (15%): progression makes you WANT slow jobs again
- Execution (10%): a thin, self-demoing prototype