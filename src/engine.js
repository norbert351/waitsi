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
// All math is integer micro-units; no floats in the ledger.

export const BUILDER_SHARE = 0.70;
export const COMPUTE_SUBSIDY = 0.30;
export const MICRO = 1_000_000;

// Deterministic discovery selection for a given session, so an agent re-request
// returns the SAME surface (stable dento; the demo can rely on it).
import { createHash } from 'node:crypto';

export function pickDiscovery(discoveries, sessionId, userId) {
  if (!discoveries.length) return null;
  const seed = createHash('sha256')
    .update(`${sessionId}:${userId}`)
    .digest('hex');
  const idx = parseInt(seed.slice(0, 8), 16) % discoveries.length;
  return discoveries[idx];
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
export function buildRewardBundle({ discovery, attendedTicks, waitXp, waitCoins }) {
  if (!discovery) {
    return {
      wait: { xp: waitXp, coins: waitCoins },
      discovery: null,
    };
  }
  const networkMicro = revShareForTicks(discovery, attendedTicks);
  const { builder, subsidy } = splitReward(networkMicro);
  return {
    wait: { xp: waitXp, coins: waitCoins },
    discovery: {
      discoveryId: discovery.id,
      sponsor: discovery.sponsor,
      title: discovery.title,
      category: discovery.category,
      surface: discovery.surface,
      attendedTicks,
      builderCoins: builder,
      computeSubsidy: subsidy,
      networkMicro,
    },
  };
}