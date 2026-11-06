import { describe, it, expect } from "vitest";
import { whatHappened } from "./ActivityScreen";
import type { Admission } from "../../protocol/schemas";

const base: Admission = {
  id: 1,
  txHash: "0x1",
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x0",
  at: 0,
  source: "rpc",
  outcome: "accepted",
  checks: [],
  frames: [],
  frameStatuses: [],
};

describe("ActivityScreen whatHappened", () => {
  it("describes a dropped transaction with its detail, falling back to a generic label", () => {
    expect(whatHappened({ ...base, outcome: "dropped" })).toBe("Dropped from the mempool");
  });

  it("describes an included transaction, naming the includer when present", () => {
    expect(
      whatHappened({
        ...base,
        outcome: "included",
        includer: "0x9999999999999999999999999999999999999999",
      })
    ).toMatch(/Included.*0x9999/);
  });

  it("describes an included transaction with no includer", () => {
    expect(whatHappened({ ...base, outcome: "included" })).toBe("Included");
  });
});
