import { Link } from "@tanstack/react-router";
import { useAcrossInstances } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { describeSource, formatClock, formatDelta } from "../../logic/format";
import type { TransactionDetail } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { StatusBadge } from "../StatusBadge";

interface Sighting {
  instance: Instance;
  state: "asking" | "seen" | "missing" | "failed";
  detail?: TransactionDetail;
  firstSeen?: number;
  problem?: string;
}

/** When a node first saw the transaction: its admission time, else its earliest event. */
function firstSeenOf(detail: TransactionDetail): number | undefined {
  return detail.admission?.at ?? detail.events[0]?.at;
}

/**
 * Asks every listed instance about this transaction and lines up who saw it and
 * when, which is how you see it travel across the network.
 */
export function AcrossInstances({ instances, hash, current }: { instances: Instance[]; hash: string; current: string }) {
  const results = useAcrossInstances(
    instances.map((i) => i.url),
    hash,
  );

  const sightings: Sighting[] = instances.map((instance, i) => {
    const result = results[i];
    if (!result || result.isPending) return { instance, state: "asking" };
    if (result.isError) {
      return { instance, state: "failed", problem: describeError(result.error, instance.url).title };
    }
    if (result.data === null || result.data === undefined) return { instance, state: "missing" };
    return { instance, state: "seen", detail: result.data, firstSeen: firstSeenOf(result.data) };
  });

  const seenTimes = sightings.flatMap((s) => (s.state === "seen" && s.firstSeen !== undefined ? [s.firstSeen] : []));
  const earliest = seenTimes.length > 0 ? Math.min(...seenTimes) : undefined;
  const order = (s: Sighting) => (s.state === "seen" ? (s.firstSeen ?? Infinity) : Infinity);
  sightings.sort((a, b) => order(a) - order(b));

  return (
    <section aria-labelledby="across-title">
      <h2 id="across-title" className="mb-1 text-xl">
        Across instances
      </h2>
      <p className="mb-3 max-w-[64ch] text-ink-soft">
        Every instance in your list, asked about this transaction. Times are when each node first saw it.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left">
          <thead>
            <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-normal">Instance</th>
              <th scope="col" className="py-2 pr-4 font-normal">First seen</th>
              <th scope="col" className="py-2 pr-4 font-normal">Behind the first</th>
              <th scope="col" className="py-2 pr-4 font-normal">How it arrived</th>
              <th scope="col" className="py-2 font-normal">Now</th>
            </tr>
          </thead>
          <tbody>
            {sightings.map((s) => (
              <tr key={s.instance.url} className="border-b border-line align-middle">
                <td className="py-2.5 pr-4">
                  {s.instance.url === current ? (
                    <span className="font-medium">{s.instance.name}</span>
                  ) : (
                    <Link
                      to="/tx/$hash"
                      params={{ hash }}
                      search={{ node: s.instance.url }}
                      className="font-medium underline underline-offset-4"
                    >
                      {s.instance.name}
                    </Link>
                  )}
                </td>
                {s.state === "seen" ? (
                  <>
                    <td className="tabular py-2.5 pr-4">{s.firstSeen !== undefined ? formatClock(s.firstSeen) : "–"}</td>
                    <td className="tabular py-2.5 pr-4">
                      {s.firstSeen !== undefined && earliest !== undefined ? formatDelta(s.firstSeen - earliest) : "–"}
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.detail?.admission ? describeSource(s.detail.admission.source) : "–"}
                    </td>
                    <td className="py-2.5">
                      {s.detail?.entry ? (
                        <StatusBadge status={s.detail.entry.status} />
                      ) : s.detail?.admission ? (
                        <StatusBadge status={s.detail.admission.outcome} />
                      ) : (
                        "–"
                      )}
                    </td>
                  </>
                ) : (
                  <td colSpan={4} className="py-2.5 text-ink-soft">
                    {s.state === "asking" && "Asking…"}
                    {s.state === "missing" && "Has not seen it"}
                    {s.state === "failed" && s.problem}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
