import { Logger } from "@skandha/types/lib/index.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { NetworkConfig } from "../../interfaces.js";
import os from "node:os";

export type SchedulerMode = "off" | "fifo" | "fair";

export interface AdmissionSchedulerOptions {
  mode?: SchedulerMode;
  slots?: number | "auto";
  maxHeavyPerSender?: number;
  maxHeavyPerSponsor?: number;
  maxWaiting?: number;
  maxWaitingPerSender?: number;
  heavyThreshold?: number | bigint;
  enableDRR?: boolean;       // Enable Deficit Round Robin gas weighting
  drrQuantum?: number | bigint; // DRR gas credit per round (default 200,000)
}

export interface AdmissionJobMeta {
  sender: string;
  sponsor?: string;              // Level 1: Collateral / Paymaster / Staker entity
  declaredGas?: bigint | number; // Exact declared verify gas
  isHeavy?: boolean;
}

export type SubmitSenderParam = string | AdmissionJobMeta;

export interface QueuedJob<T = any> {
  id: number;
  sender: string;
  sponsor: string;
  declaredGas: bigint;
  isHeavy: boolean;
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

interface SponsorQueue {
  sponsor: string;
  senders: Map<string, QueuedJob[]>; // Level 2: sender address => FIFO queue of jobs
  waitingSenders: string[];          // Level 2 round-robin order of senders
  lastDispatchedSender: string | null;
  activeHeavy: number;
  activeTotal: number;
  deficitCredit: bigint;             // DRR accumulated gas credit
}

function checkedLimit(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Admission scheduler ${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

/**
 * Framilier 2.0: Hierarchical Deficit Round Robin (H-FQ + DRR) Admission Scheduler.
 *
 * Implements:
 * 1. Two-Level Hierarchical Queuing (Level 1: Sponsor/Paymaster, Level 2: Sender Wallet).
 *    - Eliminates Sybil multi-wallet burner attacks via sponsor collateral anchoring.
 *    - Eliminates shared-paymaster starvation by interleaving wallets under the same sponsor.
 * 2. Deficit Round Robin (DRR) Gas Weighting:
 *    - Eliminates the binary 100k step-function penalty; paces work proportionally to true declared gas.
 * 3. Dynamic Auto-Tuned Concurrency:
 *    - Adapts slot capacity to host CPU cores when configured with "auto".
 */
export class AdmissionScheduler {
  public readonly mode: SchedulerMode;
  public readonly slots: number;
  public readonly maxHeavyPerSender: number;
  public readonly maxHeavyPerSponsor: number;
  public readonly maxWaiting: number;
  public readonly maxWaitingPerSender: number;
  public readonly heavyThreshold: bigint;
  public readonly enableDRR: boolean;
  public readonly drrQuantum: bigint;

  private runningCount: number = 0;
  private waitingCount: number = 0;
  private waitingPerSender = new Map<string, number>();
  private nextJobId: number = 1;

  // FIFO mode queue
  private fifoQueue: QueuedJob[] = [];

  // Hierarchical Fair Mode state (Level 1: Sponsors)
  private sponsorQueues: Map<string, SponsorQueue> = new Map();
  private waitingSponsorOrder: string[] = [];
  private lastDispatchedSponsor: string | null = null;

  constructor(
    opts: Partial<NetworkConfig> & AdmissionSchedulerOptions = {},
    _logger?: Logger
  ) {
    const rawMode = opts.schedulerMode ?? opts.mode ?? "off";
    const mode = String(rawMode).toLowerCase();
    if (mode !== "off" && mode !== "fifo" && mode !== "fair") {
      throw new Error(`Unknown admission scheduler mode: ${mode}`);
    }
    this.mode = mode as SchedulerMode;

    const rawSlots = opts.schedulerSlots ?? opts.slots ?? 4;
    if (rawSlots === "auto") {
      const cpus = os.cpus()?.length || 4;
      this.slots = Math.max(2, Math.min(32, cpus));
    } else {
      this.slots = checkedLimit("slots", Number(rawSlots), 1);
    }

    this.maxHeavyPerSender = checkedLimit("maxHeavyPerSender", opts.schedulerMaxHeavyPerSender ?? opts.maxHeavyPerSender ?? 2, 1);
    this.maxHeavyPerSponsor = checkedLimit("maxHeavyPerSponsor", opts.maxHeavyPerSponsor ?? this.maxHeavyPerSender, 1);
    this.maxWaiting = checkedLimit("maxWaiting", opts.schedulerMaxWaiting ?? opts.maxWaiting ?? 64, 0);
    this.maxWaitingPerSender = checkedLimit("maxWaitingPerSender", opts.maxWaitingPerSender ?? Math.min(16, this.maxWaiting), 0);
    
    const threshold = opts.schedulerHeavyThreshold ?? opts.heavyThreshold ?? 100_000;
    this.heavyThreshold = BigInt(checkedLimit("heavyThreshold", Number(threshold), 0));

    this.enableDRR = Boolean(opts.enableDRR ?? false);
    this.drrQuantum = BigInt(opts.drrQuantum ?? 200_000);
  }

  /**
   * Submits admission work to the scheduler.
   * Supports both legacy signature: submit(sender, isHeavy, fn)
   * and enhanced Hierarchical DRR: submit({ sender, sponsor, declaredGas, isHeavy }, fn)
   */
  public async submit<T>(
    senderOrMeta: SubmitSenderParam,
    isHeavyOrFn: boolean | (() => Promise<T>),
    maybeFn?: () => Promise<T>
  ): Promise<T> {
    let sender: string;
    let sponsor: string;
    let isHeavy: boolean;
    let declaredGas: bigint;
    let fn: () => Promise<T>;

    if (typeof senderOrMeta === "string") {
      sender = (senderOrMeta ?? "").toLowerCase();
      if (typeof isHeavyOrFn === "boolean") {
        isHeavy = isHeavyOrFn;
        fn = maybeFn!;
      } else {
        isHeavy = false;
        fn = isHeavyOrFn;
      }
      sponsor = sender;
      declaredGas = isHeavy ? 1_000_000n : 100_000n;
    } else {
      sender = (senderOrMeta.sender ?? "").toLowerCase();
      sponsor = (senderOrMeta.sponsor ?? sender).toLowerCase();
      declaredGas = BigInt(senderOrMeta.declaredGas ?? (senderOrMeta.isHeavy ? 1_000_000n : 100_000n));
      isHeavy = senderOrMeta.isHeavy ?? (declaredGas > this.heavyThreshold);
      fn = (typeof isHeavyOrFn === "function" ? isHeavyOrFn : maybeFn)!;
    }

    // Mode "off": execute immediately
    if (this.mode === "off") {
      return await fn();
    }

    // Check waiting capacity limits
    const sp = this.sponsorQueues.get(sponsor);
    const senderCount = this.waitingPerSender.get(sender) ?? 0;
    const needsToWait =
      this.runningCount >= this.slots ||
      (sp?.senders.get(sender)?.length ?? 0) > 0 ||
      (this.mode === "fair" && isHeavy && (sp?.activeHeavy ?? 0) >= this.maxHeavyPerSponsor);

    if (needsToWait) {
      if (this.waitingCount >= this.maxWaiting) {
        throw new RpcError(
          `Admission queue is full (${this.waitingCount}/${this.maxWaiting} waiting), retry later`,
          RpcErrorCodes.SERVER_ERROR
        );
      }
      if (senderCount >= this.maxWaitingPerSender) {
        throw new RpcError("Sender admission queue is full; retry later", RpcErrorCodes.SERVER_ERROR);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = {
        id: this.nextJobId++,
        sender,
        sponsor,
        declaredGas,
        isHeavy,
        fn,
        resolve,
        reject,
      };

      this.enqueue(job);
      this.dispatch();
    });
  }

  private enqueue(job: QueuedJob): void {
    this.waitingCount++;
    this.waitingPerSender.set(job.sender, (this.waitingPerSender.get(job.sender) ?? 0) + 1);

    if (this.mode === "fifo") {
      this.fifoQueue.push(job);
      return;
    }

    // Level 1: Sponsor Queue
    let sp = this.sponsorQueues.get(job.sponsor);
    if (!sp) {
      sp = {
        sponsor: job.sponsor,
        senders: new Map(),
        waitingSenders: [],
        lastDispatchedSender: null,
        activeHeavy: 0,
        activeTotal: 0,
        deficitCredit: 0n,
      };
      this.sponsorQueues.set(job.sponsor, sp);
    }

    // Level 2: Sender Queue inside Sponsor
    let sq = sp.senders.get(job.sender);
    if (!sq) {
      sq = [];
      sp.senders.set(job.sender, sq);
    }
    sq.push(job);

    if (!sp.waitingSenders.includes(job.sender)) {
      sp.waitingSenders.push(job.sender);
    }
    if (!this.waitingSponsorOrder.includes(job.sponsor)) {
      this.waitingSponsorOrder.push(job.sponsor);
    }
  }

  private dispatch(): void {
    while (this.runningCount < this.slots) {
      let job: QueuedJob | null = null;

      if (this.mode === "fifo") {
        if (this.fifoQueue.length === 0) break;
        job = this.fifoQueue.shift()!;
        this.markDispatched(job);
        this.runningCount++;
      } else if (this.mode === "fair") {
        job = this.dequeueNextHierarchicalJob();
        if (!job) break;
      } else {
        break;
      }

      if (job) {
        this.executeJob(job);
      }
    }
  }

  /**
   * Dequeues the next job using 2-Level Hierarchical Round-Robin (Level 1: Sponsor, Level 2: Sender)
   * with Deficit Round Robin (DRR) gas pacing.
   */
  private dequeueNextHierarchicalJob(): QueuedJob | null {
    const numSponsors = this.waitingSponsorOrder.length;
    if (numSponsors === 0) return null;

    // Prevent immediate re-dispatch of the same sponsor if other sponsors are waiting
    if (numSponsors > 1 && this.waitingSponsorOrder[0] === this.lastDispatchedSponsor) {
      this.waitingSponsorOrder.push(this.waitingSponsorOrder.shift()!);
    }

    for (let sIdx = 0; sIdx < numSponsors; sIdx++) {
      const sponsorKey = this.waitingSponsorOrder.shift()!;
      const sp = this.sponsorQueues.get(sponsorKey);

      if (!sp || sp.waitingSenders.length === 0) {
        continue;
      }

      // Check Level 1 heavy concurrency cap for this sponsor
      if (sp.activeHeavy >= this.maxHeavyPerSponsor) {
        // Check if sponsor has any non-heavy jobs waiting
        let hasLightJob = false;
        for (const senderKey of sp.waitingSenders) {
          const queue = sp.senders.get(senderKey);
          if (queue && queue.length > 0 && !queue[0].isHeavy) {
            hasLightJob = true;
            break;
          }
        }
        if (!hasLightJob) {
          this.waitingSponsorOrder.push(sponsorKey);
          continue;
        }
      }

      // Level 2: Select next sender within this sponsor
      const numSenders = sp.waitingSenders.length;
      if (numSenders > 1 && sp.waitingSenders[0] === sp.lastDispatchedSender) {
        sp.waitingSenders.push(sp.waitingSenders.shift()!);
      }

      let selectedJob: QueuedJob | null = null;

      for (let wIdx = 0; wIdx < numSenders; wIdx++) {
        const senderKey = sp.waitingSenders.shift()!;
        const queue = sp.senders.get(senderKey);

        if (!queue || queue.length === 0) {
          continue;
        }

        const candidate = queue[0];

        // If candidate is heavy and sponsor is at heavy capacity, rotate sender
        if (candidate.isHeavy && sp.activeHeavy >= this.maxHeavyPerSponsor) {
          sp.waitingSenders.push(senderKey);
          continue;
        }

        // DRR Check: If DRR enabled, check deficit credit
        if (this.enableDRR) {
          sp.deficitCredit += this.drrQuantum;
          if (sp.deficitCredit < candidate.declaredGas && sp.activeTotal > 0) {
            // Insufficient credit while active jobs exist; accrue and rotate
            sp.waitingSenders.push(senderKey);
            continue;
          }
          sp.deficitCredit -= candidate.declaredGas;
          if (sp.deficitCredit < 0n) sp.deficitCredit = 0n;
        }

        // Found an eligible job!
        selectedJob = queue.shift()!;
        sp.lastDispatchedSender = senderKey;

        // Keep sender in waiting list if it has more jobs
        if (queue.length > 0) {
          sp.waitingSenders.push(senderKey);
        }
        break;
      }

      if (selectedJob) {
        this.markDispatched(selectedJob);
        this.runningCount++;
        sp.activeTotal++;
        if (selectedJob.isHeavy) {
          sp.activeHeavy++;
        }
        this.lastDispatchedSponsor = sponsorKey;

        // Keep sponsor in waiting list if it still has waiting senders
        if (sp.waitingSenders.length > 0) {
          this.waitingSponsorOrder.push(sponsorKey);
        }

        return selectedJob;
      }

      // If no job was dispatchable under this sponsor right now, rotate it
      if (sp.waitingSenders.length > 0) {
        this.waitingSponsorOrder.push(sponsorKey);
      }
    }

    return null;
  }

  private markDispatched(job: QueuedJob): void {
    this.waitingCount--;
    const remaining = (this.waitingPerSender.get(job.sender) ?? 1) - 1;
    if (remaining > 0) this.waitingPerSender.set(job.sender, remaining);
    else this.waitingPerSender.delete(job.sender);
  }

  private async executeJob(job: QueuedJob): Promise<void> {
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      this.runningCount--;

      if (this.mode === "fair") {
        const sp = this.sponsorQueues.get(job.sponsor);
        if (sp) {
          sp.activeTotal--;
          if (job.isHeavy) {
            sp.activeHeavy--;
          }

          // Clean up empty sender queues
          const sq = sp.senders.get(job.sender);
          if (sq && sq.length === 0) {
            sp.senders.delete(job.sender);
            const wIdx = sp.waitingSenders.indexOf(job.sender);
            if (wIdx !== -1) sp.waitingSenders.splice(wIdx, 1);
          }

          // Clean up empty sponsor queues
          if (sp.activeTotal <= 0 && sp.waitingSenders.length === 0) {
            this.sponsorQueues.delete(job.sponsor);
            const sIdx = this.waitingSponsorOrder.indexOf(job.sponsor);
            if (sIdx !== -1) this.waitingSponsorOrder.splice(sIdx, 1);
          }
        }
      }

      this.dispatch();
    }
  }

  // --- Observability & Metrics ---

  public getRunningCount(): number {
    return this.runningCount;
  }

  public getWaitingCount(): number {
    return this.waitingCount;
  }

  public getActiveHeavyForSender(sender: string): number {
    return this.sponsorQueues.get(sender.toLowerCase())?.activeHeavy ?? 0;
  }

  public getActiveHeavyForSponsor(sponsor: string): number {
    return this.sponsorQueues.get(sponsor.toLowerCase())?.activeHeavy ?? 0;
  }

  public getActiveTotalForSender(sender: string): number {
    return this.sponsorQueues.get(sender.toLowerCase())?.activeTotal ?? 0;
  }

  public getWaitingCountForSender(sender: string): number {
    const s = sender.toLowerCase();
    for (const sp of this.sponsorQueues.values()) {
      const q = sp.senders.get(s);
      if (q) return q.length;
    }
    return 0;
  }

  public getWaitingSenders(): string[] {
    const senders: string[] = [];
    for (const sp of this.sponsorQueues.values()) {
      senders.push(...sp.waitingSenders);
    }
    return senders;
  }

  public getWaitingSponsors(): string[] {
    return [...this.waitingSponsorOrder];
  }

  public getSenderQueueCount(): number {
    return this.sponsorQueues.size;
  }
}
