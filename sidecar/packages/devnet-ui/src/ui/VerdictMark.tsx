import clsx from "clsx";

export type Verdict = "pass" | "fail" | "skipped";

const LABEL: Record<Verdict, string> = {
  pass: "Passed",
  fail: "Failed",
  skipped: "Not evaluated",
};

export function verdictLabel(verdict: Verdict): string {
  return LABEL[verdict];
}

/**
 * A rule's verdict as a shape as well as a color: a filled circle with a tick
 * (passed), a filled diamond with a cross (failed), a dashed ring (not evaluated).
 */
export function VerdictMark({
  verdict,
  size = 14,
  title,
}: {
  verdict: Verdict;
  size?: number;
  /** Overrides the accessible name, for example "Banned opcodes: failed". */
  title?: string;
}) {
  const label = title ?? LABEL[verdict];
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={clsx(
        "shrink-0",
        verdict === "pass" && "text-pass",
        verdict === "fail" && "text-fail",
        verdict === "skipped" && "text-ink-soft",
      )}
    >
      <title>{label}</title>
      {verdict === "pass" && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M4.6 8.3l2.2 2.2 4.6-4.9"
            fill="none"
            stroke="var(--paper)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {verdict === "fail" && (
        <>
          <path d="M8 0.8 15.2 8 8 15.2 0.8 8Z" fill="currentColor" />
          <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="var(--paper)" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {verdict === "skipped" && (
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.6 2.4" />
      )}
    </svg>
  );
}
