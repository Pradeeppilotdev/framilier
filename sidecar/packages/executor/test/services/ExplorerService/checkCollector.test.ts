import { describe, it, expect } from "vitest";
import { CheckCollector } from "../../../src/services/ExplorerService/checkCollector.js";
import { EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";

describe("CheckCollector", () => {
  it("records pass and fail checks with their context", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    c.fail(EXPLORER_RULES.BANNED_OPCODE, "payer uses banned opcode: DIFFICULTY", {
      frameIndex: 0,
      entity: "payer",
    });
    expect(c.toChecks()).toEqual(
      expect.arrayContaining([
        { rule: "prefix", verdict: "pass" },
        {
          rule: "OP-011",
          verdict: "fail",
          detail: "payer uses banned opcode: DIFFICULTY",
          frameIndex: 0,
          entity: "payer",
        },
      ])
    );
  });

  it("failed() records the failure and returns the same error instance", () => {
    const c = new CheckCollector();
    const err = new Error("boom");
    expect(c.failed(EXPLORER_RULES.SIGNATURE, err)).toBe(err);
    expect(c.hasFailure()).toBe(true);
    expect(c.toChecks().find((x) => x.rule === "signature")).toMatchObject({
      verdict: "fail",
      detail: "boom",
    });
  });

  it("marks global rules that never ran as skipped after a fatal failure", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    c.fail(EXPLORER_RULES.STRUCTURE, "bad structure");
    const checks = c.toChecks();
    expect(checks.find((x) => x.rule === "signature")).toEqual({
      rule: "signature",
      verdict: "skipped",
    });
    expect(checks.find((x) => x.rule === "mempool")).toMatchObject({
      verdict: "skipped",
    });
    // no entity was reached, so each per-entity rule is listed once, unscoped
    expect(
      checks.filter((x) => x.rule === "OP-011" && x.verdict === "skipped")
    ).toHaveLength(1);
  });

  it("adds no skipped checks when nothing failed", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    expect(c.toChecks()).toEqual([{ rule: "prefix", verdict: "pass" }]);
  });

  it("does not list per-entity rules as skipped when an entity was evaluated", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.OUT_OF_GAS, { frameIndex: 0, entity: "payer" });
    c.fail(EXPLORER_RULES.STORAGE, "bad slot", { frameIndex: 0, entity: "payer" });
    const skipped = c.toChecks().filter((x) => x.verdict === "skipped");
    expect(skipped.some((x) => x.rule === "OP-011")).toBe(false);
  });

  it("waive() turns one entity's failures into passes with a note, leaving others alone", () => {
    const c = new CheckCollector();
    c.fail(EXPLORER_RULES.BANNED_OPCODE, "payer uses banned opcode: GAS", {
      frameIndex: 0,
      entity: "payer",
    });
    c.fail(EXPLORER_RULES.STORAGE, "factory bad slot", {
      frameIndex: 1,
      entity: "factory",
    });
    c.waive({ frameIndex: 0, entity: "payer" }, "whitelisted entity");
    const checks = c.toChecks();
    expect(checks.find((x) => x.entity === "payer")).toMatchObject({
      verdict: "pass",
      detail: "waived (whitelisted entity): payer uses banned opcode: GAS",
    });
    expect(checks.find((x) => x.entity === "factory")?.verdict).toBe("fail");
  });

  it("toChecks() returns copies, so later waive() calls do not alter an earlier snapshot", () => {
    const c = new CheckCollector();
    c.fail(EXPLORER_RULES.STORAGE, "x", { frameIndex: 0, entity: "payer" });
    const snapshot = c.toChecks();
    c.waive({ frameIndex: 0, entity: "payer" }, "w");
    expect(snapshot.find((x) => x.rule === "storage")?.verdict).toBe("fail");
  });

  it("has no frame receipts until setFrameReceipts() is called", () => {
    const c = new CheckCollector();
    expect(c.getFrameReceipts()).toBeUndefined();
  });

  it("setFrameReceipts() records the receipts for later retrieval, surviving a later fail()", () => {
    const c = new CheckCollector();
    const receipts = [
      { status: "success" as const, gasUsed: { execution: "0x1", state: "0x0" }, logs: [] },
      { status: "reverted" as const, gasUsed: { execution: "0x2", state: "0x0" }, logs: [] },
    ];
    c.setFrameReceipts(receipts);
    c.fail(EXPLORER_RULES.BANNED_OPCODE, "sender uses banned opcode: TIMESTAMP", {
      frameIndex: 1,
      entity: "sender",
    });
    expect(c.getFrameReceipts()).toEqual(receipts);
  });
});
