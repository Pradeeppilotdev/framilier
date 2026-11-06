import { describe, it, expect, vi } from "vitest";
import { validateGossipVerifiedFrameTx } from "../../../src/network/validation/verifiedFrameTx.js";
import { GossipValidationError, GossipErrorCode } from "../../../src/network/gossip/errors.js";

describe("validateGossipVerifiedFrameTx", () => {
  it("rejects a transaction whose block hash is more than 20 blocks stale", async () => {
    const config = {
      getPublicClient: () => ({ getBlockNumber: async () => 1000n }),
    } as any;
    const staleFrameTx = { verified_at_block_hash: 979n }; // 1000 - 21
    await expect(validateGossipVerifiedFrameTx(config, staleFrameTx)).rejects.toThrow(GossipValidationError);
  });

  it("accepts a transaction within the staleness window", async () => {
    const config = {
      getPublicClient: () => ({ getBlockNumber: async () => 1000n }),
    } as any;
    const freshFrameTx = { verified_at_block_hash: 985n }; // 1000 - 15
    await expect(validateGossipVerifiedFrameTx(config, freshFrameTx)).resolves.not.toThrow();
  });
});
