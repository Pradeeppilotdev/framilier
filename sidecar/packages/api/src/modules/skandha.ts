import {
  GetConfigResponse,
  GetGasPriceResponse,
} from "@skandha/types/lib/api/interfaces";
import { Skandha } from "@skandha/executor/lib/modules";
import { FrameTransactionStatus } from "@skandha/executor/lib/modules/interfaces.js";

/**
 * the sidecar's custom RPC surface, wrapping `packages/executor`'s `Skandha`
 * module.
 *
 * `getFeeHistory` is dropped entirely, not just renamed - see
 * `packages/executor/src/modules/skandha.ts`'s own header comment for why
 * no EIP-8141 analogue exists (no multi-EntryPoint dispatch, no
 * `handleOps` calldata to decode, no `UserOperationEvent` log to filter
 * for). `skandha_feeHistory`'s RPC entry is removed from `constants.ts`/
 * `app.ts` too. This class no longer takes an `Eth` module - `getFeeHistory`
 * was its only use of one (to call `validateEntryPoint` on
 * `args.entryPoint`, itself deleted).
 */
export class SkandhaAPI {
  constructor(private skandhaModule: Skandha) {}

  /**
   * Replaces the old `getUserOperationStatus`.
   * @param hash the frame transaction's own hash.
   */
  async getFrameTransactionStatus(
    hash: string
  ): Promise<FrameTransactionStatus> {
    return this.skandhaModule.getFrameTransactionStatus(hash);
  }

  async getGasPrice(): Promise<GetGasPriceResponse> {
    return await this.skandhaModule.getGasPrice();
  }

  async getConfig(): Promise<GetConfigResponse> {
    return await this.skandhaModule.getConfig();
  }

  connectedPeers(): unknown[] {
    return this.skandhaModule.connectedPeers();
  }
}
