import { useInfo, useReputation } from "../../data/hooks";
import type { ReputationEntry } from "../../protocol/schemas";
import type { Instance } from "../../instances/store";
import { formatEther, shortAddress } from "../../logic/format";
import { QueryErrorBanner } from "../QueryErrorBanner";
import { StatusBadge } from "../StatusBadge";
import { ReputationGauge } from "../ReputationGauge";

/**
 * "staked" and "unlocking" are mutually exclusive: once a withdrawal is
 * initiated (withdrawTime != 0), isStaked is false even if stake/delay still
 * clear the threshold (ERC-8421's STAKING-010) - so an entity never shows
 * both labels at once. Returns null for a plain unstaked entity with no
 * deposit at all.
 */
export function stakeLabel(item: ReputationEntry): "staked" | "unlocking" | null {
  if (item.isStaked) {
    return "staked";
  }
  if (BigInt(item.withdrawTime) !== 0n) {
    return "unlocking";
  }
  return null;
}

/** Every entity this node tracks reputation and stake for. */
export function ReputationScreen({ instance }: { instance: Instance }) {
  const reputation = useReputation(instance.url);
  const info = useInfo(instance.url);
  const items = reputation.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="reputation-title">
      <h2 id="reputation-title" className="mb-4 text-2xl">
        Reputation
      </h2>

      {reputation.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={reputation.error} url={instance.url} onRetry={() => void reputation.refetch()} />
        </div>
      )}
      {reputation.data === undefined ? (
        reputation.isPending ? (
          <p role="status" className="py-8 text-ink-soft">
            Loading reputation…
          </p>
        ) : null
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">Nothing tracked yet.</p>
          <p className="max-w-[60ch] text-ink-soft">
            An entity appears here once this node has seen a transaction that names it.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Address</th>
                <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                <th scope="col" className="py-2 pr-4 font-normal">Seen</th>
                <th scope="col" className="py-2 pr-4 font-normal">Included</th>
                <th scope="col" className="py-2 pr-4 font-normal">Standing</th>
                <th scope="col" className="py-2 pr-4 font-normal">Stake</th>
                <th scope="col" className="py-2 font-normal">Unstake delay</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.address} className="border-b border-line align-middle">
                  <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={item.address}>
                    {shortAddress(item.address)}
                    {item.isWhitelisted && <span className="ml-2 text-ink-soft">whitelisted</span>}
                    {item.isBlacklisted && <span className="ml-2 text-fail">blacklisted</span>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="tabular py-2.5 pr-4">{item.opsSeen}</td>
                  <td className="tabular py-2.5 pr-4">{item.opsIncluded}</td>
                  <td className="py-2.5 pr-4">
                    {info.data && (
                      <ReputationGauge
                        opsSeen={item.opsSeen}
                        opsIncluded={item.opsIncluded}
                        minInclusionDenominator={info.data.minInclusionDenominator}
                        throttlingSlack={info.data.throttlingSlack}
                        banSlack={info.data.banSlack}
                      />
                    )}
                  </td>
                  <td className="tabular py-2.5 pr-4">
                    {formatEther(item.stake)}
                    {stakeLabel(item) === "staked" && (
                      <span className="ml-2 text-ink-soft">staked</span>
                    )}
                    {stakeLabel(item) === "unlocking" && (
                      <span className="ml-2 text-ink-soft" title="Withdrawal initiated - no longer treated as staked">
                        unlocking
                      </span>
                    )}
                  </td>
                  <td className="tabular py-2.5">{item.unstakeDelaySec.toLocaleString("en-US")}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reputation.hasNextPage && (
        <button
          type="button"
          onClick={() => void reputation.fetchNextPage()}
          disabled={reputation.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {reputation.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
