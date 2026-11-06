import { PerChainMetrics } from "@skandha/monitoring/lib/index.js";
import { Logger } from "@skandha/types/lib/index.js";
import { BundlingMode } from "@skandha/types/lib/api/interfaces";
import { recentRootWindowViolation } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  MempoolEntryStatus,
  ReputationStatus,
} from "@skandha/types/lib/executor";
import {
  GasPriceMarkupOne,
  chainsWithoutEIP1559,
  getGasFee,
} from "@skandha/params/lib/index.js";
import { IGetGasFeeResult } from "@skandha/params/lib/gas-price-oracles/oracles/index.js";
import { Mutex } from "async-mutex";
import { Hex, keccak256, PublicClient } from "viem";
import { Config } from "../../config.js";
import { NetworkConfig } from "../../interfaces.js";
import { MempoolService } from "../MempoolService/index.js";
import { ReputationService } from "../ReputationService.js";
import { wait } from "../../utils/index.js";
import { getHeadSlot } from "../../utils/headSlot.js";
import { FrameTxMempoolEntry } from "../../entities/FrameTxMempoolEntry.js";
import { encodeRawFrameTx } from "../FrameTxService/codec.js";
import { ExecutorEventBus } from "../SubscriptionService.js";
import { ReceiptService } from "../ReceiptService/index.js";
import { FrameTxSimulationService } from "../FrameTxSimulationService/index.js";
import { IRelayingMode } from "./interfaces.js";
import { PrivilegedRelayer } from "./relayers/index.js";
import { MempoolReconciler } from "./reconciliation.js";

/**
 * Slots a relayed transaction may need to land. An EIP-8272 reference that
 * leaves the usable window sooner is not relayed (`expiresBeforeInclusion`).
 */
const RELAY_ROOT_EXPIRY_MARGIN_SLOTS = BigInt(2);

/**
 * Drains the frame-transaction mempool by relaying each transaction
 * individually.
 *
 * There is no batch to assemble here, unlike ERC-4337's `handleOps(ops,
 * beneficiary)` bundling (which averaged fee parameters across N user
 * operations, merged their validation storage maps into an EIP-2930 access
 * list, tracked paymaster deposits so one paymaster could not
 * over-sponsor a batch, and de-duplicated senders within a transaction) -
 * all of that exists only because multiple operations shared one
 * bundler-signed transaction.
 *
 * An EIP-8141 frame transaction IS a transaction. It arrives already signed
 * by its own sender, carries its own `fees` and per-frame `limits`, and
 * pays for itself; the bundler is a relay, not a payer, and has nothing to
 * assemble. This service is a cron that picks up new entries, refuses ones
 * whose fees are too low to be worth relaying, skips ones whose payer or
 * factory is banned, and hands each to the one relaying strategy
 * (`PrivilegedRelayer`) - one transaction per call.
 *
 * The class name is kept because `Debug`/`debug_bundler_*` RPC, the executor's
 * wiring and the CLI's `--executor.bundlingMode` flag all still address it by
 * that name; renaming it is a separate, wider change.
 *
 * There is no re-simulation of an entry immediately before relay, and this
 * is not a gap: that pattern (ERC-4337's bundler re-validating right before
 * including an op in its own `handleOps` batch) existed to protect the
 * bundler's own submitted, self-paid transaction from going stale between
 * admission and inclusion. This service has no such transaction to protect
 * - it relays each frame transaction's own already-signed bytes via
 * `ethrex_submitPrivilegedFrameTransaction` unmodified (see
 * `relayers/privileged.ts`), and that transaction pays its own fees. If it reverts
 * on-chain, that is `tx.sender`'s own outcome, exactly like any ordinary
 * Ethereum transaction reverting - there is nothing here for a bundler-side
 * re-simulation to protect against. Validation and simulation still run
 * once, at admission time, in `eth.ts::sendFrameTransaction`.
 *
 * A DIFFERENT, real gap - mempool/network hygiene rather than bundler-batch
 * staleness - is handled by `reconciler` (`MempoolReconciler`,
 * `reconciliation.ts`), run once per newly observed block from `tryBundle`
 * before each `sendNextBundle` pass: it detects actual on-chain inclusion
 * for `Submitted` entries (replacing `BaseRelayer`'s old, broken
 * `waitForEntry` polling loop) and re-validates `New` entries against newly
 * mined state. See that class's doc comment for both.
 */
export class BundlingService {
  private mutex: Mutex;
  private bundlingMode: BundlingMode;
  private autoBundlingInterval: number;
  private autoBundlingCron?: NodeJS.Timeout;
  private maxBundleSize: number;
  private networkConfig: NetworkConfig;
  private relayer: IRelayingMode;
  private reconciler: MempoolReconciler;

  constructor(
    private chainId: number,
    private publicClient: PublicClient,
    private mempoolService: MempoolService,
    private reputationService: ReputationService,
    private eventBus: ExecutorEventBus,
    private config: Config,
    private logger: Logger,
    private metrics: PerChainMetrics | null,
    receiptService: ReceiptService,
    frameTxSimulationService: FrameTxSimulationService
  ) {
    this.mutex = new Mutex();
    this.networkConfig = config.getNetworkConfig();

    this.relayer = new PrivilegedRelayer(
      this.logger,
      this.chainId,
      this.publicClient,
      this.config,
      this.networkConfig,
      this.mempoolService,
      this.reputationService,
      this.eventBus,
      this.metrics
    );

    this.reconciler = new MempoolReconciler(
      this.mempoolService,
      receiptService,
      frameTxSimulationService,
      this.publicClient,
      this.networkConfig,
      this.metrics,
      this.logger
    );

    this.bundlingMode = "auto";
    this.autoBundlingInterval = this.networkConfig.bundleInterval;
    this.maxBundleSize = this.networkConfig.bundleSize;
    this.restartCron();
  }

  /** How many transactions one `sendNextBundle` pass will pick up. */
  setMaxBundleSize(size: number): void {
    this.maxBundleSize = size;
    this.restartCron();
  }

  getBundlingMode(): BundlingMode {
    return this.bundlingMode;
  }

  setBundlingMode(mode: BundlingMode): void {
    this.bundlingMode = mode;
    this.restartCron();
  }

  setBundlingInverval(interval: number): void {
    if (interval > 1) {
      this.autoBundlingInterval = interval * 1000;
      this.restartCron();
    }
  }

  /**
   * Relays ONE already-signed frame transaction through the configured
   * strategy.
   *
   * The returned hash is computed here, from the transaction's own canonical
   * EIP-2718 bytes, exactly as `eth.ts::sendFrameTransaction` and
   * `debug.ts::setMempool` compute it. It is deliberately not taken from the
   * relayer: the hash is a pure function of the signed bytes and is
   * therefore knowable without asking anyone, whereas the privileged
   * endpoint's own response is not authoritative over the transaction's
   * identity (see `IRelayingMode.sendFrameTransaction`'s doc comment).
   *
   * The relayer's send is deliberately not awaited outside `testingMode`, so
   * this call marks the entry `Pending` on the assumption that a relayer
   * wallet slot is free for it. A caller must therefore not invoke this more
   * times in a row than `relayer.getAvailableRelayersCount()` reported free -
   * see `sendNextBundle`, which is currently the only caller and enforces
   * exactly that.
   */
  async submitFrameTransaction(entry: FrameTxMempoolEntry): Promise<Hex> {
    const rawTx = encodeRawFrameTx(entry.tx);
    const txHash = keccak256(rawTx);

    await this.mempoolService.updateStatus(
      [entry],
      MempoolEntryStatus.Pending
    );
    await this.mempoolService.attemptToBundle([entry]);

    this.metrics?.useropsAttempted.inc();

    if (this.config.testingMode) {
      // need to wait for the tx hash during testing
      await this.relayer.sendFrameTransaction(entry, rawTx).catch((err) => {
        this.logger.error(err);
      });
    } else {
      void this.relayer.sendFrameTransaction(entry, rawTx).catch((err) => {
        this.logger.error(err);
      });
    }

    return txHash;
  }

  /**
   * Relays up to `maxBundleSize` new mempool entries, one transaction per
   * relayer wallet slot. Kept under this name because
   * `debug_bundler_sendBundleNow` calls it.
   *
   * The number of transactions dispatched in one pass is bounded by the number
   * of relayer wallet slots that are free when the pass starts, because
   * dispatch is fire-and-forget: `submitFrameTransaction` marks the entry
   * `Pending` and does not await the relayer's send. Every strategy claims a
   * slot with its own `getAvailableRelayerIndex()` and silently returns when
   * the pool is exhausted, so an entry dispatched without a slot to run on
   * would be marked `Pending` and then never broadcast - and never reselected,
   * since `getNewEntriesSorted` only returns `New` entries. Respecting the
   * budget here is what keeps the `Pending` mark and the slot claim from
   * diverging: this pass is the only claimant (`sendNextBundle` is serialised
   * by `this.mutex`, and slots held by earlier passes are already excluded
   * from the count), and it claims at most one slot per dispatch, so a free
   * slot is guaranteed to exist for every entry it marks `Pending`. What it
   * cannot dispatch it leaves untouched at `New` for the next tick.
   *
   * `maxBundleSize` (`networkConfig.bundleSize`) therefore no longer means
   * "operations packed into one transaction" - there are no bundles to pack.
   * It now caps how many transactions a single pass will pick up, so the
   * effective per-pass limit is `min(bundleSize, free relayer wallets)`.
   */
  async sendNextBundle(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!(await this.relayer.canSubmit())) {
        this.logger.debug("Relayer: Can not submit yet");
        return;
      }
      const availableSlots = this.relayer.getAvailableRelayersCount();
      if (availableSlots <= 0) {
        this.logger.debug("Relayers are busy");
        return;
      }

      const entries = await this.selectEntries();
      if (!entries.length) return;

      // Only the `enforceGasPrice` check consults network gas prices now.
      // The bundler no longer builds a transaction of its own, so there is
      // nothing else to price and no reason to make the call otherwise.
      let gasFee: IGetGasFeeResult | null = null;
      if (this.networkConfig.enforceGasPrice) {
        gasFee = await this.getGasFee();
        if (!gasFee) return;
      }

      const headSlot = entries.some((e) => e.tx.recentRootReferences.length > 0)
        ? await getHeadSlot(this.publicClient).catch(() => undefined)
        : undefined;

      let dispatched = 0;
      for (const entry of entries) {
        if (dispatched >= availableSlots) {
          this.logger.debug(
            `All ${availableSlots} relayer(s) busy, leaving the remaining transactions for the next pass`
          );
          break;
        }
        // a declined entry never reaches a relayer, so it costs no slot
        if (!(await this.shouldRelay(entry, gasFee))) continue;
        if (this.expiresBeforeInclusion(entry, headSlot)) continue;
        await this.submitFrameTransaction(entry);
        dispatched++;
      }

      if (dispatched > 0) {
        this.logger.debug("Relayed pending frame transactions...");

        // during testing against spec-tests we need to wait the block to be submitted
        if (this.config.testingMode) {
          await wait(500);
        }
      }
    });
  }

  /**
   * EIP-8272: whether an entry's recent-root reference leaves the usable
   * window before a relayed transaction could realistically land
   * (`RELAY_ROOT_EXPIRY_MARGIN_SLOTS` from now). Such an entry is not relayed
   * - ethrex would only try and drop it - and stays `New` until the
   * reconciler cancels it on actual expiry. `false` without a head slot.
   */
  private expiresBeforeInclusion(
    entry: FrameTxMempoolEntry,
    headSlot: bigint | undefined
  ): boolean {
    if (headSlot === undefined || entry.tx.recentRootReferences.length === 0) {
      return false;
    }
    const violation = recentRootWindowViolation(
      entry.tx.recentRootReferences,
      headSlot + RELAY_ROOT_EXPIRY_MARGIN_SLOTS
    );
    if (violation !== null) {
      this.logger.debug(
        { txHash: entry.txHash, violation },
        "not relaying: recent root expires before it could be included"
      );
    }
    return violation !== null;
  }

  /**
   * Fetches new entries, dropping any that have already been relayed too many
   * times without landing.
   */
  private async selectEntries(): Promise<FrameTxMempoolEntry[]> {
    let entries = await this.mempoolService.getNewEntriesSorted(
      this.maxBundleSize
    );
    // keeps transactions from the same sender adjacent, so their nonces are
    // relayed in the order they were queued
    entries = FrameTxMempoolEntry.groupBySender(entries);
    if (!entries.length) {
      this.logger.debug("No new entries");
      return [];
    }

    const invalidEntries = entries.filter(
      (entry) => entry.submitAttempts > this.networkConfig.maxSubmitAttempts
    );
    if (invalidEntries.length > 0) {
      this.logger.debug(
        `Found ${invalidEntries.length} that reached max submit attempts, deleting them...`
      );
      this.logger.debug(
        invalidEntries.map((entry) => entry.txHash).join("; ")
      );
      for (const entry of invalidEntries) {
        await this.mempoolService.updateStatus(
          [entry],
          MempoolEntryStatus.Cancelled,
          {
            revertReason: `relayed ${entry.submitAttempts} times without being included in a block`,
          }
        );
      }
      entries = await this.mempoolService.getNewEntriesSorted(
        this.maxBundleSize
      );
    }
    if (!entries.length) {
      this.logger.debug("No entries left");
    }
    return entries;
  }

  /**
   * Per-entry admission checks that still make sense for a relay. What is left
   * of `createBundle`: refuse transactions whose signed fees are below what
   * the network is currently charging (they would sit unmined and waste a
   * submission slot), and refuse ones whose payer or factory is banned.
   *
   * Gone with the batch: sender de-duplication, cross-entry storage-conflict
   * detection, paymaster deposit accounting and per-batch gas-limit packing.
   */
  private async shouldRelay(
    entry: FrameTxMempoolEntry,
    gasFee: IGetGasFeeResult | null
  ): Promise<boolean> {
    if (this.networkConfig.enforceGasPrice && gasFee) {
      let { maxPriorityFeePerGas, maxFeePerGas } = gasFee;
      const { enforceGasPriceThreshold } = this.networkConfig;
      if (
        !this.networkConfig.eip1559 ||
        chainsWithoutEIP1559.some((chainId: number) => chainId === this.chainId)
      ) {
        maxFeePerGas = maxPriorityFeePerGas = gasFee.gasPrice;
      }
      // tx max fee per gas = tx.fees.maxFeePerGas * (100 + threshold) / 100;
      const txMaxFeePerGas =
        (entry.tx.fees.maxFeePerGas * GasPriceMarkupOne +
          BigInt(enforceGasPriceThreshold)) /
        GasPriceMarkupOne;
      const txMaxPriorityFeePerGas =
        (entry.tx.fees.maxPriorityFeePerGas * GasPriceMarkupOne +
          BigInt(enforceGasPriceThreshold)) /
        GasPriceMarkupOne;
      if (
        txMaxFeePerGas < BigInt(maxFeePerGas!) ||
        txMaxPriorityFeePerGas < BigInt(maxPriorityFeePerGas!)
      ) {
        this.logger.debug(
          {
            sender: entry.tx.sender,
            nonceKeys: entry.tx.nonceKeys.map(String),
            nonceSeq: entry.tx.nonceSeq.toString(),
            txMaxFeePerGas: txMaxFeePerGas.toString(),
            txMaxPriorityFeePerGas: txMaxPriorityFeePerGas.toString(),
            maxFeePerGas: maxFeePerGas!.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas!.toString(),
          },
          "Skipping frame transaction with low gas price"
        );
        return false;
      }
    }

    // `payer`/`factory` replace ERC-4337's `paymaster`/`factory`; there is no
    // aggregator concept for a frame transaction. See `FrameTxMempoolEntry`.
    const entities = {
      payer: entry.payer,
      factory: entry.factory,
    };
    for (const [title, entity] of Object.entries(entities)) {
      if (!entity) continue;
      // a self-paying transaction is not a separate "payer" entity
      if (title === "payer" && entity === entry.sender) continue;
      const status = await this.reputationService.getStatus(entity);
      if (status === ReputationStatus.BANNED) {
        this.logger.debug(
          `${title} - ${entity} is banned. Cancelling ${entry.txHash}...`
        );
        await this.mempoolService.updateStatus(
          [entry],
          MempoolEntryStatus.Cancelled,
          { revertReason: `${title} - ${entity} is banned.` }
        );
        return false;
      }
      if (status === ReputationStatus.THROTTLED) {
        this.logger.debug(
          { sender: entry.tx.sender, nonceSeq: entry.tx.nonceSeq, entity },
          `skipping throttled ${title}`
        );
        return false;
      }
    }

    return true;
  }

  /** Current network gas prices, with the configured markup applied. */
  private async getGasFee(): Promise<IGetGasFeeResult | null> {
    const multiplier = this.networkConfig.gasPriceMarkup;
    const gasFee = await getGasFee(
      this.chainId,
      this.publicClient,
      this.networkConfig.etherscanApiKey
    );
    let { maxPriorityFeePerGas, maxFeePerGas } = gasFee;
    if (maxPriorityFeePerGas === undefined || maxFeePerGas === undefined) {
      try {
        const gasPrice = await this.publicClient.getGasPrice();
        maxPriorityFeePerGas = gasPrice;
        maxFeePerGas = gasPrice;
      } catch (err) {
        this.logger.debug("Could not fetch gas prices...");
        return null;
      }
    }
    if (multiplier && multiplier !== 0) {
      const bnMultiplier = GasPriceMarkupOne + BigInt(multiplier);
      maxFeePerGas = (bnMultiplier * BigInt(maxFeePerGas)) / GasPriceMarkupOne;
      maxPriorityFeePerGas =
        (bnMultiplier * BigInt(maxPriorityFeePerGas)) / GasPriceMarkupOne;
    }
    gasFee.maxFeePerGas = maxFeePerGas;
    gasFee.maxPriorityFeePerGas = maxPriorityFeePerGas;
    if (
      gasFee.gasPrice == undefined &&
      gasFee.maxFeePerGas == undefined &&
      gasFee.maxPriorityFeePerGas == undefined
    ) {
      this.logger.debug("Could not fetch gas prices...");
      return null;
    }
    return gasFee;
  }

  /**
   * Test-only hook: see `PrivilegedRelayer.setTargetBlock`'s own doc comment
   * for what this does and why. No-op if the configured relayer isn't a
   * `PrivilegedRelayer` (never true today - "the only relaying strategy" -
   * kept defensive so this stays harmless if that ever changes).
   */
  setPrivilegedRelayTargetBlock(txHash: Hex, targetBlock: bigint): void {
    if (this.relayer instanceof PrivilegedRelayer) {
      this.relayer.setTargetBlock(txHash, targetBlock);
    }
  }

  /** Stops the cron (shutdown, tests). `setBundlingMode`/`setBundlingInverval` start it again. */
  stop(): void {
    if (this.autoBundlingCron) {
      clearInterval(this.autoBundlingCron);
      this.autoBundlingCron = undefined;
    }
  }

  /**
   * The cron runs in every mode: following the chain (inclusion detection and
   * revalidation) is not relaying. Only `auto` mode also relays.
   */
  private restartCron(): void {
    this.stop();
    this.autoBundlingCron = setInterval(() => {
      void this.tryBundle();
    }, this.autoBundlingInterval);
  }

  private async tryBundle(): Promise<void> {
    await this.reconciler.reconcile().catch((err) => this.logger.error(err));
    if (this.bundlingMode !== "auto") {
      return;
    }
    await this.sendNextBundle().catch((err) => this.logger.error(err));
  }
}
