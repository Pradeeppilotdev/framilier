import { describe, it, expect } from "vitest";
import { ssz } from "../../src/node/frameTx.js";

describe("frame tx SSZ schemas", () => {
  it("serializes and deserializes a VerifiedFrameTx round-trip", () => {
    const sample = ssz.VerifiedFrameTx.defaultValue();
    const serialized = ssz.VerifiedFrameTx.serialize(sample);
    const deserialized = ssz.VerifiedFrameTx.deserialize(serialized);
    expect(ssz.VerifiedFrameTx.equals(sample, deserialized)).toBe(true);
  });
});
