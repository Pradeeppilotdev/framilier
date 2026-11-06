import { createLibp2p } from "libp2p";
import type { Libp2pOptions as CoreLibp2pOptions } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mplex } from "@libp2p/mplex";
import { bootstrap } from "@libp2p/bootstrap";
import { mdns } from "@libp2p/mdns";
import { identify } from "@libp2p/identify";
import type { PrivateKey } from "@libp2p/interface";
import { Datastore } from "interface-datastore";
import { Libp2p } from "../interface.js";
import { createNoise } from "./noise.js";

// libp2p doesn't export its internal `Components` type used to parameterize
// peer-discovery factories, so the exact factory function type is pulled out
// of its own `Libp2pOptions["peerDiscovery"]` field instead of naming it.
type PeerDiscoverer = NonNullable<CoreLibp2pOptions["peerDiscovery"]>[number];

export type Libp2pOptions = {
  /**
   * libp2p 1.x+ derives the node's PeerId from a PrivateKey instead of
   * accepting a PeerId directly.
   */
  privateKey: PrivateKey;
  addresses: {
    listen: string[];
    announce?: string[];
  };
  datastore?: Datastore;
  peerDiscovery?: PeerDiscoverer[];
  bootMultiaddrs?: string[];
  maxConnections?: number;
  /**
   * No longer forwarded to libp2p's own ConnectionManager (the min-connections
   * autodial-to-floor feature was removed upstream); kept for API compat -
   * PeerManager drives its own target/max peer counts independently.
   */
  minConnections?: number;
  skandhaVersion?: string;
  mdns?: boolean;
};

export async function createNodejsLibp2p(
  options: Libp2pOptions
): Promise<Libp2p> {
  const peerDiscovery: PeerDiscoverer[] = [];
  if (options.peerDiscovery) {
    peerDiscovery.push(...options.peerDiscovery);
  } else {
    if ((options.bootMultiaddrs?.length ?? 0) > 0) {
      peerDiscovery.push(bootstrap({ list: options.bootMultiaddrs ?? [] }));
    }
    if (options.mdns) {
      peerDiscovery.push(mdns());
    }
  }
  return (await createLibp2p({
    privateKey: options.privateKey,
    addresses: {
      listen: options.addresses.listen,
      announce: options.addresses.announce || [],
    },
    connectionEncrypters: [createNoise()],
    // Reject connections when the server's connection count gets high
    transports: [
      tcp({
        maxConnections: options.maxConnections,
        closeServerOnMaxConnections: {
          closeAbove: options.maxConnections ?? Infinity,
          listenBelow: options.maxConnections ?? Infinity,
        },
      }),
    ],
    // Note: `maxInboundStreams` was removed from MplexInit upstream (mplex is
    // now deprecated in favour of yamux - kept here per the pinned baseline).
    streamMuxers: [mplex()],
    peerDiscovery,
    connectionManager: {
      // dialer config
      maxParallelDials: 100,
      maxPeerAddrsToDial: 4,
      dialTimeout: 30_000,

      // Note: autoDial was removed upstream - libp2p 1.x+ no longer
      // auto-dials discovered peers, matching the old `autoDial: false`
      // behaviour by default. PeerManager/PeerDiscovery drive all dialing.
      maxConnections: options.maxConnections,
    },
    // `datastore-core`/`interface-datastore` (used by our custom
    // Eth2PeerDataStore) are pinned to an older major than the
    // `interface-datastore` libp2p itself now depends on transitively -
    // both packages implement the same Datastore contract, but structurally
    // differ on a private class field, so bridge with a type-only cast.
    // Out of scope for this task's libp2p/discv5/gossipsub/noise bump.
    datastore: options.datastore as unknown as CoreLibp2pOptions["datastore"],
    nodeInfo: {
      userAgent: options.skandhaVersion
        ? `skandha/${options.skandhaVersion}`
        : "skandha",
    },
    // NAT traversal and circuit relay are opt-in `services` in libp2p 1.x+
    // (no more top-level `nat`/`relay` init flags); omitting them here
    // matches the old `enabled: false` configuration.
    services: {
      identify: identify(),
    },
  })) as Libp2p;
}
