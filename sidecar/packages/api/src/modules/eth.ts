import { Eth } from "@skandha/executor/lib/modules/eth.js";
import { FrameGasEstimate } from "@skandha/executor/lib/modules/interfaces.js";
import { FrameTxMempoolEntrySerialized } from "@skandha/executor/lib/entities/interfaces.js";
import { FrameTxReceipt } from "@skandha/types/lib/executor/validation/frameTxReceipt.js";
import { Hex } from "viem";
import { RpcMethodValidator } from "../utils/RpcMethodValidator.js";
import { FrameTransactionDto } from "../dto/SendFrameTransaction.dto.js";
import { EstimateFrameTransactionArgs } from "../dto/EstimateFrameTransaction.dto.js";
import { toFrameTransaction, toPartialFrameTransaction } from "../utils/frameTx.js";

/**
 * The `eth_*` RPC surface for EIP-8141 frame transactions - see
 * `packages/executor/src/modules/eth.ts` for the method-by-method rationale
 * this wraps.
 *
 * `getSupportedEntryPoints` is dropped entirely, not just renamed: there is
 * exactly one fixed `ENTRY_POINT` sentinel address under EIP-8141, not a
 * configurable/validated set.
 */
export class EthAPI {
  constructor(private ethModule: Eth) {}

  /**
   * @param tx a full, signed frame transaction (hex-string wire shape, see
   *   `SendFrameTransaction.dto.ts`).
   * @returns the transaction's own hash.
   */
  @RpcMethodValidator(FrameTransactionDto)
  async sendFrameTransaction(tx: FrameTransactionDto): Promise<Hex> {
    return await this.ethModule.sendFrameTransaction(toFrameTransaction(tx));
  }

  /**
   * Estimates gas for a (possibly partial/unsigned) frame transaction.
   * `Eth.estimateFrameTransactionGas` covers both dummy-signature and
   * real-signature estimation with a single method, so there is no
   * `testingMode` branch needed at the `app.ts` dispatch layer.
   */
  @RpcMethodValidator(EstimateFrameTransactionArgs)
  async estimateFrameTransactionGas(
    tx: EstimateFrameTransactionArgs
  ): Promise<FrameGasEstimate> {
    return await this.ethModule.estimateFrameTransactionGas(
      toPartialFrameTransaction(tx)
    );
  }

  /**
   * @param hash the frame transaction's own hash.
   * @returns the mempool entry (serialized) if still known to this node's
   *   mempool, `null` otherwise. Unlike the old `getUserOperationByHash`,
   *   there is no EntryPoint-event-log/Blockscout fallback for a
   *   transaction already pruned after mining - documented gap, see
   *   `Eth.getFrameTransactionByHash`'s own doc comment.
   */
  async getFrameTransactionByHash(
    hash: Hex
  ): Promise<FrameTxMempoolEntrySerialized | null> {
    return await this.ethModule.getFrameTransactionByHash(hash);
  }

  /**
   * @param hash the frame transaction's own hash.
   * @returns a full `FrameTxReceipt`.
   *
   * Deliberately NOT translated into a `null` response on "not found":
   * `ReceiptService.getReceipt` throws the same `RpcError`/
   * `RpcErrorCodes.SERVER_ERROR` for both "not yet mined" and "not a frame
   * transaction", distinguishable only by message text. Catching and
   * string-matching that message here to synthesize a `null` would be
   * fragile; letting the `RpcError` surface as a JSON-RPC error instead
   * means a polling client treats it the same way it would have treated
   * `null` (retry later), but gets a real reason in `error.message` instead
   * of an ambiguous `null`.
   */
  async getFrameTransactionReceipt(hash: Hex): Promise<FrameTxReceipt> {
    return await this.ethModule.getFrameTransactionReceipt(hash);
  }

  /**
   * eth_chainId
   * @returns EIP-155 Chain ID.
   */
  async getChainId(): Promise<number> {
    return await this.ethModule.getChainId();
  }
}
