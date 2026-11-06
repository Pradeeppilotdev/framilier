import type { ReactNode } from "react";
import clsx from "clsx";

const TONE = {
  error: "border-fail",
  warn: "border-warn",
  info: "border-accent",
} as const;

/** A message with a next step. Errors say what happened and what to try; they never apologize. */
export function Banner({
  tone,
  title,
  hint,
  action,
}: {
  tone: keyof typeof TONE;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx("flex flex-wrap items-start gap-x-6 gap-y-2 border-l-4 bg-raised px-4 py-3", TONE[tone])}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {hint && <p className="max-w-[68ch] text-ink-soft">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
