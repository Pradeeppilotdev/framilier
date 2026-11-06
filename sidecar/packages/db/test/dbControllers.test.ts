import { describe, it, expect } from "vitest";
import { LocalDbController } from "../src/localDb.js";

/**
 * Regression test for the exact bug: a value written with a bigint field,
 * read back via the SAME controller instance, must still have a real
 * bigint - not a plain hex string - and a genuinely-string hex field must
 * not have been corrupted into a bigint by the fix. `LocalDbController`
 * exercises the identical `replaceBigints`/`reviveBigints` pair
 * `RocksDbController` uses (see bigintJson.ts) without needing a real
 * RocksDB instance.
 */
describe("LocalDbController bigint round trip", () => {
  it("returns a real bigint (not a string) for a numeric field after put+get", async () => {
    const db = new LocalDbController("test");
    await db.put("entry", {
      tx: { nonce: 0n, chainId: 9n, sender: "0x1111111111111111111111111111111111111111" },
    });

    const read = await db.get<{
      tx: { nonce: bigint; chainId: bigint; sender: string };
    }>("entry");

    expect(read.tx.nonce).toBe(0n);
    expect(typeof read.tx.nonce).toBe("bigint");
    expect(read.tx.chainId).toBe(9n);
    expect(read.tx.sender).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof read.tx.sender).toBe("string");
  });

  it("returns real bigints via getMany too", async () => {
    const db = new LocalDbController("test");
    await db.put("a", { nonce: 0n });
    await db.put("b", { nonce: 1n });

    const [a, b] = await db.getMany<{ nonce: bigint }>(["a", "b"]);

    expect(a.nonce).toBe(0n);
    expect(b.nonce).toBe(1n);
  });
});
