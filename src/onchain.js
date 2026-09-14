// WAITSI VaultAnchor writer — anchors each real x402-funded top-up as a
// hash-chained, tamper-evident receipt on-chain (the proved on-chain-writer
// degrade pattern: real txs when a PK is present, honest local receipts when
// not — never a claim to be on-chain when it isn't).
import { createPublicClient, http, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ABIFN = [
  { type: 'function', name: 'record', inputs: [{ type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'receiptCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'receiptSeq', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'event', name: 'ReceiptRecorded',
    inputs: [{ type: 'uint256', name: 'seq', indexed: true }, { type: 'bytes32', name: 'actionHash', indexed: true },
              { type: 'bytes32', name: 'prevHash', indexed: false }, { type: 'string', name: 'txHash', indexed: false },
              { type: 'uint256', name: 'amountMicro', indexed: false }, { type: 'uint256', name: 'discoveryId', indexed: false },
              { type: 'address', name: 'by', indexed: false }] },
];

function cfg(env = process.env) {
  const rpc = env.WAITSI_ANCHOR_RPC || env.WAITSI_X402_RPC || 'https://base-sepolia.publicnode.com';
  const chainId = Number(env.WAITSI_ANCHOR_CHAIN_ID || env.WAITSI_X402_CHAIN_ID || 84532);
  const address = (env.WAITSI_ANCHOR_ADDRESS || '').toLowerCase();
  const pk = (env.WAITSI_ANCHOR_PK || env.X402_EXECUTOR_PK || '').trim();
  return { rpc, chainId, address, pk };
}

export function makeVaultWriter({ env = process.env } = {}) {
  const c = cfg(env);
  const chain = { id: c.chainId, name: `chain-${c.chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } };

  const ready = !!(c.pk && c.address);
  const client = ready
    ? createWalletClient({ account: privateKeyToAccount(c.pk), chain, transport: http(c.rpc, { timeout: 15_000 }) })
    : null;
  const pc = createPublicClient({ chain, transport: http(c.rpc, { timeout: 15_000 }) });

  async function anchor({ txHash, amountMicro, discoveryId }) {
    if (!ready) {
      return { live: false, mode: 'logging', reason: 'WAITSI_ANCHOR_PK/ADDRESS unset — receipt kept locally, replay when funded' };
    }
    try {
      const hash = await client.writeContract({
        address: c.address, abi: ABIFN, functionName: 'record',
        args: [txHash, BigInt(amountMicro), BigInt(discoveryId)],
      });
      await pc.waitForTransactionReceipt({ hash });
      const count = await pc.readContract({ address: c.address, abi: ABIFN, functionName: 'receiptCount' });
      return { live: true, mode: 'onchain', seq: Number(count) - 1, anchorTx: hash, contract: c.address, chainId: c.chainId };
    } catch (e) {
      return { live: false, mode: 'failed_local', reason: e.shortMessage || e.message };
    }
  }

  return { ready, address: c.address, chainId: c.chainId, anchor, pc, abi: ABIFN };
}