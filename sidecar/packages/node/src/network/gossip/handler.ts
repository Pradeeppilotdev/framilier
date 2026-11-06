import { GossipSub, GossipsubEvents } from "@chainsafe/libp2p-gossipsub";
import type { PrivateKey, PeerId, PeerStore, ComponentLogger } from "@libp2p/interface";
import logger, { Logger } from "@skandha/api/lib/logger";
import { ts } from "@skandha/types/lib/index.js";
import { GOSSIP_MAX_SIZE } from "@skandha/types/lib/sszTypes";
import { AllChainsMetrics } from "@skandha/monitoring/lib/index.js";
import { SignaturePolicy } from "@chainsafe/libp2p-gossipsub/types";
import { Libp2p } from "../interface.js";
import { NetworkEvent, NetworkEventBus } from "../events.js";
import {
  GossipTypeMap,
  GossipType,
  GossipTopic,
  GossipTopicMap,
} from "./interface.js";
import {
  GossipTopicCache,
  getGossipSSZType,
  stringifyGossipTopic,
} from "./topic.js";
import { DataTransformSnappy } from "./encoding.js";

export type GossipsubModules = {
  libp2p: Libp2p;
  events: NetworkEventBus;
  metrics: AllChainsMetrics | null;
};

/**
 * libp2p 2.x's `Libp2p` class instance carries a `.components` property with
 * the real internal Registrar/ConnectionManager implementations
 * (`openConnection()`, `getTopologies()`, etc.) - it just isn't part of the
 * public `Libp2p` TypeScript interface (see libp2p's own `libp2p.js`:
 * `this.components = defaultComponents({...})`, then
 * `this.configureComponent('registrar', ...)` /
 * `this.configureComponent('connectionManager', ...)`).
 *
 * gossipsub 14.x's direct-peer-reconnect and peer-exchange (PX) handling
 * call `this.components.connectionManager.openConnection(peerId)` and
 * `this.components.registrar.getTopologies(multicodec)` directly - neither
 * method exists on the public `Libp2p` instance, so passing it directly (as
 * an earlier revision of this file did, type-checked only via `any`) leaves
 * those real mesh-maintenance paths throwing `TypeError` at runtime even
 * though the happy-path connect/publish/subscribe flow works. Reaching into
 * the real `.components` object (not just the public instance) fixes this
 * for real, not just for tsc.
 */
type Libp2pWithComponents = {
  components: {
    privateKey: PrivateKey;
    peerId: PeerId;
    peerStore: PeerStore;
    logger: ComponentLogger;
    registrar: unknown;
    connectionManager: unknown;
  };
};

export class BundlerGossipsub extends GossipSub {
  logger: Logger = logger;

  private readonly gossipTopicCache: GossipTopicCache;
  private readonly events: NetworkEventBus;
  private readonly monitoring: AllChainsMetrics | null; // name "metrics" is occupied by the base class

  constructor(modules: GossipsubModules) {
    const gossipTopicCache = new GossipTopicCache();
    const { components } = modules.libp2p as unknown as Libp2pWithComponents;
    super(
      // gossipsub 14.x types its GossipSubComponents against a nested,
      // older major of @libp2p/interface (2.x, no longer resolvable from
      // this package's own @libp2p/interface 2.11.0 dependency's exact
      // instance - see network/gossip/interface.ts) and against
      // @libp2p/interface-internal's Registrar/ConnectionManager types
      // (not an explicit dependency of this package), so the object as a
      // whole still needs a boundary cast - but every field on it below is
      // now the real internal libp2p component, not the public Libp2p
      // instance, so the values themselves are correct at runtime (see
      // Libp2pWithComponents above).
      components as any,
      {
        globalSignaturePolicy: SignaturePolicy.StrictNoSign,
        dataTransform: new DataTransformSnappy(
          gossipTopicCache,
          GOSSIP_MAX_SIZE
        ),
      }
    );
    this.gossipTopicCache = gossipTopicCache;
    this.events = modules.events;
    this.monitoring = modules.metrics;

    this.addEventListener(
      "gossipsub:message",
      this.onGossipsubMessage.bind(this)
    );
  }

  /**
   * Publish a `GossipObject` on a `GossipTopic`
   */
  async publishObject<K extends GossipType>(
    topic: GossipTopicMap[K],
    object: GossipTypeMap[K]
  ): Promise<number> {
    const topicStr = this.getGossipTopicString(topic);
    const sszType = getGossipSSZType(topic);
    const messageData = (
      sszType.serialize as unknown as (
        object: GossipTypeMap[GossipType]
      ) => Uint8Array
    )(object);
    const result = await this.publish(topicStr, messageData);
    const sentPeers = result.recipients.length;
    this.logger.debug({ topic: topicStr, sentPeers }, "Publish to topic");
    return sentPeers;
  }

  /**
   * Subscribe to a `GossipTopic`
   */
  subscribeTopic(topic: GossipTopic): void {
    const topicStr = this.getGossipTopicString(topic);
    // Register known topicStr
    this.gossipTopicCache.setTopic(topicStr, topic);

    this.logger.debug({ topic: topicStr }, "Subscribe to gossipsub topic");
    this.subscribe(topicStr);
  }

  /**
   * Unsubscribe to a `GossipTopic`
   */
  unsubscribeTopic(topic: GossipTopic): void {
    const topicStr = this.getGossipTopicString(topic);
    this.logger.debug({ topic: topicStr }, "Unsubscribe to gossipsub topic");
    this.unsubscribe(topicStr);
  }

  private getGossipTopicString(topic: GossipTopic): string {
    return stringifyGossipTopic(topic);
  }

  async publishVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.publishObject<GossipType.frame_transaction>(
      {
        type: GossipType.frame_transaction,
        mempool,
      },
      verifiedFrameTx
    );
  }

  private onGossipsubMessage(
    event: GossipsubEvents["gossipsub:message"]
  ): void {
    const { propagationSource, msgId, msg } = event.detail;

    try {
      // Also validates that the topicStr is known
      const topic = this.gossipTopicCache.getTopic(msg.topic);

      // Get seenTimestamp before adding the message to the queue or add async delays
      const seenTimestampSec = Date.now() / 1000;

      // Emit message to network processor, use setTimeout to yield to the macro queue
      // This is mostly due to too many attestation messages, and a gossipsub RPC may
      // contain multiple of them. This helps avoid the I/O lag issue.
      setTimeout(() => {
        this.events.emit(NetworkEvent.pendingGossipsubMessage as any, {
          topic,
          msg,
          msgId,
          propagationSource,
          seenTimestampSec,
          startProcessUnixSec: null,
        });
      }, 0);
    } catch (err) {
      this.logger.error(err);
    }
  }
}
