import { describe, expect, it } from "vitest";
import {
  describeSource,
  sourcePeer,
  formatAgo,
  formatBytes,
  formatClock,
  formatDelta,
  formatEther,
  formatGwei,
  formatNonce,
  formatQuantity,
  formatRecentRoot,
  hexToBigInt,
  shortAddress,
  shortHash,
} from "./format";
import { EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";
import { describeFrames, entitiesByFrame, frameRole, parseFrameTx, scopeOf } from "./frames";
import { failureDetail, failureSummary, groupChecks, ruleInfo } from "./rules";
import type { Check } from "../protocol/schemas";

describe("format", () => {
  it("shortens hashes and leaves short strings alone", () => {
    expect(shortHash("0x1234567890abcdef1234567890abcdef")).toBe("0x1234…cdef");
    expect(shortHash("0x12")).toBe("0x12");
    expect(shortAddress("0x1111111111111111111111111111111111111111")).toBe("0x1111…1111");
  });

  it("reads hex quantities, treating empty or malformed input as zero", () => {
    expect(hexToBigInt("0x1f")).toBe(31n);
    expect(hexToBigInt("0x")).toBe(0n);
    expect(hexToBigInt("")).toBe(0n);
    expect(hexToBigInt("0xzz")).toBe(0n);
    expect(formatQuantity("0x7530")).toBe("30,000");
  });

  it("formats wei as gwei with up to three decimals", () => {
    expect(formatGwei("0x0")).toBe("0 gwei");
    expect(formatGwei("0x3b9aca00")).toBe("1 gwei"); // 1e9 wei
    expect(formatGwei("0x77359400")).toBe("2 gwei");
    expect(formatGwei("0x1dcd6500")).toBe("0.5 gwei"); // 5e8 wei
    expect(formatGwei("0x4a817c800")).toBe("20 gwei"); // 2e10 wei
    expect(formatGwei(`0x${(1_234_567_890n).toString(16)}`)).toBe("1.234 gwei");
    expect(formatGwei("0x1")).toBe("<0.001 gwei");
    expect(formatGwei(`0x${(1_500_000_000_000n).toString(16)}`)).toBe("1,500 gwei");
  });

  it("formats wei as ether with up to four decimals", () => {
    expect(formatEther("0x0")).toBe("0 ETH");
    expect(formatEther("0xde0b6b3a7640000")).toBe("1 ETH"); // 1e18 wei
    expect(formatEther("0x6f05b59d3b20000")).toBe("0.5 ETH"); // 5e17 wei
    expect(formatEther("0x1")).toBe("<0.0001 ETH");
  });

  it("formats a clock time with milliseconds in a chosen time zone", () => {
    expect(formatClock(Date.UTC(2026, 8, 24, 13, 5, 9, 42), "UTC")).toBe("13:05:09.042");
  });

  it("formats relative time coarsely", () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 2_000, now)).toBe("just now");
    expect(formatAgo(now - 12_000, now)).toBe("12 s ago");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(formatAgo(now + 5_000, now)).toBe("just now");
  });

  it("formats an offset from the first observation", () => {
    expect(formatDelta(0)).toBe("first");
    expect(formatDelta(240)).toBe("+240 ms");
    expect(formatDelta(1234)).toBe("+1.2 s");
    expect(formatDelta(180_000)).toBe("+3 min");
  });

  it("describes where a transaction first arrived from", () => {
    expect(describeSource("rpc")).toBe("Submitted by RPC");
    expect(describeSource("gossip:16Uiu2HAmKZdV7rQx")).toBe("P2P from 16Uiu2…7rQx");
    expect(describeSource("sync:16Uiu2HAm3PqWzE9nD")).toBe("P2P sync from 16Uiu2…E9nD");
    expect(describeSource("carrier-pigeon")).toBe("carrier-pigeon");
    expect(sourcePeer("gossip:16Uiu2HAmKZdV7rQx")).toBe("16Uiu2HAmKZdV7rQx");
    expect(sourcePeer("sync:16Uiu2HAm3PqWzE9nD")).toBe("16Uiu2HAm3PqWzE9nD");
    expect(sourcePeer("rpc")).toBeNull();
    expect(sourcePeer("carrier-pigeon")).toBeNull();
  });

  it("counts bytes in a data string", () => {
    expect(formatBytes("0x")).toBe("0 bytes");
    expect(formatBytes("0xaa")).toBe("1 byte");
    expect(formatBytes(`0x${"ab".repeat(36)}`)).toBe("36 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(36)).toBe("36 bytes");
  });
});

describe("frames", () => {
  it("decodes approval scope from the low two bits and ignores the atomic bit", () => {
    expect(scopeOf(0)).toBe("none");
    expect(scopeOf(1)).toBe("payment");
    expect(scopeOf(2)).toBe("execution");
    expect(scopeOf(3)).toBe("execution and payment");
    expect(scopeOf(0x4 | 0x2)).toBe("execution");
  });

  it("names a frame by its mode and scope", () => {
    expect(frameRole(1, 0)).toBe("expiry check");
    expect(frameRole(1, 1)).toBe("payment approval");
    expect(frameRole(1, 2)).toBe("execution approval");
    expect(frameRole(1, 3)).toBe("self-verification");
    expect(frameRole(2, 0)).toBe("user operation");
    expect(frameRole(0, 0)).toBe("deploy or post-operation");
    expect(frameRole(9, 0)).toBe("unknown frame");
  });

  it("labels a DEFAULT-mode frame by entity: factory is deploy, sender/payer is a pre-validation write, neither is ambiguous", () => {
    expect(frameRole(0, 0, "factory")).toBe("deploy");
    expect(frameRole(0, 0, "sender")).toBe("pre-validation write");
    expect(frameRole(0, 0, "payer")).toBe("pre-validation write");
    expect(frameRole(0, 0, undefined)).toBe("deploy or post-operation");
  });

  const tx = {
    chainId: "0x539",
    nonce: "0x1",
    sender: "0x1111111111111111111111111111111111111111",
    frames: [
      { mode: 1, flags: 3, target: null, limits: { execution: "0x7530", state: "0x0" }, value: "0x0", data: "0x" },
      {
        mode: 2,
        flags: 4,
        target: "0x2222222222222222222222222222222222222222",
        limits: { execution: "0xc350", state: "0x10" },
        value: "0x1",
        data: "0xa9059cbb",
      },
    ],
    fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x2", maxFeePerBlobGas: "0x0" },
  };

  it("parses a serialized transaction and returns null for anything else", () => {
    expect(parseFrameTx(tx)?.frames).toHaveLength(2);
    expect(parseFrameTx({ frames: "no" })).toBeNull();
    expect(parseFrameTx(null)).toBeNull();
  });

  it("parses a current node's transaction, with EIP-8250 keyed nonces and EIP-8272 roots instead of `nonce`", () => {
    const { nonce: _nonce, ...rest } = tx;
    const keyed = {
      ...rest,
      nonceKeys: ["0xabc"],
      nonceSeq: "0x0",
      recentRootReferences: [{ sourceId: `0x${"a".repeat(64)}`, slot: "0x40", root: `0x${"b".repeat(64)}` }],
    };
    const parsed = parseFrameTx(keyed);
    expect(parsed?.frames).toHaveLength(2);
    expect(parsed?.nonceKeys).toEqual(["0xabc"]);
    expect(parsed?.recentRootReferences).toHaveLength(1);
  });

  it("maps frame indexes to the validator's entities", () => {
    const checks: Check[] = [
      { rule: "prefix", verdict: "pass" },
      { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "pass" },
      { rule: "OP-011", frameIndex: 1, entity: "factory", verdict: "pass" },
    ];
    expect([...entitiesByFrame(checks)]).toEqual([
      [0, "payer"],
      [1, "factory"],
    ]);
  });

  it("describes each frame with role, scope, gas, value and data size", () => {
    const parsed = parseFrameTx(tx)!;
    const views = describeFrames(parsed.frames, [{ rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "pass" }]);
    expect(views[0]).toMatchObject({
      index: 0,
      modeName: "verify",
      role: "self-verification",
      scope: "execution and payment",
      atomic: false,
      entity: "payer",
      target: null,
      executionGas: 30000n,
      stateGas: 0n,
      dataBytes: 0,
    });
    expect(views[1]).toMatchObject({
      modeName: "sender",
      role: "user operation",
      atomic: true,
      entity: undefined,
      executionGas: 50000n,
      stateGas: 16n,
      value: 1n,
      dataBytes: 4,
    });
  });

  it("attaches a per-frame run status when given, aligned by index, and leaves it undefined otherwise", () => {
    const parsed = parseFrameTx(tx)!;
    const withStatuses = describeFrames(parsed.frames, [], ["success", "reverted"]);
    expect(withStatuses.map((v) => v.status)).toEqual(["success", "reverted"]);

    const withoutStatuses = describeFrames(parsed.frames, []);
    expect(withoutStatuses.map((v) => v.status)).toEqual([undefined, undefined]);
  });
});

describe("groupChecks", () => {
  // Deliberately out of order, as the node does not promise an order.
  const checks: Check[] = [
    { rule: "storage", frameIndex: 1, entity: "factory", verdict: "pass" },
    { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "payer uses banned opcode: DIFFICULTY" },
    { rule: "signature", verdict: "pass" },
    { rule: "prefix", verdict: "pass" },
    { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
    { rule: "storage", frameIndex: 0, entity: "payer", verdict: "fail", detail: "unstaked payer accessed slot" },
    { rule: "mempool", verdict: "skipped" },
    { rule: "some-future-rule", verdict: "pass" },
  ];

  it("orders transaction-level rules by the protocol's rule order, unknown ids last", () => {
    expect(groupChecks(checks).global.map((c) => c.rule)).toEqual([
      "prefix",
      "signature",
      "mempool",
      "some-future-rule",
    ]);
  });

  it("groups per-frame results by frame and orders rules within a frame", () => {
    const { entities } = groupChecks(checks);
    expect(entities.map((g) => [g.frameIndex, g.entity])).toEqual([
      [0, "payer"],
      [1, "factory"],
    ]);
    expect(entities[0]?.checks.map((c) => c.rule)).toEqual(["trace-alignment", "OP-011", "storage"]);
  });

  it("reports the verdict and every failure in display order", () => {
    const grouped = groupChecks(checks);
    expect(grouped.verdict).toBe("fail");
    expect(grouped.failing.map((c) => c.rule)).toEqual(["OP-011", "storage"]);
  });

  it("separates per-entity rules that were never evaluated", () => {
    const grouped = groupChecks([
      { rule: "prefix", verdict: "fail", detail: "not recognized" },
      { rule: "signature", verdict: "skipped" },
      { rule: "storage", verdict: "skipped" },
      { rule: "OP-011", verdict: "skipped" },
    ]);
    expect(grouped.global.map((c) => c.rule)).toEqual(["prefix", "signature"]);
    expect(grouped.notEvaluated.map((c) => c.rule)).toEqual(["OP-011", "storage"]);
    expect(grouped.entities).toEqual([]);
  });

  it("keeps an entity-less, frameless failure of a per-entity rule visible and failing", () => {
    const grouped = groupChecks([
      { rule: "prefix", verdict: "pass" },
      { rule: "OP-011", verdict: "fail", detail: "banned opcode" },
      { rule: "storage", verdict: "pass" },
      { rule: "create", verdict: "skipped" },
    ]);
    expect(grouped.verdict).toBe("fail");
    expect(grouped.failing.map((c) => c.rule)).toEqual(["OP-011"]);
    expect(grouped.global.map((c) => c.rule).sort()).toEqual(["OP-011", "prefix", "storage"]);
    expect(grouped.notEvaluated.map((c) => c.rule)).toEqual(["create"]);
    expect(failureSummary([{ rule: "OP-011", verdict: "fail" }])).toBe("Banned opcodes");
  });

  it("returns pass for a clean report and incomplete when rules were skipped without a failure", () => {
    expect(groupChecks([{ rule: "prefix", verdict: "pass" }]).verdict).toBe("pass");
    expect(groupChecks([{ rule: "prefix", verdict: "pass" }, { rule: "mempool", verdict: "skipped" }]).verdict).toBe(
      "incomplete",
    );
    expect(groupChecks([]).verdict).toBe("pass");
  });

  it("keeps an entity without a frame index in its own group rather than dropping it", () => {
    const grouped = groupChecks([{ rule: "OP-011", entity: "sender", verdict: "pass" }]);
    expect(grouped.entities).toEqual([
      { frameIndex: -1, entity: "sender", checks: [{ rule: "OP-011", entity: "sender", verdict: "pass" }] },
    ]);
  });

  it("does not mutate its input", () => {
    const input: Check[] = [
      { rule: "signature", verdict: "pass" },
      { rule: "prefix", verdict: "pass" },
    ];
    const copy = structuredClone(input);
    groupChecks(input);
    expect(input).toEqual(copy);
  });
});

describe("failureSummary and ruleInfo", () => {
  it("names the first failure with its entity and frame", () => {
    expect(
      failureSummary([
        { rule: "prefix", verdict: "pass" },
        { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail" },
      ]),
    ).toBe("Banned opcodes (payer, frame 0)");
    expect(failureSummary([{ rule: "prefix", verdict: "fail" }])).toBe("Validation prefix");
    expect(failureSummary([{ rule: "prefix", verdict: "pass" }])).toBeNull();
  });

  it("failureDetail prefers the failing check's own detail text, falling back to the rule label", () => {
    expect(
      failureDetail([{ rule: "simulation", verdict: "fail", detail: "banned opcode: GASPRICE (0x3a)" }]),
    ).toBe("banned opcode: GASPRICE (0x3a)");
    expect(failureDetail([{ rule: "prefix", verdict: "fail" }])).toBe("Validation prefix");
    expect(failureDetail([{ rule: "prefix", verdict: "pass" }])).toBeNull();
  });

  it("knows every rule id the protocol defines and falls back for unknown ones", () => {
    for (const rule of Object.values(EXPLORER_RULES)) {
      expect(ruleInfo(rule).label).not.toBe(rule);
      expect(ruleInfo(rule).explain.length).toBeGreaterThan(10);
    }
    expect(ruleInfo("trace-alignment").explain).toMatch(/once for the whole transaction/);
    expect(ruleInfo("trace-alignment").explain).toMatch(/each entity/);
    expect(ruleInfo("brand-new")).toMatchObject({ label: "brand-new" });
  });
});

describe("EIP-8250 / EIP-8272 formatting", () => {
  it("shows a linear nonce as a plain number", () => {
    expect(formatNonce("0x2a")).toBe("42");
    expect(formatNonce("0x2a", ["0x0"])).toBe("42");
    expect(formatNonce("0x2a", [])).toBe("42");
  });

  it("shows a keyed nonce as a sequence on its keys, shortening hash-sized keys", () => {
    expect(formatNonce("0x0", ["0x5"])).toBe("seq 0 on key 0x5");
    expect(formatNonce("0x1", [`0x${"1".repeat(64)}`, "0x7"])).toBe("seq 1 on keys 0x1111…1111, 0x7");
  });

  it("describes a recent-root reference on one line", () => {
    expect(
      formatRecentRoot({ sourceId: `0x${"a".repeat(64)}`, slot: "0x3fc67", root: `0x${"b".repeat(64)}` })
    ).toBe("slot 261,223: root 0xbbbb…bbbb from source 0xaaaa…aaaa");
  });
});
