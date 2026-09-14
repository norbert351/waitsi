// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// WAITSI VaultAnchor — an append-only, hash-chained receipt ledger so each real
// x402-funded budget top-up is provable ON-CHAIN. Every record links to the
// previous (prevHash), so deleting/reordering any earlier receipt is detectable
// — the "Vault" is a verifiable chain of custody, not a Postgres fiction.
contract VaultAnchor {
  uint256 public receiptCount;
  mapping(uint256 => bytes32) public receiptSeq; // seq -> chain head at that record

  event ReceiptRecorded(
    uint256 indexed seq,
    bytes32 indexed actionHash,
    bytes32 prevHash,
    string txHash,
    uint256 amountMicro,
    uint256 discoveryId,
    address by
  );

  // Chain a receipt onto the ledger. txHash = the real x402 USDC settlement tx.
  function record(string calldata txHash, uint256 amountMicro, uint256 discoveryId)
    external
    returns (uint256 seq)
  {
    seq = receiptCount;
    bytes32 prev = seq == 0 ? bytes32(0) : receiptSeq[seq - 1];
    bytes32 actionHash = keccak256(abi.encodePacked(txHash, amountMicro, discoveryId, block.timestamp, msg.sender));
    receiptSeq[seq] = keccak256(abi.encodePacked(prev, actionHash));
    receiptCount++;
    emit ReceiptRecorded(seq, actionHash, prev, txHash, amountMicro, discoveryId, msg.sender);
    return seq;
  }
}