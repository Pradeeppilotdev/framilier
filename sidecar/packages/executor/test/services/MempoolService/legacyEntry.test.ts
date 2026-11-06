import { describe, it, expect } from "vitest";
import { FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { rawEntryToMempoolEntry } from "../../../src/services/MempoolService/utils.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

// An entry exactly as RocksDB held it before EIP-8250/8272 support: a scalar
// `nonce` and no `recentRootReferences`.
const legacyRaw = {
  chainId: 1,
  tx: {
    chainId: 1n,
    nonce: 12n,
    sender: SENDER,
    frames: [
      {
        mode: FRAME_MODE.VERIFY,
        flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
        target: null,
        limits: { execution: 1n, state: 0n },
        value: 0n,
        data: "0x",
      },
    ],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
  },
  txHash: "0xabc",
  lastUpdatedTime: 0,
  status: MempoolEntryStatus.New,
  submitAttempts: 0,
};

describe("rawEntryToMempoolEntry - entries stored before EIP-8250/8272", () => {
  it("reads a scalar nonce as the linear domain and defaults references to none", () => {
    const entry = rawEntryToMempoolEntry(legacyRaw as any);
    expect(entry.tx.nonceKeys).toEqual([0n]);
    expect(entry.tx.nonceSeq).toBe(12n);
    expect(entry.tx.recentRootReferences).toEqual([]);
    expect("nonce" in entry.tx).toBe(false);
  });

  it("leaves a current-shape entry untouched", () => {
    const { nonce: _nonce, ...tx } = legacyRaw.tx;
    const current = {
      ...legacyRaw,
      tx: { ...tx, nonceKeys: [3n], nonceSeq: 1n, recentRootReferences: [] },
    };
    const entry = rawEntryToMempoolEntry(current as any);
    expect(entry.tx.nonceKeys).toEqual([3n]);
    expect(entry.tx.nonceSeq).toBe(1n);
  });
});
