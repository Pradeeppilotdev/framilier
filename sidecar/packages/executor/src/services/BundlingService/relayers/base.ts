import { Mutex } from "async-mutex";
import { Logger } from "@skandha/types/lib/index.js";
import { PerChainMetrics } from "@skandha/monitoring/lib/index.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { Chain, Hex, PublicClient } from "viem";
import { Config } from "../../../config.js";
import { NetworkConfig } from "../../../interfaces.js";
import { IRelayingMode } from "../interfaces.js";
import { FrameTxMempoolEntry } from "../../../entities/FrameTxMempoolEntry.js";
import { MempoolService } from "../../MempoolService/index.js";
import { ReputationService } from "../../ReputationService.js";
import { ExecutorEventBus } from "../../SubscriptionService.js";
import { getViemChainDef } from "../utils/chains.js";

/**
 * Shared scaffolding for the one relaying strategy (`PrivilegedRelayer`).
 * This sidecar is not a general-purpose bundler choosing among relay
 * strategies - it's an outsourced mempool client for one co-located,
 * trusted ethrex node, so there is exactly one way transactions leave it.
 *
 * No `entryPointService`: under EIP-8141 `ENTRY_POINT` is a protocol
 * constant observed as a frame's caller, not a contract to build calldata
 * for, so there is no `encodeHandleOps`-equivalent call to make.
 *
 * No `selectBeneficiary`: that chose who received a bundle's `handleOps`
 * refund. A frame transaction pays its own sender's/payer's fees directly;
 * the bundler is not in the payment path and has no proceeds to direct.
 *
 * No `validateBundle`: that was a pre-flight `eth_estimateGas` against the
 * constructed `{to: entryPoint, data: handleOpsCalldata}` request, useful
 * because the bundler paid for the batch it assembled, so discovering a
 * revert before submission saved real money. Relaying costs the bundler
 * nothing, a type-`0x06` transaction has no `{to, data}` shape to estimate
 * against, and a genuine frame-tx-aware pre-submission check already runs
 * upstream at admission time
 * (`FrameTxSimulationService.simulate`/`ethrex_simulateFrameTransaction`,
 * called from `eth.ts::sendFrameTransaction`). Re-implementing a weaker,
 * wrong-shaped version of it here would add nothing.
 * `networkConfig.skipBundleValidation` is consequently unread by this
 * service.
 *
 * No `handleUserOpFail`: that decoded EntryPoint's `FailedOp(index,
 * paymaster, reason)` revert to attribute a batch failure to one op among
 * many. A single relayed transaction needs no attribution, and a transport
 * failure is not evidence that any particular entity misbehaved - so no
 * `crashedHandleOps` reputation penalty is applied either. Failures now put
 * the entry back to `New`; `BundlingService`'s existing `maxSubmitAttempts`
 * gate cancels it if it keeps failing.
 *
 * No bundler wallet pool: the transaction being relayed is already signed
 * by its own sender, and the privileged ethrex endpoint authenticates
 * nothing about the caller either (see `PrivilegedRelayer`'s own doc
 * comment). `mutexes` below is a plain concurrency limiter -
 * `networkConfig.maxConcurrentSubmissions` slots, not one per signing key.
 */
export abstract class BaseRelayer implements IRelayingMode {
  protected mutexes: Mutex[];
  protected viemChain: Chain;

  constructor(
    protected logger: Logger,
    protected chainId: number,
    protected publicClient: PublicClient,
    protected config: Config,
    protected networkConfig: NetworkConfig,
    protected mempoolService: MempoolService,
    protected reputationService: ReputationService,
    protected eventBus: ExecutorEventBus,
    protected metrics: PerChainMetrics | null
  ) {
    this.mutexes = Array.from(
      { length: this.networkConfig.maxConcurrentSubmissions },
      () => new Mutex()
    );
    this.viemChain = getViemChainDef(chainId);
  }

  isLocked(): boolean {
    return this.mutexes.every((mutex) => mutex.isLocked());
  }

  sendFrameTransaction(
    _entry: FrameTxMempoolEntry,
    _rawTx: Hex
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }

  getAvailableRelayersCount(): number {
    return this.mutexes.filter((mutex) => !mutex.isLocked()).length;
  }

  async canSubmit(): Promise<boolean> {
    return true;
  }

  protected getAvailableRelayerIndex(): number | null {
    const index = this.mutexes.findIndex((mutex) => !mutex.isLocked());
    if (index === -1) {
      return null;
    }
    return index;
  }

  /**
   * A submission that failed in transit says nothing about the transaction's
   * validity - it was already validated and simulated at admission. Put it
   * back to `New` so it can be retried; `BundlingService.maxSubmitAttempts`
   * gives up eventually.
   */
  protected async handleSubmissionFailure(
    entry: FrameTxMempoolEntry,
    err: unknown
  ): Promise<void> {
    this.logger.error(err, `Failed to relay frame transaction ${entry.txHash}`);
    this.reportFailedSubmission();
    await this.setNew(entry);
  }

  // metrics
  protected reportFailedSubmission(): void {
    if (this.metrics) {
      this.metrics.bundlesFailed.inc(1);
    }
  }

  protected async setSubmitted(
    entry: FrameTxMempoolEntry,
    transaction: string
  ): Promise<void> {
    await this.mempoolService.updateStatus(
      [entry],
      MempoolEntryStatus.Submitted,
      { transaction }
    );
  }

  protected async setNew(entry: FrameTxMempoolEntry): Promise<void> {
    await this.mempoolService.updateStatus([entry], MempoolEntryStatus.New);
  }
}
