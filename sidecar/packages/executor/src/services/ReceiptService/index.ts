/**
 * "Watching for a mined frame transaction's outcome" means fetching its
 * protocol-native receipt directly, not filtering `UserOperationEvent` log
 * topics against a deployed EntryPoint contract - there is no such
 * contract/event for a frame transaction. Per EIP-8141 §Receipt Encoding,
 * the receipt itself carries `payer`/per-frame `status`/`gasUsed`, so a
 * single `eth_getTransactionReceipt` call is the whole job.
 *
 * `eth_getTransactionReceipt` is a standard, unmodified JSON-RPC method -
 * unlike `ethrex_simulateFrameTransaction`, there is no new
 * `GethTracer`-style wrapper needed here.
 *
 * Deliberately uses `publicClient.request()` (the raw JSON-RPC escape
 * hatch) rather than viem's own `publicClient.getTransactionReceipt()`:
 * viem's typed accessor parses the response into its own `TransactionReceipt`
 * shape and would silently drop the two EIP-8141-specific fields
 * (`payer`/`frameReceipts`) it has no knowledge of. `.request()` returns
 * ethrex's raw JSON response untouched, which is what `EthrexFrameTxReceipt`
 * (mirroring ethrex's `crates/networking/rpc/types/receipt.rs`) types.
 *
 * Hex-decoding convention: every gas amount (`cumulativeGasUsed`, each
 * frame's `gasUsed`/`stateGasUsed`) is decoded to `bigint` on this service's
 * output type (`FrameTxReceipt`) - not left as a hex string. This diverges
 * from the sibling `FrameTxSimulationService`/`FrameTxSimulationResult`,
 * which keeps every such field as a hex string throughout. `bigint` is used
 * here because a mined receipt is meant to be the authoritative source
 * callers do real gas arithmetic against (fee/refund calculations,
 * comparisons against `maxCost`, etc.), unlike the simulation-time result.
 * `payer`/addresses stay hex strings (they are not numeric amounts); `logs`
 * are passed through unchanged (decoding a full `Log` shape is out of scope
 * - no consumer needs it yet).
 */
import { Hex, PublicClient } from "viem";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { EthrexFrameTxReceipt } from "@skandha/types/lib/executor/validation/ethrexFrameTxReceipt.js";
import {
  FrameReceiptStatus,
  FrameTxReceipt,
} from "@skandha/types/lib/executor/validation/frameTxReceipt.js";

/**
 * `EthrexFrameReceipt.status` decoding: `0x0`/`0x1`/`0x2` are ethrex's
 * `FRAME_RECEIPT_STATUS_{FAILURE,SUCCESS,SKIPPED}` (a hex BYTE - see
 * ethrexFrameTxReceipt.ts's header comment).
 */
const FRAME_RECEIPT_STATUS_BY_WIRE_VALUE: Record<string, FrameReceiptStatus> = {
  "0x0": "reverted",
  "0x1": "success",
  "0x2": "skipped",
};

function decodeFrameReceiptStatus(wireStatus: string): FrameReceiptStatus {
  const decoded = FRAME_RECEIPT_STATUS_BY_WIRE_VALUE[wireStatus];
  if (decoded == null) {
    throw new RpcError(
      `unknown frame receipt status ${wireStatus}`,
      RpcErrorCodes.SERVER_ERROR
    );
  }
  return decoded;
}

/**
 * Whole-transaction `status` decoding - the standard Ethereum receipt
 * success/failure bit (`"0x0"`/`"0x1"`), NOT the same field/encoding as a
 * per-frame `EthrexFrameReceipt.status` byte above (which has a third
 * value, `"0x2"`/skipped). Kept as its own function rather than reusing
 * `decodeFrameReceiptStatus` so the return type can't include `"skipped"`,
 * a state this field never actually takes.
 */
function decodeTransactionStatus(wireStatus: string): "success" | "reverted" {
  if (wireStatus === "0x1") return "success";
  if (wireStatus === "0x0") return "reverted";
  throw new RpcError(
    `unknown transaction receipt status ${wireStatus}`,
    RpcErrorCodes.SERVER_ERROR
  );
}

export class ReceiptService {
  constructor(private publicClient: PublicClient) {}

  async getReceipt(txHash: Hex): Promise<FrameTxReceipt> {
    const raw = (await this.publicClient.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as EthrexFrameTxReceipt | null;

    // A `null` response is standard JSON-RPC for "no receipt yet" - the
    // hash is either unknown or its transaction hasn't mined. Fail loudly
    // rather than returning `null`/a hollow `FrameTxReceipt`: this method's
    // signature promises a real receipt.
    if (raw == null) {
      throw new RpcError(
        `transaction receipt not found for ${txHash}`,
        RpcErrorCodes.SERVER_ERROR
      );
    }

    // A frame tx always has `payer`/`frameReceipts` set, per ethrex's
    // `Receipt::new` - but `txHash` could legitimately belong to a
    // non-frame transaction, whose receipt omits
    // both fields entirely (`#[serde(skip_serializing_if)]`). Reject that
    // explicitly rather than returning a `FrameTxReceipt` with a garbage
    // `payer`/empty `frameReceipts`.
    if (raw.payer == null || raw.frameReceipts == null) {
      throw new RpcError(
        `transaction ${txHash} is not a frame transaction (its receipt has no payer/frameReceipts)`,
        RpcErrorCodes.SERVER_ERROR
      );
    }

    return {
      cumulativeGasUsed: BigInt(raw.cumulativeGasUsed),
      payer: raw.payer,
      blockNumber: BigInt(raw.blockNumber),
      status: decodeTransactionStatus(raw.status),
      frameReceipts: raw.frameReceipts.map((frame) => ({
        status: decodeFrameReceiptStatus(frame.status),
        gasUsed: {
          execution: BigInt(frame.gasUsed),
          state: BigInt(frame.stateGasUsed),
        },
        logs: frame.logs,
      })),
    };
  }
}
