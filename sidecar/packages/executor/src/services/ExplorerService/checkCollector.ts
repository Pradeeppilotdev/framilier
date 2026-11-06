import {
  ENTITY_RULE_ORDER,
  EntityRole,
  ExplorerRuleId,
  GLOBAL_RULE_ORDER,
  RuleCheck,
} from "@skandha/types/lib/explorer/index.js";
import { FrameSimulationReceipt } from "@skandha/types/lib/executor/validation/frameTxSimulation.js";

export interface CheckContext {
  frameIndex?: number;
  entity?: EntityRole;
}

/**
 * Accumulates the per-rule verdicts of one admission attempt. Validation code
 * keeps throwing `RpcError` exactly as before; it also reports each rule here
 * so the explorer can show a rule-by-rule report.
 */
export class CheckCollector {
  private checks: RuleCheck[] = [];
  private frameReceipts?: FrameSimulationReceipt[];

  pass(rule: ExplorerRuleId, ctx: CheckContext = {}, detail?: string): void {
    this.checks.push({
      rule,
      ...ctx,
      verdict: "pass",
      ...(detail ? { detail } : {}),
    });
  }

  fail(rule: ExplorerRuleId, detail: string, ctx: CheckContext = {}): void {
    this.checks.push({ rule, ...ctx, verdict: "fail", detail });
  }

  /** Records `err` as a failure of `rule` and returns it: `throw collector.failed(...)`. */
  failed<E extends Error>(
    rule: ExplorerRuleId,
    err: E,
    ctx: CheckContext = {}
  ): E {
    this.fail(rule, err.message, ctx);
    return err;
  }

  hasFailure(): boolean {
    return this.checks.some((c) => c.verdict === "fail");
  }

  /**
   * Records the traced simulation's per-frame receipts, index-aligned with
   * `tx.frames`. Set as soon as the trace is known (before `validate()`
   * runs its rule checks), so it survives a later `fail()`/thrown rejection.
   */
  setFrameReceipts(receipts: FrameSimulationReceipt[]): void {
    this.frameReceipts = receipts;
  }

  getFrameReceipts(): FrameSimulationReceipt[] | undefined {
    return this.frameReceipts;
  }

  /** Turns one entity's failures into passes, keeping the original message as a note. */
  waive(ctx: CheckContext, reason: string): void {
    for (const c of this.checks) {
      if (
        c.verdict === "fail" &&
        c.frameIndex === ctx.frameIndex &&
        c.entity === ctx.entity
      ) {
        c.verdict = "pass";
        c.detail = `waived (${reason}): ${c.detail ?? ""}`.trim();
      }
    }
  }

  /**
   * Recorded checks, plus `skipped` entries for rules that never ran because
   * an earlier rule failed. Returns copies.
   */
  toChecks(): RuleCheck[] {
    const out = this.checks.map((c) => ({ ...c }));
    if (!this.hasFailure()) return out;

    for (const rule of GLOBAL_RULE_ORDER) {
      const seen = out.some((c) => c.rule === rule && c.entity === undefined);
      if (!seen) out.push({ rule, verdict: "skipped" });
    }
    const anyEntityEvaluated = out.some((c) => c.entity !== undefined);
    if (!anyEntityEvaluated) {
      for (const rule of ENTITY_RULE_ORDER) {
        out.push({ rule, verdict: "skipped" });
      }
    }
    return out;
  }
}
