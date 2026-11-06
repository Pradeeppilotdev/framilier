import type { Check } from "../../protocol/schemas";
import { failureSummary, groupChecks, ruleInfo } from "../../logic/rules";
import { VerdictMark, verdictLabel } from "../VerdictMark";

function CheckItem({ check }: { check: Check }) {
  const info = ruleInfo(check.rule);
  return (
    <li className="py-1.5" title={info.explain}>
      <div className="flex items-baseline gap-2.5">
        <span className="translate-y-[3px]">
          <VerdictMark verdict={check.verdict} title={`${info.label}: ${verdictLabel(check.verdict).toLowerCase()}`} />
        </span>
        <span className="font-medium">{info.label}</span>
        <span className="font-mono text-[0.75rem] text-ink-soft">{check.rule}</span>
      </div>
      {check.detail && (
        <p className="max-w-[76ch] pl-[1.625rem] text-[0.875rem] break-words text-ink-soft">{check.detail}</p>
      )}
    </li>
  );
}

/**
 * The node's rule-by-rule verdict on a transaction: transaction-level rules
 * first, then each validation frame's own rules, then any rules that never ran.
 */
export function RuleChecklist({ checks }: { checks: Check[] }) {
  const grouped = groupChecks(checks);
  const summary = failureSummary(checks);

  return (
    <section aria-labelledby="report-title">
      <h2 id="report-title" className="mb-1 text-xl">
        Admission report
      </h2>
      <p className="mb-4 text-ink-soft">
        {grouped.verdict === "fail"
          ? `Turned away: ${summary}.`
          : grouped.verdict === "incomplete"
            ? "Some rules were not evaluated."
            : checks.length === 0
              ? "No checks recorded."
              : "Every rule passed."}
      </p>

      <ul aria-label="Transaction-level rules" className="m-0 list-none p-0">
        {grouped.global.map((check, i) => (
          <CheckItem key={`${check.rule}-${i}`} check={check} />
        ))}
      </ul>

      {grouped.entities.map((group) => {
        const failed = group.checks.filter((c) => c.verdict === "fail").length;
        const passed = group.checks.filter((c) => c.verdict === "pass").length;
        // A frame whose rules all passed folds away; one with a failure stays open.
        const heading = `${group.frameIndex >= 0 ? `Frame ${group.frameIndex}` : "Unplaced frame"}${
          group.entity ? `, ${group.entity}` : ""
        }`;
        return (
          <details key={`${group.frameIndex}-${group.entity ?? ""}`} open={failed > 0} className="mt-5">
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4">
              <h3 className="inline text-lg">{heading}</h3>
              <span className={failed > 0 ? "text-fail" : "text-ink-soft"}>
                {failed > 0
                  ? `${failed} failed, ${passed} passed`
                  : `${passed} of ${group.checks.length} passed`}
              </span>
            </summary>
            <ul
              aria-label={group.frameIndex >= 0 ? `Rules for frame ${group.frameIndex}` : heading}
              className="m-0 mt-1 list-none border-l border-line pl-4"
            >
              {group.checks.map((check, i) => (
                <CheckItem key={`${check.rule}-${i}`} check={check} />
              ))}
            </ul>
          </details>
        );
      })}

      {grouped.notEvaluated.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1 text-lg">Frame rules not evaluated</h3>
          <p className="mb-1 max-w-[62ch] text-[0.875rem] text-ink-soft">
            These run after the transaction-level rules, so an earlier failure stopped them.
          </p>
          <ul aria-label="Rules that were not evaluated" className="m-0 list-none p-0">
            {grouped.notEvaluated.map((check, i) => (
              <CheckItem key={`${check.rule}-${i}`} check={check} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
