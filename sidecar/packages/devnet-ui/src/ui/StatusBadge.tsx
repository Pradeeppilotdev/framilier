import clsx from "clsx";

type Tone = "pass" | "fail" | "warn" | "accent" | "mute";

const TONE: Record<string, Tone> = {
  New: "mute",
  Pending: "warn",
  Submitted: "accent",
  OnChain: "pass",
  Finalized: "pass",
  Cancelled: "mute",
  Reverted: "fail",
  accepted: "pass",
  rejected: "fail",
  replaced: "mute",
  included: "pass",
  dropped: "mute",
  ok: "pass",
  throttled: "warn",
  banned: "fail",
};

const LABEL: Record<string, string> = {
  New: "New",
  Pending: "Pending",
  Submitted: "Submitted",
  OnChain: "On chain",
  Finalized: "Finalized",
  Cancelled: "Cancelled",
  Reverted: "Reverted",
  accepted: "Accepted",
  rejected: "Rejected",
  replaced: "Replaced",
  included: "Included",
  dropped: "Dropped",
  ok: "OK",
  throttled: "Throttled",
  banned: "Banned",
};

const DOT: Record<Tone, string> = {
  pass: "bg-pass",
  fail: "bg-fail",
  warn: "bg-warn",
  accent: "bg-accent",
  mute: "border border-ink-soft",
};

/** A mempool status or an admission outcome: a small dot and the word. */
export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "mute";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={clsx("size-2 rounded-full", DOT[tone])} />
      {LABEL[status] ?? status}
    </span>
  );
}
