// Sponsor / Discovery Engine — the Builder Ad Network, made a product.
// During a wait, WAITSI surfaces a "discovery" (a model/tool/infra/brand).
// The builder is PAID a share of sponsor revenue for their attention
// (Builder attention funds builder creation — the article's Section 4).
//
// Economics (micro-units):
//   sponsor.cpm   = micro-CMNS earned by the network per 1000 attended ticks
//   builderShare  = fraction of sponsor value passed to the builder (70%)
//   computeSubsidy= remainder (30%) credited as a compute subsidy
//
// v2 (2026-09): campaigns are real objects. A `discoveries` row now carries
// lifetime/spend/daily pacing caps, an attestation requirement, an optional
// spend window, and a computed status. Ads served on the stream path are
// charged in the same second they are earned (spend on delivery, not only on
// settle), and every served impression is idempotent per (session, second).
//
// All math is integer micro-units; no floats in the ledger.

export const BUILDER_SHARE = 0.70;
export const COMPUTE_SUBSIDY = 0.30;
export const MICRO = 1_000_000;

export const CATEGORIES = ['model', 'infra', 'tool', 'brand'];

// Deterministic discovery selection for a given session, so an agent re-request
// returns the SAME surface (stable demo; the surface can rely on it).
// v2: selection is over the ELIGIBLE set (status active, budget left, in
// window, under daily cap) and is weighted by cpm, seo-style — a sponsor who
// pays more gets picked more often, but every eligible sponsor can win.
import { createHash } from 'node:crypto';

export function pickDiscovery(discoveries, sessionId, userId) {
  if (!discoveries || !discoveries.length) return null;
  const seed = createHash('sha256').update(`${sessionId}:${userId}`).digest('hex');
  const total = discoveries.reduce((s, d) => s + Math.max(0, d.cpm || 0), 0);
  if (total <= 0) return discoveries[parseInt(seed.slice(0, 8), 16) % discoveries.length];
  let r = parseInt(seed.slice(0, 12), 16) % total;
  for (const d of discoveries) {
    r -= Math.max(0, d.cpm || 0);
    if (r < 0) return d;
  }
  return discoveries[discoveries.length - 1];
}

// Value of a wait slice attributed to the discovery. `attendedTicks` = seconds
// the builder actually engaged (>=1). Returns micro-CMNS of network revenue.
export function revShareForTicks(discovery, attendedTicks) {
  return Math.round((discovery.cpm * attendedTicks) / 1000);
}

export function splitReward(networkMicro) {
  const builder = Math.floor(networkMicro * BUILDER_SHARE);
  const subsidy = networkMicro - builder;
  return { builder, subsidy };
}

// Allocate builder + compute + sponsor line items for one attended session.
// `effects` (from shop.effectBps) shifts the split in the builder's favour —
// upgrades are a coin sink that pays back in real sponsorship share.
export function buildRewardBundle({ discovery, attendedTicks, waitXp, waitCoins, effects }) {
  const b = effects || { sponsorBonusBps: 0, builderShareBonusBps: 0, xpBonusPer10s: 0 };
  const boostedXp = waitXp + Math.floor((attendedTicks / 10) * b.xpBonusPer10s);
  if (!discovery) {
    return {
      wait: { xp: boostedXp, coins: waitCoins },
      discovery: null,
    };
  }
  const networkMicro = revShareForTicks(discovery, attendedTicks);
  // Base 70/30 split, then the builder's upgrade bonus is taken from the
  // network side FIRST (sponsor spend doesn't grow — the builder just keeps
  // more of what the sponsor already paid).
  const base = splitReward(networkMicro);
  const bonus = Math.floor((networkMicro * b.builderShareBonusBps) / 10_000);
  const builder = Math.min(networkMicro, base.builder + bonus);
  const subsidy = networkMicro - builder;
  // Compute subsidy upgrade: credited on top, accounted to sponsor_rev.
  const subsidyBoost = Math.floor((networkMicro * b.sponsorBonusBps) / 10_000);
  return {
    wait: { xp: boostedXp, coins: waitCoins },
    discovery: {
      discoveryId: discovery.id,
      sponsor: discovery.sponsor,
      title: discovery.title,
      category: discovery.category,
      surface: discovery.surface,
      attendedTicks,
      builderCoins: builder,
      computeSubsidy: subsidy + subsidyBoost,
      networkMicro,
    },
  };
}
