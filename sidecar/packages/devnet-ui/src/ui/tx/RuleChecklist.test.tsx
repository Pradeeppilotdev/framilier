import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuleChecklist } from "./RuleChecklist";
import type { Check } from "../../protocol/schemas";

const frameChecks = (frameIndex: number, entity: "sender" | "payer", failRule?: string): Check[] =>
  ["trace-alignment", "out-of-gas", "OP-011"].map((rule) => ({
    rule,
    frameIndex,
    entity,
    verdict: rule === failRule ? "fail" : "pass",
    ...(rule === failRule ? { detail: `${entity} broke ${rule}` } : {}),
  }));

describe("RuleChecklist", () => {
  it("folds a frame whose rules all passed and keeps a frame with a failure open", () => {
    const checks: Check[] = [
      { rule: "prefix", verdict: "pass" },
      ...frameChecks(0, "sender"),
      ...frameChecks(1, "payer", "OP-011"),
    ];
    const { container } = render(<RuleChecklist checks={checks} />);
    const groups = container.querySelectorAll("details");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.open).toBe(false);
    expect(groups[1]?.open).toBe(true);
    expect(screen.getByText("3 of 3 passed")).toBeTruthy();
    expect(screen.getByText("1 failed, 2 passed")).toBeTruthy();
    expect(screen.getByText("Turned away: Banned opcodes (payer, frame 1).")).toBeTruthy();
    expect(screen.getByText("payer broke OP-011")).toBeTruthy();
  });

  it("says every rule passed for a clean report", () => {
    render(<RuleChecklist checks={[{ rule: "prefix", verdict: "pass" }]} />);
    expect(screen.getByText("Every rule passed.")).toBeTruthy();
  });

  it("does not call an empty report a pass", () => {
    render(<RuleChecklist checks={[]} />);
    expect(screen.getByText("No checks recorded.")).toBeTruthy();
    expect(screen.queryByText("Every rule passed.")).toBeNull();
  });

  it("labels the list of an unplaced frame with its heading, not a frame number", () => {
    render(<RuleChecklist checks={[{ rule: "OP-011", entity: "sender", verdict: "pass" }]} />);
    expect(screen.getByRole("list", { name: "Unplaced frame, sender" })).toBeTruthy();
  });

  it("says some rules were not evaluated when nothing failed but something was skipped", () => {
    render(
      <RuleChecklist
        checks={[
          { rule: "prefix", verdict: "pass" },
          { rule: "mempool", verdict: "skipped" },
        ]}
      />,
    );
    expect(screen.getByText("Some rules were not evaluated.")).toBeTruthy();
  });

  it("lists unevaluated frame rules apart, with the reason", () => {
    render(
      <RuleChecklist
        checks={[
          { rule: "prefix", verdict: "fail", detail: "not recognized" },
          { rule: "OP-011", verdict: "skipped" },
          { rule: "storage", verdict: "skipped" },
        ]}
      />,
    );
    const section = screen.getByRole("heading", { name: "Frame rules not evaluated" }).parentElement!;
    expect(within(section).getByText(/an earlier failure stopped them/)).toBeTruthy();
    expect(within(section).getByText("Banned opcodes")).toBeTruthy();
    expect(within(section).getByText("Storage access")).toBeTruthy();
  });

  it("gives each rule a tooltip explaining what it checks", () => {
    render(<RuleChecklist checks={[{ rule: "OP-011", verdict: "pass" }]} />);
    expect(screen.getByTitle(/opcodes validation forbids/)).toBeTruthy();
  });
});
