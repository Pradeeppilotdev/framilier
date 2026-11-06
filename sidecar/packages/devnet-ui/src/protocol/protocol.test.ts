import { describe, expect, it } from "vitest";
import {
  AdmissionRecordSchema,
  ExplorerInfoSchema,
  LifecycleEventSchema,
  SerializedFrameTxSchema,
  TransactionDetailSchema,
  protocolGuards,
} from "./schemas";
import { SUPPORTED_PROTOCOL_VERSION, checkProtocol } from "./compat";

const admission = {
  id: 4,
  txHash: "0xaa",
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x2",
  at: 1760000000000,
  source: "gossip:16Uiu2HAm",
  outcome: "rejected",
  errorCode: -32502,
  checks: [
    { rule: "prefix", verdict: "pass" },
    {
      rule: "OP-011",
      frameIndex: 0,
      entity: "payer",
      verdict: "fail",
      detail: "payer uses banned opcode: DIFFICULTY",
    },
    { rule: "mempool", verdict: "skipped" },
  ],
  frames: [
    { mode: 1, flags: 3, target: null, limits: { execution: "0x64", state: "0x0" }, value: "0x0", data: "0x" },
  ],
  frameStatuses: ["not-run"],
};

const info = {
  protocolVersion: 1,
  chainId: 1337,
  version: "4.1.1",
  commit: "abc1234",
  bundlingMode: "auto",
  p2pEnabled: true,
  latestSeq: 9,
  oldestSeq: 1,
  historyCapacity: 10000,
  bootId: "0011223344556677",
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
};

describe("protocol schemas", () => {
  it("keeps the compile-time guard against the backend wire types", () => {
    expect(protocolGuards).toBe(true);
  });

  it("accepts a full admission record", () => {
    expect(AdmissionRecordSchema.parse(admission)).toEqual(admission);
  });

  it("drops unknown keys and tolerates unknown rule ids and lifecycle kinds", () => {
    const parsed = AdmissionRecordSchema.parse({
      ...admission,
      surprise: true,
      checks: [{ rule: "some-future-rule", verdict: "pass", extra: 1 }],
    });
    expect(parsed).not.toHaveProperty("surprise");
    expect(parsed.checks[0]).toEqual({ rule: "some-future-rule", verdict: "pass" });
    expect(
      LifecycleEventSchema.parse({ seq: 1, txHash: "0xaa", at: 1, kind: "brand-new-kind" }).kind,
    ).toBe("brand-new-kind");
  });

  it("rejects an unknown verdict and a missing bootId", () => {
    expect(
      AdmissionRecordSchema.safeParse({ ...admission, checks: [{ rule: "x", verdict: "maybe" }] })
        .success,
    ).toBe(false);
    const { bootId: _omit, ...withoutBootId } = info;
    expect(ExplorerInfoSchema.safeParse(withoutBootId).success).toBe(false);
    expect(ExplorerInfoSchema.safeParse(info).success).toBe(true);
  });

  it("accepts a detail with a null entry (a rejected transaction)", () => {
    const detail = { hash: "0xaa", entry: null, admission, events: [] };
    expect(TransactionDetailSchema.parse(detail).entry).toBeNull();
  });

  it("parses a serialized frame transaction and rejects a malformed one", () => {
    const tx = {
      chainId: "0x539",
      nonce: "0x1",
      sender: "0x1111111111111111111111111111111111111111",
      frames: [
        {
          mode: 1,
          flags: 3,
          target: null,
          limits: { execution: "0x7530", state: "0x0" },
          value: "0x0",
          data: "0x",
        },
      ],
      fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x2", maxFeePerBlobGas: "0x0" },
    };
    expect(SerializedFrameTxSchema.safeParse(tx).success).toBe(true);
    expect(SerializedFrameTxSchema.safeParse({ ...tx, frames: [{ mode: "verify" }] }).success).toBe(
      false,
    );
  });
});

describe("checkProtocol", () => {
  it("accepts the supported version", () => {
    expect(checkProtocol({ protocolVersion: SUPPORTED_PROTOCOL_VERSION })).toEqual({ ok: true });
  });

  it("reports both versions on a mismatch", () => {
    expect(checkProtocol({ protocolVersion: 2 })).toEqual({
      ok: false,
      nodeVersion: 2,
      supported: SUPPORTED_PROTOCOL_VERSION,
    });
  });
});
