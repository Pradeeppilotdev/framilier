import { Libp2p as ILibp2p } from "libp2p";
import { Connection } from "@libp2p/interface";
import { Multiaddr } from "@multiformats/multiaddr";
import { PeerId } from "@libp2p/interface";
// eslint-disable-next-line import/namespace
import { ValueOf } from "@chainsafe/ssz";
import { ts } from "@skandha/types/lib/index.js";
import {
  PooledFrameTxHashesRequest as PooledFrameTxHashesRequestSsz,
  PooledFrameTxHashes as PooledFrameTxHashesSsz,
  PooledFrameTxsByHashRequest as PooledFrameTxsByHashRequestSsz,
  PooledFrameTxsByHash as PooledFrameTxsByHashSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { SignableENR } from "@chainsafe/enr";
import { Logger } from "@skandha/api/lib/logger";
import { INetworkEventBus } from "./events.js";
import { MetadataController } from "./metadata.js";
import { BundlerGossipsub } from "./gossip/index.js";
import { ReqRespNode } from "./reqresp/ReqRespNode.js";

export type PeerSearchOptions = {
  supportsProtocols?: string[];
  count?: number;
};

export interface INetwork {
  events: INetworkEventBus;
  metadata: MetadataController;
  gossip: BundlerGossipsub;
  reqResp: ReqRespNode; //TODO - Define the class for reqResp
  logger: Logger;

  /** Our network identity */
  peerId: PeerId;
  localMultiaddrs: Multiaddr[];
  getEnr(): Promise<SignableENR | undefined>;
  getConnectionsByPeer(): Map<string, Connection[]>;
  getConnectedPeers(): PeerId[];
  getConnectedPeerWithInfo(): unknown[];
  getConnectedPeerCount(): number;

  /* List of p2p functions supported by Bundler */
  publishVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string
  ): Promise<void>;
  pooledFrameTxHashes(
    peerId: PeerId,
    req: ValueOf<typeof PooledFrameTxHashesRequestSsz>
  ): Promise<ValueOf<typeof PooledFrameTxHashesSsz>>;
  pooledFrameTxsByHash(
    peerId: PeerId,
    req: ValueOf<typeof PooledFrameTxsByHashRequestSsz>
  ): Promise<ValueOf<typeof PooledFrameTxsByHashSsz>>;

  //Gossip handler
  subscribeGossipCoreTopics(mempool: string): void;
  unsubscribeGossipCoreTopics(mempool: string): void;
  isSubscribedToGossipCoreTopics(mempool: string): boolean;

  // Service
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): void;

  // Debug
  connectToPeer(peer: PeerId, multiaddr: Multiaddr[]): Promise<void>;
  disconnectPeer(peer: PeerId): Promise<void>;
  getAgentVersion(peerIdStr: string): string;
}

export type PeerDirection = Connection["direction"];
export type PeerStatus = Connection["status"];

// libp2p 1.x+ dropped the Components pattern - handle()/unhandle()/
// register()/unregister()/dial()/hangUp()/getConnections()/getDialQueue()
// are all directly on the Libp2p instance now, and there is no more
// `.connectionManager`/`.registrar` sub-object.
export type Libp2p = ILibp2p;
