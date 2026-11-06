import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * A valid `eth_sendFrameTransaction`/`debug_bundler_setMempool`-style wire
 * payload: every gas/value/chainId/nonce-shaped field is a hex STRING
 * (`FrameTransactionSerialized`'s convention, see `../src/utils/frameTx.ts`'s
 * header comment), `mode`/`flags` are plain numbers.
 */
export const validFrameTransactionWire = {
  chainId: "0x1",
  nonce: "0x0",
  sender: "0x1111111111111111111111111111111111111111",
  frames: [
    {
      mode: 0,
      flags: 0,
      target: "0x2222222222222222222222222222222222222222",
      limits: { execution: "0x100000", state: "0x100000" },
      value: "0x0",
      data: "0x",
    },
  ],
  signatures: [
    {
      scheme: 1,
      signer: "0x1111111111111111111111111111111111111111",
      msg: "0x",
      signature: "0xabcd",
    },
  ],
  fees: {
    maxPriorityFeePerGas: "0x1",
    maxFeePerGas: "0x2",
    maxFeePerBlobGas: "0x0",
  },
  blobVersionedHashes: [],
  recentRootReferences: [],
};

/** The `FrameTransaction` (real `bigint` fields) `validFrameTransactionWire` should decode to. */
export const validFrameTransaction: FrameTransaction = {
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: "0x1111111111111111111111111111111111111111",
  frames: [
    {
      mode: 0,
      flags: 0,
      target: "0x2222222222222222222222222222222222222222",
      limits: { execution: 0x100000n, state: 0x100000n },
      value: 0n,
      data: "0x",
    },
  ],
  signatures: [
    {
      scheme: 1,
      signer: "0x1111111111111111111111111111111111111111",
      msg: "0x",
      signature: "0xabcd",
    },
  ],
  fees: {
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 2n,
    maxFeePerBlobGas: 0n,
  },
  blobVersionedHashes: [],
  recentRootReferences: [],
};
