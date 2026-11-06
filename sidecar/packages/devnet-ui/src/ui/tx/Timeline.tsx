import type { LifecycleEventData } from "../../protocol/schemas";
import { formatClock } from "../../logic/format";
import { StatusBadge } from "../StatusBadge";

const KIND_LABEL: Record<string, string> = {
  admitted: "Admitted",
  rejected: "Rejected",
  replaced: "Replaced",
  statusChanged: "Status changed",
  dropped: "Dropped",
  included: "Included in a block",
};

/** What happened to a transaction on this node, in order. */
export function Timeline({ events }: { events: LifecycleEventData[] }) {
  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="mb-3 text-xl">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="text-ink-soft">No events recorded. This node keeps its history in memory, so a restart clears it.</p>
      ) : (
        <ol className="m-0 list-none border-l border-line p-0 pl-5">
          {events.map((event) => (
            <li key={event.seq} className="relative pb-4 last:pb-0">
              <span aria-hidden className="absolute top-[0.55rem] -left-[1.625rem] size-2 rounded-full bg-ink" />
              <p className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{KIND_LABEL[event.kind] ?? event.kind}</span>
                {event.status && <StatusBadge status={event.status} />}
                <span className="tabular text-[0.8125rem] text-ink-soft">{formatClock(event.at)}</span>
              </p>
              {event.reason && (
                <p className="max-w-[76ch] text-[0.875rem] break-words text-ink-soft">{event.reason}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
