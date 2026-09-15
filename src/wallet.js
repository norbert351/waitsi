// WAITSI wallet identity — SIWE-style (EIP-4361) sign-in plus wallet
// attachment for payouts. Uses `viem`'s local `verifyMessage` (recovers the
// signer off-chain; no RPC, no new dependencies) against a short-lived,
// single-use nonce so the flow is CSRF/replay-safe without a central session.
import { createHash, randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';

export const WALLET_CHAIN_ID = 1; // Ethereum: WAITSI $CMNS claims redeem off the Vault on mainnet rails
const NONCE_TTL_MS = 5 * 60 * 1000;

// The SIWE message the signer authorizes. Time-bound, nonce-bound, and it
// names both the wallet and where the claim can be redeemed.
export function buildSiwe({ domain, address, nonce, uri, statement,
  chainId = WALLET_CHAIN_ID, issuedAt = new Date().toISOString() }) {
  const rows = [
    `${domain} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    '',
    statement || 'Sign in to WAITSI to attach your wallet and claim the $CMNS you earned while waiting.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ];
  return rows.join('\n');
}

// Pull the JSON-able fields we must check out of a SIWE message. Cheap text
// parse — we don't need to validate the address from the message itself,
// because verifyMessage() only returns true if the signature recovers to the
// exact address the caller (and signer) claim.
export function parseSiwe(msg) {
  const out = {};
  for (const line of String(msg || '').split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z ]*): (.*)$/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

export function newNonce() {
  return randomBytes(20).toString('hex'); // 40 chars, high entropy
}

export function normalizeAddress(a) {
  try { return getAddress(String(a || '').trim()); }
  catch { return null; }
}

// Validate + verify a claimed (address, message, signature). Returns
// { ok, error?, address?, nonce?, chainId?, uri? } — the caller still must
// confirm the nonce is fresh/single-use (via db) and the domain/uri match.
export async function verifyWalletSignature({ address, message, signature }) {
  const addr = normalizeAddress(address);
  if (!addr) return { ok: false, error: 'invalid wallet address' };
  if (typeof message !== 'string' || !message) return { ok: false, error: 'message required' };
  if (typeof signature !== 'string' || !signature) return { ok: false, error: 'signature required' };

  let siwe;
  try { siwe = parseSiwe(message); } catch { return { ok: false, error: 'malformed SIWE message' }; }
  if (siwe['Version'] !== '1') return { ok: false, error: 'unsupported SIWE version' };
  const chainId = Number(siwe['Chain ID']);
  if (!Number.isInteger(chainId)) return { ok: false, error: 'invalid chain id' };
  const nonce = String(siwe['Nonce'] || '');
  if (!nonce) return { ok: false, error: 'missing nonce' };

  let recovered = false;
  try {
    recovered = await verifyMessage({ address: addr, message, signature });
  } catch { return { ok: false, error: 'signature verification failed' }; }
  if (!recovered) return { ok: false, error: 'signature does not match this wallet' };

  return { ok: true, address: addr, nonce, chainId, uri: String(siwe['URI'] || '') };
}

// A signed value a client can also compute (for a `/proof`-style recompute in
// the Vault): keccak over the message + address → the "wallet-linked claim" id.
export function walletClaimId(address, message) {
  return '0x' + createHash('sha256').update(`${address.toLowerCase()}:${message}`).digest('hex').slice(0, 40);
}

export const NORMALIZE = normalizeAddress;
export const TTL = NONCE_TTL_MS;