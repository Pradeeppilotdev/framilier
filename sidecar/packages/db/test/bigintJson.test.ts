import { describe, it, expect } from "vitest";
import { replaceBigints, reviveBigints } from "../src/bigintJson.js";

/**
 * Regression coverage for a real bug found via a real end-to-end test:
 * `JSON.stringify(value, replaceBigints)` turned every bigint into a plain
 * hex string, but `JSON.parse` was called with no matching reviver
 * anywhere - so every bigint field silently came back as a string after a
 * DB write-then-read round trip. A naive fix (reviving every `0x...`
 * string as a BigInt) would have been actively wrong: it's indistinguishable
 * from a genuinely-string hex field (an address, a hash, a signature).
 */
describe("bigintJson replacer/reviver round trip", () => {
  it("round-trips a bigint back to a bigint through JSON.stringify/parse", () => {
    const original = { nonce: 0n, chainId: 9n, big: 123456789012345678901234567890n };
    const json = JSON.stringify(original, replaceBigints);
    const revived = JSON.parse(json, reviveBigints);

    expect(revived.nonce).toBe(0n);
    expect(typeof revived.nonce).toBe("bigint");
    expect(revived.chainId).toBe(9n);
    expect(revived.big).toBe(123456789012345678901234567890n);
  });

  it("does NOT turn a genuinely-string hex field (e.g. an address) into a bigint", () => {
    const original = {
      sender: "0x1111111111111111111111111111111111111111",
      nonce: 0n,
    };
    const json = JSON.stringify(original, replaceBigints);
    const revived = JSON.parse(json, reviveBigints);

    expect(revived.sender).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof revived.sender).toBe("string");
    expect(revived.nonce).toBe(0n);
  });

  it("round-trips nested objects and arrays of bigints", () => {
    const original = {
      tx: {
        nonce: 1n,
        frames: [
          { limits: { execution: 30000n, state: 0n } },
          { limits: { execution: 50000n, state: 0n } },
        ],
        fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
      },
    };
    const revived = JSON.parse(
      JSON.stringify(original, replaceBigints),
      reviveBigints
    );

    expect(revived.tx.nonce).toBe(1n);
    expect(revived.tx.frames[0].limits.execution).toBe(30000n);
    expect(revived.tx.frames[1].limits.execution).toBe(50000n);
    expect(revived.tx.fees.maxFeePerGas).toBe(2_000_000_000n);
  });

  it("leaves non-bigint, non-tagged values untouched", () => {
    const original = { status: 2, label: "New", nested: { ok: true } };
    const revived = JSON.parse(
      JSON.stringify(original, replaceBigints),
      reviveBigints
    );

    expect(revived).toEqual(original);
  });
});
