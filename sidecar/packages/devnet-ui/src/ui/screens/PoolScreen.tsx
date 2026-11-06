import { useState } from "react";
import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { useNow, usePool } from "../../data/hooks";
import { useFresh } from "../../data/live";
import type { Instance } from "../../instances/store";
import {
  describeSource,
  formatAgo,
  formatClock,
  formatGwei,
  formatNonce,
  shortAddress,
  shortHash,
  sourcePeer,
} from "../../logic/format";
import type { TransactionSummary } from "../../protocol/schemas";
import { HelpTip } from "../HelpTip";
import { QueryErrorBanner } from "../QueryErrorBanner";
import { FrameStrip, framesOfCount } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";

const STATUS_FILTERS = ["all", "New", "Pending", "Submitted", "OnChain", "Finalized", "Cancelled", "Reverted"] as const;

function PoolRow({ tx, instance, now }: { tx: TransactionSummary; instance: Instance; now: number }) {
  const fresh = useFresh(tx.txHash);
  return (
    <tr className={clsx("border-b border-line align-middle", fresh && "row-fresh")}>
      <td className="py-2.5 pr-4">
        <Link
          to="/tx/$hash"
          params={{ hash: tx.txHash }}
          search={{ node: instance.url }}
          className="font-mono text-[0.8125rem] underline-offset-4 hover:underline"
          title={tx.txHash}
        >
          {shortHash(tx.txHash, 8, 6)}
        </Link>
      </td>
      <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={tx.sender}>
        {shortAddress(tx.sender)}
      </td>
      <td className="tabular py-2.5 pr-4">{formatNonce(tx.nonce, tx.nonceKeys)}</td>
      <td className="py-2.5 pr-4">
        <StatusBadge status={tx.status} />
      </td>
      <td className="py-2.5 pr-4">
        <FrameStrip frames={framesOfCount(tx.frames)} />
      </td>
      <td className="tabular py-2.5 pr-4">{formatGwei(tx.maxFeePerGas)}</td>
      <td className="py-2.5 pr-4">
        {tx.source === undefined ? (
          <span
            className="text-ink-soft"
            title="This node has no record of how it first saw this transaction (it restarted since, or the record was evicted)."
          >
            –
          </span>
        ) : (
          <span title={sourcePeer(tx.source) ?? undefined}>{describeSource(tx.source)}</span>
        )}
      </td>
      <td
        className="tabular py-2.5 text-ink-soft"
        title={tx.submittedTime ? formatClock(tx.submittedTime) : undefined}
      >
        {tx.submittedTime ? formatAgo(tx.submittedTime, now) : "–"}
      </td>
    </tr>
  );
}

/** What is in this node's mempool right now, newest first, updating as transactions arrive. */
export function PoolScreen({ instance }: { instance: Instance }) {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const pool = usePool(instance.url, status);
  const now = useNow();
  const items = pool.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="pool-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 id="pool-title" className="text-2xl">
          Pool
        </h2>
        <label className="flex items-center gap-2 text-[0.875rem] text-ink-soft">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}
            className="border border-line bg-raised px-2 py-1 text-ink"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s === "OnChain" ? "On chain" : s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {pool.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={pool.error} url={instance.url} onRetry={() => void pool.refetch()} />
        </div>
      )}
      {pool.data === undefined ? (
        pool.isPending ? (
          <p role="status" className="py-8 text-ink-soft">
            Loading the pool…
          </p>
        ) : null
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">{status === "all" ? "The pool is empty." : `No ${status} transactions.`}</p>
          <p className="max-w-[60ch] text-ink-soft">
            Transactions appear here as this node admits them. Send one with eth_sendFrameTransaction, or open
            Activity to see the ones it turned away.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Transaction</th>
                <th scope="col" className="py-2 pr-4 font-normal">Sender</th>
                <th scope="col" className="py-2 pr-4 font-normal">Nonce</th>
                <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                <th scope="col" className="py-2 pr-4 font-normal">Frames</th>
                <th scope="col" className="py-2 pr-4 font-normal">Max fee</th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Source
                  <HelpTip label="What does source mean?">
                    How this node first heard of the transaction. Submitted by RPC: sent straight to this node. P2P
                    from a peer: relayed to this node by that peer, which is the last hop, not necessarily where it
                    was first submitted. P2P sync: fetched from that peer while catching up. A dash means the node
                    no longer has that record.
                  </HelpTip>
                </th>
                <th scope="col" className="py-2 font-normal">Seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tx) => (
                <PoolRow key={tx.txHash} tx={tx} instance={instance} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pool.hasNextPage && (
        <button
          type="button"
          onClick={() => void pool.fetchNextPage()}
          disabled={pool.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {pool.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
