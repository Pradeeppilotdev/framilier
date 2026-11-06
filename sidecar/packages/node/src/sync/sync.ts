import logger from "@skandha/api/lib/logger";
import { PeerId } from "@libp2p/interface";
import { ts } from "@skandha/types/lib/index.js";
import { deserializeMempoolId, isMempoolIdEqual } from "@skandha/params/lib/index.js";
import { userOpHashToString } from "@skandha/params/lib/utils/userOp";
import { deserializeFrameTx } from "@skandha/params/lib/utils/frameTx";
import { AllChainsMetrics } from "@skandha/monitoring/lib/index.js";
import { Executor } from "@skandha/executor/lib/executor";
import { Config } from "@skandha/executor/lib/config";
import { INetwork } from "../network/interface.js";
import { NetworkEvent } from "../network/events.js";
import { PeerMap } from "../utils/index.js";
import {
  ISyncService,
  PeerState,
  PeerSyncState,
  SyncModules,
  SyncState,
} from "./interface.js";

export class SyncService implements ISyncService {
  state: SyncState;
  peers: PeerMap<PeerState> = new PeerMap();

  private readonly network: INetwork;
  private readonly metrics: AllChainsMetrics | null;
  private readonly executor: Executor;
  private readonly executorConfig: Config;

  constructor(modules: SyncModules) {
    this.state = SyncState.Stalled;

    this.network = modules.network;
    this.metrics = modules.metrics;
    this.executor = modules.executor;
    this.executorConfig = modules.executorConfig;

    this.network.events.on(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.on(
      NetworkEvent.peerMetadataReceived,
      this.addPeerMetadata
    );
    this.network.events.on(NetworkEvent.peerDisconnected, this.removePeer);
  }

  close(): void {
    this.network.events.off(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.off(NetworkEvent.peerDisconnected, this.removePeer);
  }

  isSyncing(): boolean {
    return this.state === SyncState.Syncing;
  }

  isSynced(): boolean {
    return this.state === SyncState.Synced;
  }

  private addPeer = (peerId: PeerId, status: ts.Status): void => {
    const peer = this.peers.get(peerId);
    if (peer && peer.status != null) {
      logger.debug(`Sync service: status already added: ${peerId.toString()}`);
      return;
    }

    this.peers.set(peerId, {
      status,
      metadata: peer?.metadata,
      syncState: PeerSyncState.New,
    });

    logger.debug(`Sync service: added peer: ${peerId.toString()}`);

    if (peer?.metadata) {
      this.startSyncing();
    }
  };

  private addPeerMetadata = (peerId: PeerId, metadata: ts.Metadata): void => {
    const peer = this.peers.get(peerId);
    if (peer && peer.metadata) {
      logger.debug(
        `Sync service: metadata already added: ${peerId.toString()}`
      );
      return;
    }

    this.peers.set(peerId, {
      status: peer?.status,
      metadata: metadata,
      syncState: PeerSyncState.New,
    });

    logger.debug(`Sync service: metadata added: ${peerId.toString()}`);

    if (peer?.status) {
      this.startSyncing();
    }
  };

  /**
   * Must be called by libp2p when a peer is removed from the peer manager
   */
  private removePeer = (peerId: PeerId): void => {
    this.peers.delete(peerId);
  };

  private startSyncing(): void {
    logger.debug(`Sync service: attempt syncing, status = ${this.state}`);
    if (this.state === SyncState.Syncing) {
      return; // Skip, already started
    }

    this.state = SyncState.Syncing;

    void this.requestBatches();
  }

  private async requestBatches(): Promise<void> {
    logger.debug("Sync service: requested batches");
    for (const [peerId, peer] of this.peers.entries()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (peer.syncState !== PeerSyncState.New || !peer.metadata) {
        continue; // Already synced;
      }
      peer.syncState = PeerSyncState.Syncing;

      try {
        const supportedMempools = this.executorConfig.getSupportedMempools();

        for (const mempool of peer.metadata.supported_mempools) {
          // Find the matching supported mempool to get its entry point
          const matchingMempool = supportedMempools.find(m => 
            isMempoolIdEqual(m.mempoolId, mempool)
          );
          
          if (!matchingMempool) {
            logger.debug(
              `mempool not supported: ${deserializeMempoolId(mempool)}`
            );
            continue;
          }

          const hashes: Uint8Array[] = [];
          let cursor = BigInt(0);

          // Pages until the peer signals no more (`next_cursor: 0`, see
          // `onPooledFrameTxHashes`'s handler) - a peer with more than one
          // page's worth of New entries (MAX_OPS_PER_REQUEST) needs more
          // than one round-trip to be fully sync'd.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const response = await this.network.pooledFrameTxHashes(peerId, {
              cursor,
            });
            hashes.push(...response.hashes);
            if (!response.next_cursor) {
              break;
            }
            cursor = response.next_cursor;
          }

          if (!hashes.length) {
            logger.debug("No hashes received");
            continue; // try next supported mempool for this peer
          } else {
            logger.debug(`Received hashes: ${hashes.length}`);
            logger.debug(
              `${hashes.map((hash) => userOpHashToString(hash)).join(", ")}`
            );
          }

          const missingHashes: Uint8Array[] = [];
          for (const hash of hashes) {
            const exists =
              (await this.executor.mempoolService.getEntryByHash(
                userOpHashToString(hash)
              )) != null;
            if (!exists) {
              missingHashes.push(hash);
            }
          }

          if (missingHashes.length === 0) {
            logger.debug("No new hashes received");
            continue; // try next supported mempool for this peer
          }

          const frameTxs = await this.network.pooledFrameTxsByHash(peerId, {
            hashes: missingHashes,
          });

          // Same admission path gossip-received transactions go through
          // (`handleValidVerifiedFrameTx`, gossipHandlers.ts): deserialize
          // the SSZ wire shape back into a real FrameTransaction, drop it
          // (log, don't throw - this is untrusted peer data) if it's not
          // new/replacing, otherwise hand it to the same
          // `eth.sendFrameTransaction` every other ingestion path uses.
          // Each entry is handled independently so one bad transaction from
          // a peer doesn't abort the rest of the batch.
          for (const frameTx of frameTxs) {
            const tx = deserializeFrameTx(frameTx);

            try {
              await this.executor.mempoolService.validateFrameTxReplaceability(
                tx
              );
            } catch (err) {
              logger.debug(
                `[${tx.sender}, [${tx.nonceKeys}]:${tx.nonceSeq}] not new/replacing, skipping: ${err}`
              );
              continue;
            }

            try {
              const txHash = await this.executor.eth.sendFrameTransaction(
                tx,
                `sync:${peerId.toString()}`
              );
              logger.debug(`Synced frame tx: ${txHash}`);
              if (this.metrics) {
                this.metrics[this.executor.chainId].useropsReceived?.inc();
              }
            } catch (err) {
              logger.error(`Could not process synced frame tx: ${err}`);
            }
          }
        }
      } catch (err) {
        logger.error(err);
      }

      peer.syncState = PeerSyncState.Synced; // TODO: check if syncState changes are correct
    }

    this.state = SyncState.Synced;
  }
}
