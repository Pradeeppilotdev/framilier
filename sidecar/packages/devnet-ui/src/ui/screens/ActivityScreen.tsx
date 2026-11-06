import { useState } from "react";
import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { useActivity, useNow } from "../../data/hooks";
import { useFresh } from "../../data/live";
import type { Instance } from "../../instances/store";
import { describeSource, formatAgo, formatClock, shortAddress, shortHash } from "../../logic/format";
import { describeFrames } from "../../logic/frames";
import { failureDetail } from "../../logic/rules";
import type { Admission } from "../../protocol/schemas";
import { QueryErrorBanner } from "../QueryErrorBanner";
import { FrameStrip } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";

type Outcome = "all" | "accepted" | "rejected" | "included" | "replaced" | "dropped";
const OUTCOMES: Outcome[] = ["all", "rejected", "accepted", "included", "replaced", "dropped"];

export function whatHappened(admission: Admission): string {
  if (admission.outcome === "rejected") return failureDetail(admission.checks) ?? "Rejected";
  if (admission.outcome === "replaced") return "Replaced by a newer transaction";
  if (admission.outcome === "dropped") return "Dropped from the mempool";
  if (admission.outcome === "included") {
    return admission.includer ? `Included by ${shortAddress(admission.includer)}` : "Included";
  }
  return describeSource(admission.source);
}

function ActivityRow({ admission, instance, now }: { admission: Admission; instance: Instance; now: number }) {
  const fresh = useFresh(admission.txHash);
  const globalFailure = admission.checks.find((c) => c.verdict === "fail" && c.frameIndex === undefined);
  return (
    <tr className={clsx("border-b border-line align-middle", fresh && "row-fresh")}>
      <td className="tabular py-2.5 pr-4 whitespace-nowrap text-ink-soft" title={formatAgo(admission.at, now)}>
        {formatClock(admission.at)}
      </td>
      <td className="py-2.5 pr-4">
        <StatusBadge status={admission.outcome} />
      </td>
      <td className="py-2.5 pr-4">
        <Link
          to="/tx/$hash"
          params={{ hash: admission.txHash }}
          search={{ node: instance.url }}
          className="font-mono text-[0.8125rem] underline-offset-4 hover:underline"
          title={admission.txHash}
        >
          {shortHash(admission.txHash, 8, 6)}
        </Link>
      </td>
      <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={admission.sender}>
        {shortAddress(admission.sender)}
      </td>
      <td className="py-2.5 pr-4">
        <FrameStrip
          frames={describeFrames(admission.frames, admission.checks, admission.frameStatuses)}
          checks={admission.checks}
          globalFailure={globalFailure}
        />
      </td>
      <td
        className={clsx(
          "max-w-[28rem] truncate py-2.5",
          admission.outcome === "rejected" ? "text-fail" : "text-ink-soft",
        )}
        title={whatHappened(admission)}
      >
        {whatHappened(admission)}
      </td>
    </tr>
  );
}

/** Everything this node was asked to admit, newest first, including what it turned away and why. */
export function ActivityScreen({ instance }: { instance: Instance }) {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const activity = useActivity(instance.url, outcome);
  const now = useNow();
  const items = activity.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="activity-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 id="activity-title" className="text-2xl">
          Activity
        </h2>
        <label className="flex items-center gap-2 text-[0.875rem] text-ink-soft">
          Outcome
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
            className="border border-line bg-raised px-2 py-1 text-ink"
          >
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o === "all" ? "All outcomes" : o[0]?.toUpperCase() + o.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {activity.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={activity.error} url={instance.url} onRetry={() => void activity.refetch()} />
        </div>
      )}
      {activity.data === undefined ? (
        activity.isPending ? (
          <p role="status" className="py-8 text-ink-soft">
            Loading activity…
          </p>
        ) : null
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">Nothing here yet.</p>
          <p className="max-w-[60ch] text-ink-soft">
            This node keeps its history in memory, so a restart clears it. New submissions show up as they arrive.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Time</th>
                <th scope="col" className="py-2 pr-4 font-normal">Outcome</th>
                <th scope="col" className="py-2 pr-4 font-normal">Transaction</th>
                <th scope="col" className="py-2 pr-4 font-normal">Sender</th>
                <th scope="col" className="py-2 pr-4 font-normal">Frames</th>
                <th scope="col" className="py-2 font-normal">What happened</th>
              </tr>
            </thead>
            <tbody>
              {items.map((admission) => (
                <ActivityRow key={admission.id} admission={admission} instance={instance} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activity.hasNextPage && (
        <button
          type="button"
          onClick={() => void activity.fetchNextPage()}
          disabled={activity.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {activity.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
