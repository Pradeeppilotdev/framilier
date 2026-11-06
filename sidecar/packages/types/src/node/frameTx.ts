import {
  ByteListType,
  ContainerType,
  ListBasicType,
  ListCompositeType,
  OptionalType,
} from "@chainsafe/ssz";
import * as primitiveSsz from "../primitive/sszTypes.js";
import { MAX_BYTE_ARRAY_SIZE, MAX_OPS_PER_REQUEST } from "../sszTypes.js";

const { Address, Bytes32, UintBn256 } = primitiveSsz;

// constants used in this module
// ==============================

export const MAX_FRAMES = 64;
// not spec-defined; placeholder pending EIP-8141 confirmation
export const MAX_SIGNATURES = 64;
// not spec-defined; placeholder pending EIP-8141 confirmation
export const MAX_BLOB_HASHES = 6;
// not spec-defined; placeholder pending EIP-8141 confirmation
export const MAX_FRAME_TXS_PER_REQUEST = 4096;
// EIP-8250 / EIP-8272 static limits (see contracts/FrameTx.ts)
export const MAX_NONCE_KEYS = 16;
export const MAX_RECENT_ROOT_REFERENCES = 16;

// FrameTransaction sub-types (mirrors packages/types/src/contracts/FrameTx.ts)
// ==============================================================================

export const FrameLimits = new ContainerType(
  {
    execution: UintBn256,
    state: UintBn256,
  },
  { typeName: "FrameLimits", jsonCase: "eth2" }
);

export const Frame = new ContainerType(
  {
    mode: primitiveSsz.Uint8,
    flags: primitiveSsz.Uint8,
    target: new OptionalType(Address),
    limits: FrameLimits,
    value: UintBn256,
    data: new ByteListType(MAX_BYTE_ARRAY_SIZE),
  },
  { typeName: "Frame", jsonCase: "eth2" }
);

export const SignatureEntry = new ContainerType(
  {
    scheme: primitiveSsz.Uint8,
    // empty for ARBITRARY; exactly 20 bytes (an address) for SECP256K1/P256
    signer: new ByteListType(20),
    // empty (canonical sig hash) or exactly 32 bytes (an explicit digest)
    msg: new ByteListType(32),
    signature: new ByteListType(MAX_BYTE_ARRAY_SIZE),
  },
  { typeName: "SignatureEntry", jsonCase: "eth2" }
);

export const FeeParams = new ContainerType(
  {
    max_priority_fee_per_gas: UintBn256,
    max_fee_per_gas: UintBn256,
    max_fee_per_blob_gas: UintBn256,
  },
  { typeName: "FeeParams", jsonCase: "eth2" }
);

export const RecentRootReference = new ContainerType(
  {
    source_id: Bytes32,
    slot: primitiveSsz.UintBn64,
    root: Bytes32,
  },
  { typeName: "RecentRootReference", jsonCase: "eth2" }
);

// Changing this container is a breaking P2P change: peers on the old shape
// cannot decode it. The gossip topic name and the PooledFrameTxsByHash
// protocol version are bumped alongside it so mismatched peers never meet.
export const FrameTransaction = new ContainerType(
  {
    chain_id: UintBn256,
    nonce_keys: new ListBasicType(UintBn256, MAX_NONCE_KEYS),
    nonce_seq: primitiveSsz.UintBn64,
    sender: Address,
    frames: new ListCompositeType(Frame, MAX_FRAMES),
    signatures: new ListCompositeType(SignatureEntry, MAX_SIGNATURES),
    fees: FeeParams,
    blob_versioned_hashes: new ListCompositeType(Bytes32, MAX_BLOB_HASHES),
    recent_root_references: new ListCompositeType(
      RecentRootReference,
      MAX_RECENT_ROOT_REFERENCES
    ),
  },
  { typeName: "FrameTransaction", jsonCase: "eth2" }
);

// Gossip/reqresp container types
// ================================

export const VerifiedFrameTx = new ContainerType(
  {
    frame_transaction: FrameTransaction,
    entry_point: Address,
    verified_at_block_hash: UintBn256,
  },
  { typeName: "VerifiedFrameTx", jsonCase: "eth2" }
);

export const PooledFrameTxHashesRequest = new ContainerType(
  {
    cursor: primitiveSsz.UintBn64,
  },
  { typeName: "PooledFrameTxHashesRequest", jsonCase: "eth2" }
);

export const PooledFrameTxHashes = new ContainerType(
  {
    next_cursor: primitiveSsz.UintBn64,
    hashes: new ListCompositeType(Bytes32, MAX_OPS_PER_REQUEST),
  },
  { typeName: "PooledFrameTxHashes", jsonCase: "eth2" }
);

export const PooledFrameTxsByHashRequest = new ContainerType(
  {
    hashes: new ListCompositeType(Bytes32, MAX_OPS_PER_REQUEST),
  },
  { typeName: "PooledFrameTxsByHashRequest", jsonCase: "eth2" }
);

export const PooledFrameTxsByHash = new ListCompositeType(
  FrameTransaction,
  MAX_FRAME_TXS_PER_REQUEST
);

export const ssz = {
  FrameLimits,
  Frame,
  SignatureEntry,
  FeeParams,
  FrameTransaction,
  VerifiedFrameTx,
  PooledFrameTxHashesRequest,
  PooledFrameTxHashes,
  PooledFrameTxsByHashRequest,
  PooledFrameTxsByHash,
};
