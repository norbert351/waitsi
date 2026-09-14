// Real x402 seller gate — makes WAITSI's sponsor budget on-chain funded.
//
// Instead of an admin typing a number into `discoveries.budget_remaining`, a
// sponsor TOP-UPS a discovering's budget with a REAL USDC payment:
//   1. POST /v1/sponsor/fund {discoveryId}                -> 402 + challenge
//   2. sponsor wallet: USDC.transfer(payTo, amount)        (on-chain)
//   3. sponsor signs the Payment typed-data, replays with PAYMENT-SIGNATURE
//   4. gateway verifies signature + on-chain Transfer to payTo + replay ring
//   5. budget_remaining += amount  ->  every later `sponsor_rev`/`discovery`
//      credit back to builders is asset-backed, not a Postgres guess.
//
// Chain-parametrised (default Base Sepolia USDC — the proven rail). Verified
// end-to-end on a local Anvil chain; going LIVE needs the payTo key funded.
import {
  createPublicClient, http, verifyTypedData, getAddress, parseUnits,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'node:crypto';

export const NETWORK = 'x402';
export const VERSION = '2';

// ---- config (env-overridable so tests point the gate at Anvil) -------------
function cfg(env = process.env) {
  const chainId = Number(env.WAITSI_X402_CHAIN_ID || 84532);
  const rpc = env.WAITSI_X402_RPC || 'https://base-sepolia.publicnode.com';
  const asset = (env.WAITSI_X402_ASSET || '0x036CbD53842c5426634e7929541eC2318f3dCF7e').toLowerCase();
  const decimals = Number(env.WAITSI_X402_DECIMALS || 6);
  const priceAtomic = BigInt(env.WAITSI_X402_PRICE_ATOMIC || '5000000'); // default 5 USDC
  const payTo = (env.WAITSI_X402_PAYTO
    || (env.X402_EXECUTOR_PK ? privateKeyToAccount(env.X402_EXECUTOR_PK).address : '')).toLowerCase();
  const chain = chainId === 11155111 ? baseSepolia : undefined;
  const chainish = {};
  if (chain) { for (const k of ['id', 'name', 'nativeCurrency']) chainish[k] = chain[k]; chainish.rpcUrls = { default: { http: [rpc] } }; }
  else { chainish.id = chainId; chainish.name = `chain-${chainId}`; chainish.nativeCurrency = { name: 'ETH', symbol: 'ETH', decimals: 18 }; chainish.rpcUrls = { default: { http: [rpc] } }; }
  return { chainId, rpc, asset, decimals, priceAtomic, payTo, chainish };
}

function usdcAbi() {
  return [{ type: 'event', name: 'Transfer',
    inputs: [{ type: 'address', name: 'from', indexed: true }, { type: 'address', name: 'to', indexed: true },
              { type: 'uint256', name: 'value', indexed: false }] }];
}

const EIP712_DOMAIN = { name: NETWORK, version: VERSION };
const EIP712_TYPES = { Payment: [
  { name: 'scheme', type: 'string' }, { name: 'network', type: 'string' }, { name: 'chainId', type: 'uint256' },
  { name: 'asset', type: 'address' }, { name: 'amount', type: 'string' }, { name: 'payTo', type: 'address' },
  { name: 'maxTimeoutSeconds', type: 'uint256' }, { name: 'description', type: 'string' }, { name: 'extra', type: 'string' },
] };

function toPaymentMessage(a, chainId) {
  return { scheme: 'exact', network: `eip155:${chainId}`, chainId: BigInt(chainId),
    asset: a.asset.toLowerCase(), amount: String(a.amount),
    payTo: a.payTo.toLowerCase(), maxTimeoutSeconds: BigInt(a.maxTimeoutSeconds),
    description: a.description || '', extra: typeof a.extra === 'string' ? a.extra : JSON.stringify(a.extra || {}) };
}

export function buildChallenge({ resource, env = process.env } = {}) {
  const c = cfg(env);
  const payload = {
    x402Version: 2, error: 'Payment required', resource,
    accepts: [{
      scheme: 'exact', network: `eip155:${c.chainId}`, chainId: c.chainId,
      asset: c.asset, amount: c.priceAtomic.toString(), payTo: c.payTo,
      maxTimeoutSeconds: 600, description: `WAITSI sponsor top-up: ${resource}`,
      extra: { name: NETWORK, version: VERSION },
    }],
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// db is expected to expose `paymentConsumed(txHash)` -> true if freshly banked.
export function makeGate({ db, env = process.env } = {}) {
  const c = cfg(env);
  const pc = createPublicClient({ chain: c.chainish, transport: http(c.rpc, { timeout: 15_000 }) });

  async function verifyPayment(header) {
    const { accepted, signature, payer } = JSON.parse(Buffer.from(header, 'base64').toString());
    // cheap checks first
    if (String(accepted.amount) !== c.priceAtomic.toString()) throw { code: 'amount_mismatch' };
    if (String(accepted.chainId) !== String(c.chainId)) throw { code: 'chain_mismatch' };
    if (String(accepted.asset).toLowerCase() !== c.asset) throw { code: 'asset_mismatch' };
    if (String(accepted.payTo).toLowerCase() !== c.payTo) throw { code: 'payto_mismatch' };

    const payerAddr = getAddress(String(payer));
    const msg = toPaymentMessage(accepted, c.chainId);
    const dom = { ...EIP712_DOMAIN, chainId: BigInt(c.chainId) };
    const ok = await verifyTypedData({ address: payerAddr, domain: dom, types: EIP712_TYPES,
      primaryType: 'Payment', message: msg, signature });
    if (!ok) throw { code: 'signer_mismatch' };

    // on-chain settlement: a Transfer from payer -> payTo of the exact amount
    const latest = await pc.getBlockNumber();
    const back = latest - 100n;
    const from = back < 1n ? 1n : back;
    const events = await pc.getLogs({ address: c.asset, event: usdcAbi()[0],
      args: { from: payerAddr, to: getAddress(c.payTo) }, fromBlock: from, toBlock: latest });
    const match = [...events].reverse().find((e) => e.args.value === c.priceAtomic);
    if (!match) throw { code: 'payment_not_settled' };
    const txHash = match.transactionHash;
    // durable replay ring: true only when freshly banked (INSERT OR IGNORE); a
    // replayed tx was already consumed -> payment_already_used. One transfer = one request.
    if (typeof db.markPaymentConsumed !== 'function') throw { code: 'internal_no_db' };
    const fresh = await db.markPaymentConsumed({
      txHash, asset: c.asset, amountMicro: Number(c.priceAtomic), chainId: c.chainId,
      payer: payerAddr.toLowerCase(), payTo: getAddress(c.payTo),
    });
    if (!fresh) throw { code: 'payment_already_used' };
    return { payer: payerAddr.toLowerCase(), txHash };
  }

  async function send402(res, resource, code, detail) {
    res.writeHead(402, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE',
      'PAYMENT-REQUIRED': buildChallenge({ resource, env }),
      'WWW-Authenticate': 'Payment x402Version="2"',
    });
    res.end(JSON.stringify({ error: 'payment required', reason: 'Pay to fund the sponsor budget', ...(code ? { code } : {}), ...(detail ? { detail } : {}) }));
  }

  return { cfg: c, configured: !!(c.payTo && c.rpc && c.asset), verifyPayment, send402 };
}