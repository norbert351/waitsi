// Real x402 sponsor top-up — hermetic end-to-end on a LOCAL Anvil chain.
// Proves the whole gate with ZERO external funding: deploy a mintable token,
// a sponsor pays on-chain, signs the EIP-712 Payment, replays, and WAITSI
// funds the discovery's budget from the VERIFIED asset-backed settlement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootServer } from './harness.js';
import { createPublicClient, http, getAddress, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const exec = promisify(execFile);
const ANVIL_URL = 'http://127.0.0.1:8550';
const RPC = ANVIL_URL;
const CHAIN_ID = 31337; // anvil default
const SERVER_PORT = 3210;
const PRICE = 5_000_000n; // 5 USDX (6 decimals)
const BUYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYTO_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FORGE = `${process.env.HOME}/.foundry/bin/forge`;
const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;

const chain = { id: CHAIN_ID, name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const tokenAbi = [
  { type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'event', name: 'Transfer', inputs: [{ type: 'address', name: 'from', indexed: true }, { type: 'address', name: 'to', indexed: true }, { type: 'uint256', name: 'value', indexed: false }] },
];

let anvilProc, token, anchorAddr, buyer, payTo, base, proc, discoveryId, priorRemaining;

function req(method, path, body, headers = {}) {
  return fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), hdrs: r.headers }));
}

async function waitAnvil() {
  const pc = createPublicClient({ chain, transport: http(RPC, { timeout: 4000 }) });
  for (let i = 0; i < 40; i++) { try { await pc.getBlockNumber(); return; } catch { await new Promise(r => setTimeout(r, 300)); } }
  throw new Error('anvil never came up');
}

before(async () => {
  anvilProc = spawn(ANVIL, ['--port', '8550', '--chain-id', String(CHAIN_ID)], { stdio: 'ignore' });
  await waitAnvil();

  // Deploy the local settle token.
  const { stdout } = await exec(FORGE, ['create', 'test/contracts/UnitToken.sol:UnitToken', '--rpc-url', RPC, '--private-key', BUYER_KEY, '--broadcast'], { cwd: process.cwd() })
    .catch((e) => { throw new Error('forge create failed:\n' + (e.stdout || '') + (e.stderr || '')); });
  const m = stdout.match(/Deployed to: (0x[a-fA-F0-9]{40})/);
  if (!m) throw new Error('no Deployed-to line:\n' + stdout);
  token = m[1].toLowerCase();

  // Deploy the on-chain VaultAnchor receipt ledger.
  const aout = await exec(FORGE, ['create', 'test/contracts/VaultAnchor.sol:VaultAnchor', '--rpc-url', RPC, '--private-key', BUYER_KEY, '--broadcast'], { cwd: process.cwd() })
    .catch((e) => { throw new Error('vault create failed:\n' + (e.stdout || '') + (e.stderr || '')); });
  const am = aout.stdout.match(/Deployed to: (0x[a-fA-F0-9]{40})/);
  if (!am) throw new Error('no VaultAnchor Deployed-to line:\n' + aout.stdout);
  anchorAddr = am[1].toLowerCase();

  buyer = privateKeyToAccount(BUYER_KEY);
  payTo = privateKeyToAccount(PAYTO_KEY).address.toLowerCase();
  const pc = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });

  // Fund the buyer with settle tokens + ensure payTo has native gas (anvil funds all).
  const wc = { writeContract: async (args) => {
    const { createWalletClient } = await import('viem');
    const c = createWalletClient({ account: buyer, chain, transport: http(RPC) });
    return c.writeContract(args);
  } };
  const mint = await wc.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [buyer.address, PRICE * 3n] });
  await pc.waitForTransactionReceipt({ hash: mint });
  console.log('deployed token', token, 'vaultAnchor', anchorAddr, 'payTo', payTo);

  // Boot the WAITSI server with the gate + vault anchor pointed at Anvil.
  const booted = await bootServer({
    port: SERVER_PORT,
    schema: 'x402_' + Date.now(),
    extraEnv: {
      WAITSI_X402_RPC: RPC,
      WAITSI_X402_CHAIN_ID: String(CHAIN_ID),
      WAITSI_X402_ASSET: token,
      WAITSI_X402_PAYTO: payTo,
      WAITSI_X402_PRICE_ATOMIC: PRICE.toString(),
      WAITSI_X402_DECIMALS: '6',
      WAITSI_ANCHOR_RPC: RPC,
      WAITSI_ANCHOR_CHAIN_ID: String(CHAIN_ID),
      WAITSI_ANCHOR_ADDRESS: anchorAddr,
      WAITSI_ANCHOR_PK: BUYER_KEY,
    },
  });
  proc = booted.proc;
  base = booted.base;

  // Create a fresh discovery with a KNOWN budget (budgetMicro), then fund it.
  const created = await req('POST', '/admin/campaigns', {
    sponsor: 'X402 Sponsor', title: 'Real scope', category: 'tool', cpm: 2000, budgetMicro: 1_000_000,
  });
  discoveryId = created.body?.campaign?.id ?? created.body?.id;
  priorRemaining = 1_000_000; // the known created budget
  assert.ok(discoveryId, 'created a discovery to fund: ' + JSON.stringify(created.body));
  console.log('funding discovery', discoveryId, 'priorRemaining', priorRemaining);
});

after(async () => {
  if (proc) proc.kill();
  if (anvilProc) anvilProc.kill();
});

// Mirror the gate's toPaymentMessage so we sign EXACTLY what it verifies.
function msgOf(a) {
  return { scheme: 'exact', network: a.network, chainId: BigInt(a.chainId), asset: a.asset,
    amount: String(a.amount), payTo: a.payTo, maxTimeoutSeconds: BigInt(a.maxTimeoutSeconds),
    description: a.description || '', extra: typeof a.extra === 'string' ? a.extra : JSON.stringify(a.extra || {}) };
}
const TYPES = { Payment: [
  { name: 'scheme', type: 'string' }, { name: 'network', type: 'string' }, { name: 'chainId', type: 'uint256' },
  { name: 'asset', type: 'address' }, { name: 'amount', type: 'string' }, { name: 'payTo', type: 'address' },
  { name: 'maxTimeoutSeconds', type: 'uint256' }, { name: 'description', type: 'string' }, { name: 'extra', type: 'string' },
] };
const DOMAIN = { name: 'x402', version: '2', chainId: CHAIN_ID };

test('sponsor fund: 402 -> pay on-chain -> sign -> replay funds the real budget; replay rejected', async () => {
  // 1. No header -> 402 + challenge
  const probe = await req('POST', '/v1/sponsor/fund', { discoveryId });
  assert.equal(probe.status, 402, 'unpaid probe must 402');
  assert.ok(probe.hdrs.get('payment-required'), 'challenge header present');
  const challenge = JSON.parse(Buffer.from(probe.hdrs.get('payment-required'), 'base64').toString());
  const a = challenge.accepts[0];
  assert.equal(a.scheme, 'exact');
  assert.equal(String(a.amount), PRICE.toString());
  assert.equal(a.payTo.toLowerCase(), payTo);

  // 2. Sponsor pays on-chain (transfer to payTo), wait for receipt.
  const pc = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });
  const { createWalletClient } = await import('viem');
  const wc = createWalletClient({ account: buyer, chain, transport: http(RPC) });
  const tx = await wc.writeContract({ address: token, abi: tokenAbi, functionName: 'transfer', args: [payTo, PRICE] });
  await pc.waitForTransactionReceipt({ hash: tx });
  await new Promise(r => setTimeout(r, 500)); // give anvil a block

  // 3. Sign EIP-712 Payment (typed-data) covering the settlement.
  const signature = await buyer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Payment', message: msgOf(a) });

  // 4. Replay with PAYMENT-SIGNATURE -> 200 + budget funded.
  const header = Buffer.from(JSON.stringify({ accepted: a, signature, payer: buyer.address })).toString('base64');
  const replay = await req('POST', '/v1/sponsor/fund', { discoveryId }, { 'PAYMENT-SIGNATURE': header });
  assert.equal(replay.status, 200, 'valid settlement must fund: ' + JSON.stringify(replay.body));
  assert.equal(replay.body.funded, true);
  assert.equal(replay.body.budgetRemaining, priorRemaining + Number(PRICE), 'budget grown by the real payment');
  assert.equal(replay.body.txHash.toLowerCase(), tx.toLowerCase());

  // 5. Same header replayed -> 402 payment_already_used (one transfer = one top-up).
  const replay2 = await req('POST', '/v1/sponsor/fund', { discoveryId }, { 'PAYMENT-SIGNATURE': header });
  assert.equal(replay2.status, 402);
  assert.equal(replay2.body.code, 'payment_already_used');

  // 5b. The REAL settlement was anchored as a tamper-evident on-chain receipt.
  assert.equal(replay.body.anchor.live, true, 'anchor writer live');
  assert.equal(replay.body.anchor.mode, 'onchain');
  assert.ok(replay.body.anchor.anchorTx, 'anchor receipt tx present');
  const receiptAbiF = [
    { type: 'function', name: 'receiptCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    { type: 'function', name: 'receiptSeq', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  ];
  const count = await pc.readContract({ address: anchorAddr, abi: receiptAbiF, functionName: 'receiptCount' });
  assert.equal(Number(count), 1, 'the funding receipt is anchored on-chain');
  const seq0 = await pc.readContract({ address: anchorAddr, abi: receiptAbiF, functionName: 'receiptSeq', args: [0n] });
  assert.notEqual(seq0, '0x0000000000000000000000000000000000000000000000000000000000000000', 'chain head set');
});

test('a signed-but-never-paid header is rejected (payment_not_settled)', async () => {
  const probe = await req('POST', '/v1/sponsor/fund', { discoveryId });
  const a = JSON.parse(Buffer.from(probe.hdrs.get('payment-required'), 'base64').toString()).accepts[0];
  // A FRESH payer signs the payment but never settles on-chain (no Transfer to
  // payTo by this payer in the scan window), so verification -> payment_not_settled.
  const NEG_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // anvil account 2
  const neg = privateKeyToAccount(NEG_KEY);
  const signature = await neg.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Payment', message: msgOf(a) });
  const header = Buffer.from(JSON.stringify({ accepted: a, signature, payer: neg.address })).toString('base64');
  const r = await req('POST', '/v1/sponsor/fund', { discoveryId }, { 'PAYMENT-SIGNATURE': header });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'payment_not_settled');
});