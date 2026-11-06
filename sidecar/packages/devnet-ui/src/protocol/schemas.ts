import { z } from "zod";
import type {
  AdmissionRecord,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerReputationEntry,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  LifecycleEvent,
  RuleCheck,
} from "@skandha/types/lib/explorer/index.js";

/**
 * Runtime validation of explorer responses. The UI talks to instances that may
 * run different versions, so every response is checked. Unknown object keys are
 * dropped; unknown string values in open-ended fields (rule ids, lifecycle
 * kinds, statuses) are accepted so a newer node does not break an older UI.
 */

export const RuleCheckSchema = z.object({
  rule: z.string(),
  frameIndex: z.number().int().nonnegative().optional(),
  entity: z.enum(["sender", "payer", "factory"]).optional(),
  verdict: z.enum(["pass", "fail", "skipped"]),
  detail: z.string().optional(),
});

/** A frame in the hex-quantity wire shape shared by `AdmissionRecord.frames` and `entry.tx.frames`. */
export const ExplorerFrameSchema = z.object({
  mode: z.number(),
  flags: z.number(),
  target: z.string().nullable(),
  limits: z.object({ execution: z.string(), state: z.string() }),
  value: z.string(),
  data: z.string(),
});

export const FrameRunStatusSchema = z.enum(["success", "reverted", "not-run"]);

export const AdmissionRecordSchema = z.object({
  id: z.number(),
  txHash: z.string(),
  sender: z.string(),
  nonce: z.string(),
  /** EIP-8250 nonce keys; absent from nodes older than keyed-nonce support. */
  nonceKeys: z.array(z.string()).optional(),
  at: z.number(),
  source: z.string(),
  outcome: z.enum(["accepted", "rejected", "replaced", "included", "dropped"]),
  errorCode: z.number().optional(),
  includer: z.string().optional(),
  checks: z.array(RuleCheckSchema),
  frames: z.array(ExplorerFrameSchema),
  frameStatuses: z.array(FrameRunStatusSchema),
});

export const LifecycleEventSchema = z.object({
  seq: z.number(),
  txHash: z.string(),
  at: z.number(),
  kind: z.string(),
  status: z.string().optional(),
  reason: z.string().optional(),
  blockNumber: z.number().optional(),
});

export const ExplorerInfoSchema = z.object({
  protocolVersion: z.number(),
  chainId: z.number(),
  version: z.string(),
  commit: z.string(),
  bundlingMode: z.string(),
  p2pEnabled: z.boolean(),
  latestSeq: z.number(),
  oldestSeq: z.number(),
  historyCapacity: z.number(),
  bootId: z.string(),
  minInclusionDenominator: z.number(),
  throttlingSlack: z.number(),
  banSlack: z.number(),
  faucetEnabled: z.boolean().optional(),
});

export const FaucetResultSchema = z.object({
  txHash: z.string(),
  /** Wei sent, as a decimal string. */
  amount: z.string(),
});

export const TransactionSummarySchema = z.object({
  txHash: z.string(),
  sender: z.string(),
  payer: z.string(),
  factory: z.string().optional(),
  nonce: z.string(),
  nonceKeys: z.array(z.string()).optional(),
  status: z.string(),
  frames: z.number(),
  maxFeePerGas: z.string(),
  submittedTime: z.number().optional(),
  lastUpdatedTime: z.number(),
  source: z.string().optional(),
});

export const TransactionEntrySchema = TransactionSummarySchema.extend({
  tx: z.record(z.string(), z.unknown()),
  revertReason: z.string().optional(),
  transaction: z.string().optional(),
});

export const TransactionDetailSchema = z.object({
  hash: z.string(),
  entry: TransactionEntrySchema.nullable(),
  admission: AdmissionRecordSchema.nullable(),
  events: z.array(LifecycleEventSchema),
});

export const PeerSchema = z.object({
  peerId: z.string(),
  direction: z.string(),
  connectedAt: z.number(),
  lastReceivedAt: z.number(),
  agentVersion: z.string().nullable(),
  supportedMempools: z.array(z.string()),
});

export const ReputationEntrySchema = z.object({
  address: z.string(),
  opsSeen: z.number(),
  opsIncluded: z.number(),
  status: z.enum(["ok", "throttled", "banned"]),
  isWhitelisted: z.boolean(),
  isBlacklisted: z.boolean(),
  stake: z.string(),
  unstakeDelaySec: z.number(),
  withdrawTime: z.string(),
  isStaked: z.boolean(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });
}

export const TransactionPageSchema = pageSchema(TransactionSummarySchema);
export const AdmissionPageSchema = pageSchema(AdmissionRecordSchema);
export const PeerListSchema = z.array(PeerSchema);
export const ReputationPageSchema = pageSchema(ReputationEntrySchema);

/** The serialized frame transaction inside `getTransaction().entry.tx`. */
export const RecentRootReferenceSchema = z.object({
  sourceId: z.string(),
  slot: z.string(),
  root: z.string(),
});

export const SerializedFrameTxSchema = z.object({
  chainId: z.string(),
  /** Pre-EIP-8250 nodes send `nonce`; current ones `nonceKeys` + `nonceSeq`. */
  nonce: z.string().optional(),
  nonceKeys: z.array(z.string()).optional(),
  nonceSeq: z.string().optional(),
  recentRootReferences: z.array(RecentRootReferenceSchema).optional(),
  sender: z.string(),
  frames: z.array(ExplorerFrameSchema),
  fees: z.object({
    maxPriorityFeePerGas: z.string(),
    maxFeePerGas: z.string(),
    maxFeePerBlobGas: z.string(),
  }),
});

export type SerializedFrameTx = z.infer<typeof SerializedFrameTxSchema>;
export type Info = z.infer<typeof ExplorerInfoSchema>;
export type TransactionSummary = z.infer<typeof TransactionSummarySchema>;
export type TransactionDetail = z.infer<typeof TransactionDetailSchema>;
export type Admission = z.infer<typeof AdmissionRecordSchema>;
export type LifecycleEventData = z.infer<typeof LifecycleEventSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type ReputationEntry = z.infer<typeof ReputationEntrySchema>;
export type Check = z.infer<typeof RuleCheckSchema>;
export type TransactionPage = z.infer<typeof TransactionPageSchema>;
export type AdmissionPage = z.infer<typeof AdmissionPageSchema>;

// Compile-time guard: each backend wire type in `@skandha/types/lib/explorer`
// must be assignable to the type these schemas infer. It fails to compile when
// the backend removes, renames or retypes a field these schemas require. It does
// NOT notice fields the backend adds: an extra field is still assignable, and
// the schemas ignore unknown keys.
type Accepts<Schema, Wire> = [Wire] extends [Schema] ? true : false;
type AllTrue<T extends boolean[]> = false extends T[number] ? false : true;
export const protocolGuards: AllTrue<
  [
    Accepts<Check, RuleCheck>,
    Accepts<Admission, AdmissionRecord>,
    Accepts<LifecycleEventData, LifecycleEvent>,
    Accepts<Info, ExplorerInfo>,
    Accepts<TransactionSummary, ExplorerTransactionSummary>,
    Accepts<TransactionDetail, ExplorerTransactionDetail>,
    Accepts<Peer, ExplorerPeer>,
    Accepts<ReputationEntry, ExplorerReputationEntry>,
  ]
> = true;
