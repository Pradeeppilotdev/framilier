import { describe, it, expect } from "vitest";
import {
  toVerifiedFrameTx,
  deserializeVerifiedFrameTx,
} from "@skandha/params/lib/utils/frameTx";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  GossipType,
  GossipTopic,
} from "../../../src/network/gossip/interface.js";
import {
  getGossipSSZType,
  getCoreTopics,
  stringifyGossipTopic,
  parseGossipTopic,
} from "../../../src/network/gossip/topic.js";

const SENDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".toLowerCase() as `0x${string}`;
const ENTRY_POINT = "0x00000000000000000000000000000000000000aa";
const MEMPOOL_ID = "test_mempool";

function buildFrameTx(): FrameTransaction {
  return {
    chainId: BigInt(1337),
    // EIP-8250: non-linear keys, including one above 2**64.
    nonceKeys: [1n, 2n ** 200n],
    nonceSeq: BigInt(3),
    sender: SENDER,
    frames: [
      {
        mode: 1,
        flags: 0x2,
        target: null,
        limits: { execution: BigInt(100000), state: BigInt(50000) },
        value: BigInt(0),
        data: "0xdeadbeef",
      },
    ],
    signatures: [
      {
        scheme: 0,
        signer: "0x",
        msg: "0x",
        signature: "0x1234",
      },
    ],
    fees: {
      maxPriorityFeePerGas: BigInt(1_000_000_000),
      maxFeePerGas: BigInt(2_000_000_000),
      maxFeePerBlobGas: BigInt(0),
    },
    blobVersionedHashes: [],
    recentRootReferences: [
      {
        sourceId: `0x${"a".repeat(64)}`,
        slot: 2n ** 64n - 1n,
        root: `0x${"b".repeat(64)}`,
      },
    ],
  };
}

// The gossip pubsub wire format (GossipType, GossipTypeMap,
// getGossipSSZType, the publish/receive handlers) is frame-tx-shaped
// end-to-end. This exercises the full publish -> wire-encode -> wire-decode
// -> receive path a real gossipsub `publishObject`/`onGossipsubMessage`
// round trip would perform, without spinning up real libp2p peers (see
// test/e2e/frameTx.e2e.test.ts for that).
describe("gossip wire format (frame transactions)", () => {
  it("GossipType is frame-tx-shaped, not user-operation-shaped", () => {
    expect(Object.values(GossipType)).toEqual(["frame_transaction_v2"]);
  });

  it("getCoreTopics()/stringifyGossipTopic/parseGossipTopic round-trip the frame_transaction topic", () => {
    const [coreTopic] = getCoreTopics();
    expect(coreTopic.type).toBe(GossipType.frame_transaction);

    const topic: GossipTopic = { ...coreTopic, mempool: MEMPOOL_ID };
    const topicStr = stringifyGossipTopic(topic);
    expect(topicStr).toBe(
      `/account_abstraction/${MEMPOOL_ID}/frame_transaction_v2/ssz_snappy`
    );

    const parsed = parseGossipTopic(topicStr);
    expect(parsed.type).toBe(GossipType.frame_transaction);
    expect(parsed.mempool).toBe(MEMPOOL_ID);
  });

  it("getGossipSSZType resolves the real ssz VerifiedFrameTx container for the frame_transaction topic", () => {
    const topic: GossipTopic = {
      type: GossipType.frame_transaction,
      mempool: MEMPOOL_ID,
    };
    const sszType = getGossipSSZType(topic);
    expect(sszType.typeName).toBe("VerifiedFrameTx");
  });

  it("publish -> wire bytes -> receive round trip: a FrameTransaction survives toVerifiedFrameTx -> ssz encode -> ssz decode -> deserializeVerifiedFrameTx unchanged", () => {
    const tx = buildFrameTx();
    const blockHash = "0x64"; // 100

    // Publish side: eth.ts/publishVerifiedFrameTxJSON builds this exact shape.
    const verified = toVerifiedFrameTx(ENTRY_POINT, tx, blockHash);

    // Wire side: BundlerGossipsub.publishObject looks up the ssz type via
    // getGossipSSZType(topic) and serializes with it.
    const topic: GossipTopic = {
      type: GossipType.frame_transaction,
      mempool: MEMPOOL_ID,
    };
    const sszType = getGossipSSZType(topic);
    const wireBytes = sszType.serialize(verified);

    // Receive side: the gossip handler decodes with the same ssz type
    // (BundlerGossipsub's DataTransformSnappy uses getGossipSSZType under
    // the hood) and the resulting object.frame_transaction/entry_point are
    // now handed directly to the GossipHandlers[GossipType.frame_transaction]
    // handler as a real ts.VerifiedFrameTx - no cast required.
    const decoded = sszType.deserialize(wireBytes);
    expect(sszType.equals(decoded, verified)).toBe(true);

    const { entryPoint, tx: roundTripped } = deserializeVerifiedFrameTx(decoded);
    expect(entryPoint.toLowerCase()).toBe(ENTRY_POINT.toLowerCase());
    expect(roundTripped.sender.toLowerCase()).toBe(tx.sender.toLowerCase());
    expect(roundTripped.chainId).toBe(tx.chainId);
    expect(roundTripped.nonceKeys).toEqual(tx.nonceKeys);
    expect(roundTripped.nonceSeq).toBe(tx.nonceSeq);
    expect(roundTripped.recentRootReferences).toEqual(tx.recentRootReferences);
    expect(roundTripped.frames).toEqual(tx.frames);
    expect(roundTripped.signatures).toEqual(tx.signatures);
    expect(roundTripped.fees).toEqual(tx.fees);
    expect(roundTripped.blobVersionedHashes).toEqual(tx.blobVersionedHashes);
  });
});
