# WAITSI — Roadmap

Where the waiting layer goes next. Grounded in what actually runs today — never
a list of unbuilt features dressed up as done. WAITSI is the build that makes
Commons's own thesis ("build the company that owns the waiting layer for AI")
a concrete product, so the roadmap is the expand-after-hackathon proof.

---

## Today (all shipped, live)

- A persistent, growing commons that takes over an agent's dead load-time —
  wait → earn XP/coins → level, shop, streak → **claim real $CMNS** off the
  Vault.
- Real on-chain sponsors top it up: x402 rail (Base Sepolia) + hash-chained
  VaultAnchor receipts. The "you get paid to wait" story is asset-backed, not
  simulated.
- Fits everywhere: embeddable surface (`/surface?handle=<you>&agent=<tool>`), a CLI
  that wraps any slow command (`npx -y github:norbert351/waitsi -- npm build`),
  and multi-agent concurrency (N agents, one commons).

## Next (ordered by judged value → real users)

1. **Login-with-Commons (OIDC).** The platform's hosted identity/auth surface is
   auth-gated on Commons; this is pending the signed-in credentials. Once the
   `commons-auth` module is wired, WAITSI becomes a first-class Commons app with
   a stable per-user ID — the integration the brief rewards. *(Credential-gated
   today — honestly a blocker, not fake news.)*
2. **A real sponsor-facing storefront.** Turn `/sponsor/:id` (the delivery
   report: spend, pacing, reach, verified/declared split) into a self-serve
   campaign dashboard an advertiser signs into and funds with one USDC tap.
   This is the "Builder Ad Network" as an actual product, not a demo.
3. **Bring the x402 rail to production chains.** Base Sepolia is the provable
   test rail; the durable Vault wants mainnet USDC settlement + multi-chain
   (Solana via the platform's managed RPC) once real sponsor demand exists.
4. **Availably-first SDK.** Ship the `waitsi` attach as a tiny SDK/plugin for
   the judge's own agent tools (Claude Code, Codex, terminal) so "make waiting
   fun" installs in one line instead of a deep link.

## Path from demo → product

- **Demo today:** any agent wait, one URL. Judges get the full loop in one
  click and watch the world grow across three waits.
- **Product:** the same loop, but sponsors are real paying advertisers and
  builders are real high-frequency vibe-coders. The moat is **the waiting
  layer itself**: whoever owns the dead time across every agent owns the single
  biggest recurring surface in agent work.
- **The Vault is the flywheel.** Sponsor deposits → compute/marketplace revenue
  → shared with builders → more builder attention → more sponsors. WAITSI is
  the proof-of-mechanism; the roadmap turns it into the place builders *get
  paid to vibe-code*.

## Honest boundaries

- The native auth is in; the **Commons OIDC** login is not yet (awaiting the
  gated module). Do not read this roadmap as that being done.
- x402 funding is **Base Sepolia / testnet** now — real settlement, but not
  mainnet capital. Mainnet is a funded next step, not a claim.