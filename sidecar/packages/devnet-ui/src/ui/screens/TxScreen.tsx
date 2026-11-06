import type { ReactNode } from "react";
import { useInstances } from "../../instances/context";
import { normalizeUrl, type Instance } from "../../instances/store";
import { useNow, useTransaction } from "../../data/hooks";
import { formatAgo, formatClock, formatGwei, formatNonce, formatRecentRoot, shortAddress, shortHash, sourcePeer } from "../../logic/format";
import { describeFrames, parseFrameTx } from "../../logic/frames";
import { describeError, hostOf } from "../../rpc/errors";
import { Banner } from "../Banner";
import { CopyText } from "../CopyText";
import { FrameStrip, type StripFrame } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";
import { AcrossInstances } from "../tx/AcrossInstances";
import { FramesTable } from "../tx/FramesTable";
import { RuleChecklist } from "../tx/RuleChecklist";
import { Timeline } from "../tx/Timeline";

/** How the node first saw the transaction: by RPC, or over p2p with the peer that relayed it. */
function SourceLine({ source }: { source: string }) {
  if (source === "rpc") return <>Submitted to this node by RPC</>;
  const peer = sourcePeer(source);
  if (peer === null) return <>{source}</>;
  return (
    <>
      {source.startsWith("sync:") ? "P2P sync, from " : "P2P, relayed by "}
      <CopyText value={peer} display={shortHash(peer, 6, 4)} />
    </>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-soft">{term}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

/**
 * One transaction as one node sees it: its frames, the rule-by-rule admission
 * report, what happened to it, and which other instances have it.
 */
export function TxScreen({ hash, nodeUrl: rawNodeUrl }: { hash: string; nodeUrl: string }) {
  const { instances, dispatch } = useInstances();
  // The list holds normalized URLs, so match and query by the normalized form when there is one.
  const normalized = normalizeUrl(rawNodeUrl);
  const nodeUrl = normalized.ok ? normalized.url : rawNodeUrl;
  const listed = instances.find((i) => i.url === nodeUrl);
  const instance: Instance = listed ?? { name: hostOf(nodeUrl), url: nodeUrl };
  const query = useTransaction(nodeUrl, hash);
  const now = useNow();
  // Compare across every listed instance plus the one being viewed, once each.
  const compared = listed ? instances : [...instances, instance];

  return (
    <div className="flex flex-col gap-8">
      {!listed && normalized.ok && (
        <Banner
          tone="info"
          title={`${instance.name} isn't in your list`}
          hint="You opened a link to another instance. Add it to keep it in the list and compare across instances."
          action={
            <button
              type="button"
              onClick={() => dispatch({ type: "add", instance: { name: hostOf(normalized.url), url: normalized.url } })}
              className="underline underline-offset-4"
            >
              Add to list
            </button>
          }
        />
      )}

      <section aria-labelledby="tx-title">
        <h2 id="tx-title" className="text-2xl">
          Transaction
        </h2>
        <p className="mt-1">
          <CopyText value={hash} className="break-all" />
        </p>
        <p className="text-[0.8125rem] text-ink-soft">As seen by {instance.name}</p>
      </section>

      {query.isPending ? (
        <p role="status" className="text-ink-soft">
          Asking {instance.name}…
        </p>
      ) : query.isError ? (
        <Banner
          tone="error"
          title={describeError(query.error, nodeUrl).title}
          hint={describeError(query.error, nodeUrl).hint}
          action={
            <button type="button" onClick={() => void query.refetch()} className="underline underline-offset-4">
              Try again
            </button>
          }
        />
      ) : query.data === null ? (
        <div>
          <p className="font-medium">{instance.name} hasn't seen this transaction.</p>
          <p className="max-w-[64ch] text-ink-soft">
            It may never have been sent here, or the node restarted since (its history is kept in memory). The
            instances below may have it.
          </p>
        </div>
      ) : (
        (() => {
          const { entry, admission, events } = query.data;
          const checks = admission?.checks ?? [];
          const parsed = entry ? parseFrameTx(entry.tx) : null;
          // The mempool entry's frames are authoritative when the transaction
          // is still in the pool; otherwise fall back to the admission
          // record's frames, which are recorded for every outcome (accepted,
          // rejected or replaced), not just what a rule report happens to
          // mention.
          const rawFrames = parsed?.frames ?? admission?.frames ?? [];
          const views = describeFrames(rawFrames, checks, admission?.frameStatuses);
          const stripFrames: StripFrame[] = views.map((v) => ({
            index: v.index,
            mode: v.mode,
            role: v.role,
            entity: v.entity,
            atomic: v.atomic,
            status: v.status,
          }));
          const globalFailure = checks.find((c) => c.verdict === "fail" && c.frameIndex === undefined);
          const status = entry?.status ?? admission?.outcome;

          return (
            <>
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-8 gap-y-1.5">
                {status && (
                  <Fact term="Status">
                    <StatusBadge status={status} />
                  </Fact>
                )}
                {admission && (
                  <>
                    <Fact term="Sender">
                      <CopyText value={admission.sender} display={shortAddress(admission.sender)} />
                    </Fact>
                    <Fact term="Nonce">{formatNonce(admission.nonce, admission.nonceKeys)}</Fact>
                    <Fact term="First seen">
                      {formatClock(admission.at)}, {formatAgo(admission.at, now)}
                    </Fact>
                    <Fact term="Source">
                      <SourceLine source={admission.source} />
                    </Fact>
                    {admission.includer && (
                      <Fact term="Includer">
                        <CopyText value={admission.includer} display={shortAddress(admission.includer)} />
                      </Fact>
                    )}
                  </>
                )}
                {entry && (
                  <>
                    <Fact term="Payer">
                      <CopyText value={entry.payer} display={shortAddress(entry.payer)} />
                    </Fact>
                    {entry.factory && (
                      <Fact term="Factory">
                        <CopyText value={entry.factory} display={shortAddress(entry.factory)} />
                      </Fact>
                    )}
                    <Fact term="Max fee">{formatGwei(entry.maxFeePerGas)}</Fact>
                    {parsed?.recentRootReferences && parsed.recentRootReferences.length > 0 && (
                      <Fact term="Recent roots">
                        {parsed.recentRootReferences.map((ref) => (
                          <div key={`${ref.sourceId}:${ref.slot}`}>{formatRecentRoot(ref)}</div>
                        ))}
                      </Fact>
                    )}
                    {entry.revertReason && (
                      <Fact term={entry.status === "Cancelled" ? "Why it was dropped" : "Revert reason"}>
                        {entry.revertReason}
                      </Fact>
                    )}
                  </>
                )}
              </dl>

              <div>
                <FrameStrip frames={stripFrames} checks={checks} size="lg" globalFailure={globalFailure} />
                {!parsed && views.length > 0 && (
                  <p className="mt-2 max-w-[64ch] text-[0.8125rem] text-ink-soft">
                    The transaction has left the pool; these frames are from the admission report kept for it.
                  </p>
                )}
              </div>

              {admission ? (
                <RuleChecklist checks={admission.checks} />
              ) : (
                <p className="text-ink-soft">
                  This node has no admission report for it. Reports are kept in memory and cleared when the node
                  restarts.
                </p>
              )}
              {views.length > 0 && <FramesTable frames={views} />}
              <Timeline events={events} />
            </>
          );
        })()
      )}

      <AcrossInstances instances={compared} hash={hash} current={nodeUrl} />
    </div>
  );
}
