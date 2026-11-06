import { describe, it, expect } from "vitest";
import { PooledFrameTxHashes } from "../../../src/reqresp/protocols/PooledFrameTxHashes.js";

describe("PooledFrameTxHashes protocol definition", () => {
  it("declares the expected method name and encoding", () => {
    const def = PooledFrameTxHashes({} as any, (() => {}) as any);
    expect(def.method).toBe("pooled_frame_tx_hashes");
    expect(def.encoding).toBe("ssz_snappy");
  });
});
