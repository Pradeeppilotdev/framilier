import { SerializedFrameTxSchema, type Check, type SerializedFrameTx } from "../protocol/schemas";
import { hexToBigInt } from "./format";

export type Entity = NonNullable<Check["entity"]>;

/** Frame `mode` values from EIP-8141 (see `FRAME_MODE` in the backend). */
const MODE_DEFAULT = 0;
const MODE_VERIFY = 1;
const MODE_SENDER = 2;

/** Bits 0-1 of `flags` are the approval scope; bit 2 makes a frame atomic with the next one. */
const SCOPE_MASK = 0x3;
const ATOMIC_BATCH_FLAG = 0x4;

export type Scope = "none" | "payment" | "execution" | "execution and payment";

export function scopeOf(flags: number): Scope {
  switch (flags & SCOPE_MASK) {
    case 1:
      return "payment";
    case 2:
      return "execution";
    case 3:
      return "execution and payment";
    default:
      return "none";
  }
}

export function modeName(mode: number): string {
  switch (mode) {
    case MODE_DEFAULT:
      return "default";
    case MODE_VERIFY:
      return "verify";
    case MODE_SENDER:
      return "sender";
    default:
      return "unknown";
  }
}

/** What a frame is for, from its mode, approval scope and (for a DEFAULT-mode frame) entity. */
export function frameRole(mode: number, flags: number, entity?: Entity): string {
  if (mode === MODE_VERIFY) {
    switch (flags & SCOPE_MASK) {
      case 1:
        return "payment approval";
      case 2:
        return "execution approval";
      case 3:
        return "self-verification";
      default:
        return "expiry check";
    }
  }
  if (mode === MODE_SENDER) return "user operation";
  if (mode === MODE_DEFAULT) {
    if (entity === "factory") return "deploy";
    if (entity === "sender" || entity === "payer") return "pre-validation write";
    return "deploy or post-operation";
  }
  return "unknown frame";
}

/** Reads the serialized transaction from `getTransaction`; null when it is not the expected shape. */
export function parseFrameTx(tx: unknown): SerializedFrameTx | null {
  const parsed = SerializedFrameTxSchema.safeParse(tx);
  return parsed.success ? parsed.data : null;
}

/** Which entity (sender, payer or factory) the validator attached to each frame index. */
export function entitiesByFrame(checks: Check[]): Map<number, Entity> {
  const result = new Map<number, Entity>();
  for (const check of checks) {
    if (check.frameIndex !== undefined && check.entity !== undefined) {
      result.set(check.frameIndex, check.entity);
    }
  }
  return result;
}

export type WireFrame = SerializedFrameTx["frames"][number];
export type FrameRunStatus = "success" | "reverted" | "not-run";

export interface FrameView {
  index: number;
  mode: number;
  modeName: string;
  role: string;
  scope: Scope;
  atomic: boolean;
  entity: Entity | undefined;
  target: string | null;
  executionGas: bigint;
  stateGas: bigint;
  value: bigint;
  dataBytes: number;
  status?: FrameRunStatus;
}

/** `statuses`, when given, is index-aligned with `frames` (see `AdmissionRecord.frameStatuses`). */
export function describeFrames(frames: WireFrame[], checks: Check[], statuses?: FrameRunStatus[]): FrameView[] {
  const entities = entitiesByFrame(checks);
  return frames.map((frame, index) => ({
    index,
    mode: frame.mode,
    modeName: modeName(frame.mode),
    role: frameRole(frame.mode, frame.flags, entities.get(index)),
    scope: scopeOf(frame.flags),
    atomic: (frame.flags & ATOMIC_BATCH_FLAG) !== 0,
    entity: entities.get(index),
    target: frame.target,
    executionGas: hexToBigInt(frame.limits.execution),
    stateGas: hexToBigInt(frame.limits.state),
    value: hexToBigInt(frame.value),
    dataBytes: Math.max(0, Math.floor((frame.data.length - 2) / 2)),
    status: statuses?.[index],
  }));
}
