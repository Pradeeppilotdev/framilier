import { useNow, usePeers } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { formatAgo, shortHash } from "../../logic/format";
import { HelpTip } from "../HelpTip";
import { QueryErrorBanner } from "../QueryErrorBanner";

/** The peers this node is connected to over the p2p network. */
export function PeersScreen({ instance, p2pEnabled }: { instance: Instance; p2pEnabled: boolean }) {
  const peers = usePeers(instance.url);
  const now = useNow();

  return (
    <section aria-labelledby="peers-title">
      <h2 id="peers-title" className="mb-4 text-2xl">
        Peers
      </h2>
      {peers.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={peers.error} url={instance.url} />
        </div>
      )}
      {peers.data === undefined ? (
        peers.isPending ? (
          <p role="status" className="py-8 text-ink-soft">
            Loading peers…
          </p>
        ) : null
      ) : peers.data.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">{p2pEnabled ? "No peers connected." : "This node runs without p2p."}</p>
          <p className="max-w-[60ch] text-ink-soft">
            {p2pEnabled
              ? "Peers appear once this node discovers or is dialed by other bundlers. Check that it has a boot ENR."
              : "Standalone mode does not gossip transactions, so it has no peers. Start it with the node command to join the network."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Peer</th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Direction
                  <HelpTip label="What does direction mean?">
                    Who opened the connection. Inbound: the peer dialed this node. Outbound: this node dialed the
                    peer. Either way the connection carries traffic in both directions.
                  </HelpTip>
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">Connected</th>
                <th scope="col" className="py-2 pr-4 font-normal">Last message</th>
                <th scope="col" className="py-2 pr-4 font-normal">Client</th>
                <th scope="col" className="py-2 font-normal">Mempools</th>
              </tr>
            </thead>
            <tbody>
              {peers.data.map((peer) => (
                <tr key={peer.peerId} className="border-b border-line align-middle">
                  <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={peer.peerId}>
                    {shortHash(peer.peerId, 8, 6)}
                  </td>
                  <td className="py-2.5 pr-4">{peer.direction}</td>
                  <td className="tabular py-2.5 pr-4 text-ink-soft">{formatAgo(peer.connectedAt, now)}</td>
                  <td className="tabular py-2.5 pr-4 text-ink-soft">
                    {peer.lastReceivedAt > 0 ? formatAgo(peer.lastReceivedAt, now) : "–"}
                  </td>
                  <td className="py-2.5 pr-4">{peer.agentVersion ?? "unknown"}</td>
                  <td className="tabular py-2.5">{peer.supportedMempools.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
