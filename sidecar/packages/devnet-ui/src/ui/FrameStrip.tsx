import clsx from "clsx";
import type { Check } from "../protocol/schemas";
import { modeName, type FrameRunStatus } from "../logic/frames";
import { ruleInfo } from "../logic/rules";
import { VerdictMark, verdictLabel, type Verdict } from "./VerdictMark";

export interface StripFrame {
  index: number;
  /** 0 default, 1 verify, 2 sender. Unknown when only a frame count is known. */
  mode?: number;
  role?: string;
  entity?: string;
  atomic?: boolean;
  /** The traced simulation's outcome for this frame; absent when unknown. */
  status?: FrameRunStatus;
}

/**
 * The overall verdict for a frame: any check failure fails it; all skipped is
 * skipped; a pass needs at least one check. With no checks at all (a frame no
 * rule evaluated, e.g. a body frame past the validation prefix), falls back
 * to the simulation's run status: `reverted` fails it, `success`/`not-run`
 * stay undefined (a plain, un-flagged block).
 */
export function frameVerdict(checks: Check[], status?: FrameRunStatus): Verdict | undefined {
  if (checks.length > 0) {
    if (checks.some((c) => c.verdict === "fail")) return "fail";
    if (checks.every((c) => c.verdict === "skipped")) return "skipped";
    return "pass";
  }
  return status === "reverted" ? "fail" : undefined;
}

/** A bare strip of `count` frames whose modes are not known. */
export function framesOfCount(count: number): StripFrame[] {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

/**
 * How a frame block looks. Mode is the shape: verify is solid, sender is an
 * outline, default is a dashed outline. A failed frame turns red in all three.
 */
function blockClass(mode: number | undefined, verdict: Verdict | undefined): string {
  const failed = verdict === "fail";
  if (mode === 1) {
    if (failed) return "bg-fail text-paper";
    return verdict === "skipped" ? "bg-rail text-ink-soft" : "bg-ink text-paper";
  }
  if (mode === 2) return clsx("border-2 bg-transparent", failed ? "border-fail text-fail" : "border-ink text-ink");
  if (mode === 0) {
    return clsx("border-2 border-dashed bg-transparent", failed ? "border-fail text-fail" : "border-ink text-ink");
  }
  return failed ? "border-2 border-fail text-fail" : "border border-line bg-rail text-ink-soft";
}

const GLYPH: Record<Verdict, string> = { pass: "✓", fail: "✕", skipped: "–" };

/**
 * A frame transaction drawn as its frames, left to right. The small size fits a
 * table row; the large size adds each frame's role and the verdict of every
 * rule that checked it. `globalFailure` marks a failure before any frame was
 * examined, such as an unrecognized prefix.
 */
export function FrameStrip({
  frames,
  checks = [],
  size = "sm",
  globalFailure,
}: {
  frames: StripFrame[];
  checks?: Check[];
  size?: "sm" | "lg";
  globalFailure?: Check;
}) {
  const checksOf = (index: number) => checks.filter((c) => c.frameIndex === index);

  if (size === "sm") {
    return (
      <ol aria-label="Frames" className="m-0 flex list-none items-center gap-[3px] p-0">
        {frames.map((frame) => {
          const own = checksOf(frame.index);
          const verdict = frameVerdict(own, frame.status);
          const notRun = frame.status === "not-run";
          // No rule evaluated this frame, but the trace says it reverted:
          // say so directly rather than implying a rule failed it.
          const statusWord = own.length === 0 && frame.status === "reverted" ? "reverted" : undefined;
          const suffix = statusWord ? `: ${statusWord}` : verdict ? `: ${verdictLabel(verdict).toLowerCase()}` : "";
          const label = `Frame ${frame.index}${frame.role ? `, ${frame.role}` : ""}${suffix}${notRun ? " (not simulated)" : ""}`;
          return (
            <li
              key={frame.index}
              title={label}
              aria-label={label}
              className={clsx(
                "grid size-[18px] place-items-center rounded-[3px] text-[11px] leading-none font-bold",
                blockClass(frame.mode, verdict),
                notRun && "opacity-40",
              )}
            >
              <span aria-hidden>{verdict ? GLYPH[verdict] : ""}</span>
            </li>
          );
        })}
        {globalFailure && (
          <li
            title={`${ruleInfo(globalFailure.rule).label}: failed`}
            aria-label={`${ruleInfo(globalFailure.rule).label}: failed`}
            className="ml-1 grid size-[18px] place-items-center rounded-[3px] bg-fail text-[11px] leading-none font-bold text-paper"
          >
            <span aria-hidden>!</span>
          </li>
        )}
      </ol>
    );
  }

  return (
    <ol aria-label="Frames" className="m-0 flex list-none flex-wrap items-start gap-3 p-0">
      {frames.map((frame) => {
        const own = checksOf(frame.index);
        const verdict = frameVerdict(own, frame.status);
        const notRun = frame.status === "not-run";
        // No rule evaluated this frame, but the trace says it reverted: say
        // so directly rather than implying a rule failed it.
        const statusCaption = own.length === 0 && frame.status === "reverted" ? "Reverted" : undefined;
        return (
          <li key={frame.index} className={clsx("w-40", notRun && "opacity-40")}>
            <div className={clsx("rounded-[3px] px-3 py-2 leading-tight", blockClass(frame.mode, verdict))}>
              <p className="tabular font-display text-lg font-semibold">Frame {frame.index}</p>
              {(frame.role ?? (frame.mode !== undefined ? modeName(frame.mode) : undefined)) && (
                <p className="text-[0.8125rem]">{frame.role ?? modeName(frame.mode as number)}</p>
              )}
              {frame.entity && <p className="text-[0.8125rem] opacity-80">{frame.entity}</p>}
              {frame.atomic && <p className="text-[0.8125rem] opacity-80">atomic with the next frame</p>}
              {notRun && <p className="text-[0.8125rem]">Not simulated</p>}
              {statusCaption && <p className="text-[0.8125rem]">{statusCaption}</p>}
            </div>
            {own.length > 0 && (
              <ul aria-label={`Checks for frame ${frame.index}`} className="m-0 mt-2 flex list-none flex-wrap gap-1 p-0">
                {own.map((check, i) => (
                  <li key={`${check.rule}-${i}`}>
                    <VerdictMark
                      verdict={check.verdict}
                      title={`${ruleInfo(check.rule).label}: ${verdictLabel(check.verdict).toLowerCase()}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {globalFailure && (
        <li className="w-40">
          <div className="rounded-[3px] border-2 border-fail px-3 py-2 leading-tight text-fail">
            <p className="font-display text-lg font-semibold">Before the frames</p>
            <p className="text-[0.8125rem]">{ruleInfo(globalFailure.rule).label}</p>
          </div>
        </li>
      )}
    </ol>
  );
}
