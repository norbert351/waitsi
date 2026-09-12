// Attestation — proof that a wait really happened, so the surface no longer
// has to trust a client-supplied integer.
//
// The demo-friendly problem: an agent waiting in Claude Code has no way to hand
// us a signed log, and a judge must be able to run this in one tap. So we ship
// three honest tiers and LABEL them:
//
//   'sponsored' — the wait was WATCHED on the live surface AND the server banked
//                 the seconds itself over a stream it owned. The client's
//                 request may run a second or two past what the stream ticked
//                 (the stream banks in elapsed-time chunks, and a disconnect
//                 mid-tick loses the tail) — that slack is the tolerance, not a
//                 downgrade. This is the strongest evidence we have.
//   'streamed'  — a live stream ran, but it covered a small fraction of the
//                 wait the client is asking to be paid for (e.g. the tab was
//                 open for 3s of a 10-minute build). Server-clamped.
//   'declared'  — no live attendance at all (headless/CI, --no-browser). The
//                 wait still banks (Everything Counts) but is marked unverified
//                 and flagged to sponsors in the report endpoint.
//
// Attestation is REPORTED, never silently upgraded: the surface shows the tier
// next to the earnings and the sponsor report carries the verified/declared
// split, so nobody can mistake a declared wait for a watched one.

export const TIERS = ['sponsored', 'streamed', 'declared'];

// How much of a claimed wait the stream must have covered to call it watched.
// The stream banks in whole elapsed seconds and can lose its final in-flight
// second to a disconnect, so exact equality is the wrong test — a fully watched
// 6-second wait would be labelled "partially verified" for missing one tick.
const COVERAGE_FLOOR = 0.75;

export function classifyAttestation({ streamBanked, attendedSeconds }) {
  const banked = Math.max(0, Math.floor(streamBanked || 0));
  const attended = Math.max(0, Math.floor(attendedSeconds || 0));
  if (banked <= 0) return 'declared';
  if (attended <= 0) return 'sponsored';           // streamed, nothing claimed against it
  if (banked >= attended) return 'sponsored';      // covered the whole claim
  // Covered most of it (within the tick/disconnect tolerance) -> still watched.
  if (banked >= Math.ceil(attended * COVERAGE_FLOOR)) return 'sponsored';
  return 'streamed';
}

export function attestationLabel(tier) {
  return {
    sponsored: 'server-verified · watched live',
    streamed: 'partially server-verified',
    declared: 'declared by the client · unverified',
  }[tier] || 'unknown';
}
