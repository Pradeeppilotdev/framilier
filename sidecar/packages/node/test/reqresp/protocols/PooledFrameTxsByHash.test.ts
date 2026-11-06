import { describe, it, expect } from "vitest";
import { PooledFrameTxsByHash } from "../../../src/reqresp/protocols/PooledFrameTxsByHash.js";

describe("PooledFrameTxsByHash protocol definition", () => {
  it("declares the expected method name and encoding", () => {
    const def = PooledFrameTxsByHash({} as any, (() => {}) as any);
    expect(def.method).toBe("pooled_frame_txs_by_hash");
    expect(def.encoding).toBe("ssz_snappy");
  });
});
