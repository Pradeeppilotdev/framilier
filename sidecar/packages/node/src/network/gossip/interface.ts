import { EventEmitter } from "events";
import { Libp2p } from "libp2p";
import type { PeerId, PublicKey } from "@libp2p/interface";
import StrictEventEmitter from "strict-event-emitter-types";
import { PeerIdStr } from "@chainsafe/libp2p-gossipsub/types";
import { ts } from "@skandha/types/lib/index.js";
import { NetworkEvent } from "../events.js";

// gossipsub 14.x (and its pubsub base class) types its public API against a
// nested, older major of @libp2p/interface (2.x) that no longer ships from
// the root package (3.x, used everywhere else in this codebase) - the
// pubsub-specific types below were dropped from @libp2p/interface entirely
// in that major. Message/TopicValidatorResult are redeclared locally here,
// matching gossipsub's own shapes/string-enum values field-for-field, so
// values crossing the gossipsub boundary remain structurally and (for the
// string enum) runtime compatible without depending on gossipsub's
// inaccessible nested package.
export type UnsignedGossipMessage = {
  type: "unsigned";
  topic: string;
  data: Uint8Array;
};
export type SignedGossipMessage = {
  type: "signed";
  from: PeerId;
  topic: string;
  data: Uint8Array;
  sequenceNumber: bigint;
  signature: Uint8Array;
  key: PublicKey;
};
export type Message = UnsignedGossipMessage | SignedGossipMessage;

export enum TopicValidatorResult {
  Accept = "accept",
  Ignore = "ignore",
  Reject = "reject",
}

export enum GossipType {
  // `_v2`: the gossiped FrameTransaction carries EIP-8250 nonce_keys/nonce_seq
  // and EIP-8272 recent_root_references. Renaming the topic keeps nodes on the
  // old SSZ shape off it entirely, rather than failing to decode (and
  // downscoring) each other's messages.
  frame_transaction = "frame_transaction_v2",
}

export enum GossipEncoding {
  ssz_snappy = "ssz_snappy",
}

export interface IGossipTopic {
  type: GossipType;
  mempool: string;
  encoding?: GossipEncoding;
}

export type GossipTopicTypeMap = {
  [GossipType.frame_transaction]: {
    type: GossipType.frame_transaction;
  };
};

export type GossipTopicMap = {
  [K in keyof GossipTopicTypeMap]: GossipTopicTypeMap[K] & IGossipTopic;
};

/**
 * Gossip topic split into a struct
 */
export type GossipTopic = GossipTopicMap[keyof GossipTopicMap];

export type GossipTypeMap = {
  [GossipType.frame_transaction]: ts.VerifiedFrameTx;
};

export type GossipFnByType = {
  [GossipType.frame_transaction]: (
    verifiedFrameTx: ts.VerifiedFrameTx
  ) => Promise<void> | void;
};

export type GossipFn = GossipFnByType[keyof GossipFnByType];

export interface IGossipEvents {
  [topicStr: string]: GossipFn;
  [NetworkEvent.gossipHeartbeat]: () => void;
  [NetworkEvent.gossipStart]: () => void;
  [NetworkEvent.gossipStop]: () => void;
}
export type GossipEventEmitter = StrictEventEmitter<
  EventEmitter,
  IGossipEvents
>;

export interface IGossipModules {
  libp2p: Libp2p;
}

/**
 * Contains various methods for validation of incoming gossip topic data.
 * The conditions for valid gossip topics and how they are handled are specified here:
 * https://github.com/ethereum/consensus-specs/blob/v1.1.10/specs/phase0/p2p-interface.md#global-topics
 */

/**
 * Top-level type for gossip validation functions
 *
 * js-libp2p-gossipsub expects validation functions that look like this
 */
export type GossipValidatorFn = (
  topic: GossipTopic,
  msg: Message,
  propagationSource: PeerIdStr,
  seenTimestampSec: number
) => Promise<TopicValidatorResult>;

export type ValidatorFnsByType = { [K in GossipType]: GossipValidatorFn };

export type GossipHandlerFn = (
  object: GossipTypeMap[GossipType],
  topic: GossipTopicMap[GossipType],
  peerIdStr: string,
  seenTimestampSec: number,
  gossipSerializedData: Uint8Array
) => Promise<void>;
export type GossipHandlers = {
  [K in GossipType]: (
    object: GossipTypeMap[K],
    topic: GossipTopicMap[K],
    peerIdStr: string,
    seenTimestampSec: number,
    gossipSerializedData: Uint8Array
  ) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResolvedType<F extends (...args: any) => Promise<any>> = F extends (
  ...args: any
) => Promise<infer T>
  ? T
  : never;
