# WAITSI wait-surface — design system (source of truth)

Project: Commons Make VibeFi hackathon, Sep 17. The build is a **self-contained
wait-surface** a judge opens during an agent wait and watches the world grow live.
Single-file static SPA served by the same zero-dep Node backend (`:3120`), consuming
the new SSE stream endpoint.

## 1. One-line direction
> "A living commons terminal" — dark agent-grade surface where every waiting second
> visibly grows a persistent mini-world you're paid to look at, with a sponsor card
> you earn from while the agent thinks.

**Distinct identity (fresh per project, never reused):** mint-sprout growth accent on
ink charcoal, amber money, teal secondary, Space Mono for live/financial readouts.
This is deliberately NOT purple/blue mesh, NOT neon glow ubiquity — it reads as an
alive developer terminal, not a template.

## 2. Audience
High-frequency vibe-coders / agent-heavy builders hitting repeated, predictable waits
(reasoning, generating, testing, deploying) dozens of times a day. They are paid to
wait (sponsored discovery + compute subsidy) and their persistent commons grows the
more they build.

## 3. Composition (Composition Variation System — one pick per category)
- **Theme:** Dark (deep ink with green hue)
- **Background:** faint dot/line grid + one soft conic glow behind the growth core
- **Typography:** Display **Clash Display** (600/700) · Body **General Sans** (400/500/600) · Mono **Space Mono** (numbers, timestamps, ledger)
- **Hero architecture:** centered badge + headline + CTA; the *live world* is the hero (a
  growing core node + level bloom + XP/vine meter), not text-on-the-right
- **Section system:** single flowing surface, not stacked marketing sections — the
  wait experience IS the page (entry → live world + sponsor card → banked summary)
- **Motion:** `cubic-bezier(0.16,1,0.3,1)` ease-out, mount-stagger via CSS
  `animation-delay` + `both` fill (content visible by default, NOT scroll-gated),
  gentle pulse/breath on the growing core, block-flash on each tick

## 4. Color tokens
| Token | Hex | Use |
|---|---|---|
| `--ink` | `#0B0E0C` | page background (near-black, green tint) |
| `--ink-2` | `#111612` | panel / card background |
| `--line` | `#212B23` | borders, hairlines |
| `--sprout` | `#B8FF4F` | PRIMARY accent — growth, XP, "alive" |
| `--verdant` | `#2DD4BF` | SECONDARY — secondary info, active states |
| `--rum` | `#FFC248` | money / $CMNS / coins |
| `--text` | `#E9F3E3` | high-contrast text |
| `--text-2` | `#9CA98F` | body-secondary |
| `--text-3` | `#5C6A55` | dim / section labels |
| `--danger` | `#FF6B6B` | errors, abandon |

Contrast: `--text` on `--ink` ≈ 14:1 (AAA). `--sprout` on `--ink` ≈ 11:1 (AAA). Steady.

## 5. Typography
- Display (H1, big numbers): **Clash Display** 700
- Body: **General Sans** 400/500/600
- Live readouts (ticker, timer, $CMNS, ledger, timestamps): **Space Mono** 400/500
- Loaded via CDN `<link>` (Fontshare + Google Fonts) — static SPA, no build step.
  `document.fonts.status` must be `'loaded'`.

## 6. Copy voice
Short, warm, first-person, never AI-dense. The commons *speaks* to you while you wait:
"42s in. your commons grew." Plain benefit language for first-time use (what is it →
how it works → the live product). A one-line "HOW TO READ THIS" strip above live widgets.

## 7. Flows & states (must all exist)
1. **Idle/entry** — handle + agent key, big CTA "Start waiting — get paid to grow."
2. **Connecting** — spinner, "starting your wait…"
3. **Waiting (core)** — the live surface: scene ("you're looking at…"), level bloom
   that grows by level, XP vine meter filling tick-by-tick, coin + $CMNS counters,
   live elapsed timer, sponsor discovery card ("SPONSORED · 70% builder share"),
   earnings accruing each second. Bank CTA.
4. **Complete** — banked summary (seconds, XP coins earned, builder share, compute
   subsidy, total $CMNS) + "wait again" (repeatability) + a mini leaderboard peek.
5. **Empty/error** — clear, recoverable, no raw stacks; keyboard-accessible.

## 8. Responsive
Mobile-first: stack world + sponsor card ≤640px, primary CTA full-width ≤560px,
sticky composer/controls, tighten padding. Verify at real 390px + tall full-page.

## 9. Honesty
Served same-origin from the backend → all drives real `/waits/*` calls + the real SSE
stream. Never label anything "live" that's a static stub. CORS `*` added so it's
embeddable into agent tools cross-origin.