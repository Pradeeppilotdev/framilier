import { Logger } from "@skandha/types/lib/index.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { NetworkConfig } from "../../interfaces.js";

export type SchedulerMode = "off" | "fifo" | "fair";

export interface AdmissionSchedulerOptions {
  mode?: SchedulerMode;
  slots?: number;
  maxHeavyPerSender?: number;
  maxWaiting?: number;
  heavyThreshold?: number | bigint;
}

interface QueuedJob<T = any> {
  id: number;
  sender: string;
  isHeavy: boolean;
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

interface SenderQueue {
  sender: string;
  queue: QueuedJob[];
  activeHeavy: number;
  activeTotal: number;
}

/**
 * StakeLane PR 1: sender-fair admission scheduler.
 *
 * Provides operator-selectable admission scheduling for EIP-8141 frame
 * transactions:
 * - "off": passthrough to current admission path without limits.
 * - "fifo": dispatches in arrival order with a global concurrency limit.
 * - "fair": shares access between senders using the same global limit,
 *   rotates round-robin among eligible senders, preserves arrival order within
 *   each sender, and caps concurrent heavy jobs from each sender.
 */
export class AdmissionScheduler {
  public readonly mode: SchedulerMode;
  public readonly slots: number;
  public readonly maxHeavyPerSender: number;
  public readonly maxWaiting: number;
  public readonly heavyThreshold: bigint;

  private runningCount: number = 0;
  private waitingCount: number = 0;
  private nextJobId: number = 1;

  // FIFO mode queue
  private fifoQueue: QueuedJob[] = [];

  // Fair mode queues and round-robin state
  private senderQueues: Map<string, SenderQueue> = new Map();
  private waitingSenderOrder: string[] = [];
  private lastDispatchedSender: string | null = null;

  constructor(
    configOrOptions?: Partial<NetworkConfig> | AdmissionSchedulerOptions,
    private logger?: Logger
  ) {
    const opts = configOrOptions ?? {};
    const mode = (opts as any).schedulerMode ?? (opts as any).mode ?? "off";
    this.mode = (String(mode).toLowerCase() as SchedulerMode) || "off";

    const slots = (opts as any).schedulerSlots ?? (opts as any).slots ?? 4;
    this.slots = Number(slots) > 0 ? Number(slots) : 4;

    const maxHeavy =
      (opts as any).schedulerMaxHeavyPerSender ??
      (opts as any).maxHeavyPerSender ??
      2;
    this.maxHeavyPerSender = Number(maxHeavy) > 0 ? Number(maxHeavy) : 2;

    const maxWait =
      (opts as any).schedulerMaxWaiting ?? (opts as any).maxWaiting ?? 64;
    this.maxWaiting = Number(maxWait) > 0 ? Number(maxWait) : 64;

    const threshold =
      (opts as any).schedulerHeavyThreshold ??
      (opts as any).heavyThreshold ??
      100_000;
    this.heavyThreshold = BigInt(threshold);
  }

  /**
   * Submits admission work to the scheduler.
   *
   * @param sender normalized transaction sender address
   * @param isHeavy inexpensive hint indicating whether declared verify work is heavy
   * @param fn admission function to execute when dispatched
   * @returns result of the admission function
   */
  public async submit<T>(
    sender: string,
    isHeavy: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const normalizedSender = (sender ?? "").toLowerCase();

    // Mode "off": follow the current admission path directly
    if (this.mode === "off") {
      return await fn();
    }

    // Check waiting queue capacity
    if (this.waitingCount >= this.maxWaiting) {
      throw new RpcError(
        `Admission queue is full (${this.waitingCount}/${this.maxWaiting} waiting), retry later`,
        RpcErrorCodes.SERVER_ERROR
      );
    }

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = {
        id: this.nextJobId++,
        sender: normalizedSender,
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

    if (this.mode === "fifo") {
      this.fifoQueue.push(job);
      return;
    }

    // Fair mode
    let sq = this.senderQueues.get(job.sender);
    if (!sq) {
      sq = {
        sender: job.sender,
        queue: [],
        activeHeavy: 0,
        activeTotal: 0,
      };
      this.senderQueues.set(job.sender, sq);
    }

    sq.queue.push(job);
    if (!this.waitingSenderOrder.includes(job.sender)) {
      this.waitingSenderOrder.push(job.sender);
    }
  }

  private dispatch(): void {
    while (this.runningCount < this.slots) {
      let job: QueuedJob | null = null;

      if (this.mode === "fifo") {
        if (this.fifoQueue.length === 0) {
          break;
        }
        job = this.fifoQueue.shift()!;
        this.waitingCount--;
        this.runningCount++;
      } else if (this.mode === "fair") {
        job = this.dequeueNextFairJob();
        if (!job) {
          // No eligible job can be dispatched right now (senders may be temporarily capped)
          break;
        }
      } else {
        break;
      }

      if (job) {
        this.executeJob(job);
      }
    }
  }

  private dequeueNextFairJob(): QueuedJob | null {
    const n = this.waitingSenderOrder.length;
    if (n === 0) return null;

    let startIndex = 0;
    if (this.lastDispatchedSender) {
      const idx = this.waitingSenderOrder.indexOf(this.lastDispatchedSender);
      if (idx !== -1) {
        startIndex = (idx + 1) % n;
      }
    }

    for (let i = 0; i < n; i++) {
      const senderIndex = (startIndex + i) % n;
      const senderKey = this.waitingSenderOrder[senderIndex];
      const sq = this.senderQueues.get(senderKey);

      if (!sq || sq.queue.length === 0) {
        continue;
      }

      const nextJob = sq.queue[0];
      // Cap simultaneous heavy jobs from one sender in fair mode
      if (nextJob.isHeavy && sq.activeHeavy >= this.maxHeavyPerSender) {
        // Skip a temporarily capped sender when another sender is eligible
        continue;
      }

      // Found an eligible sender and job
      const job = sq.queue.shift()!;
      this.waitingCount--;
      this.runningCount++;
      sq.activeTotal++;
      if (job.isHeavy) {
        sq.activeHeavy++;
      }
      this.lastDispatchedSender = senderKey;

      // If sender has no more waiting jobs, remove from waiting list
      if (sq.queue.length === 0) {
        const orderIdx = this.waitingSenderOrder.indexOf(senderKey);
        if (orderIdx !== -1) {
          this.waitingSenderOrder.splice(orderIdx, 1);
        }
      }

      return job;
    }

    return null;
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
        const sq = this.senderQueues.get(job.sender);
        if (sq) {
          sq.activeTotal--;
          if (job.isHeavy) {
            sq.activeHeavy--;
          }
          // Remove empty sender queues
          if (sq.activeTotal <= 0 && sq.queue.length === 0) {
            this.senderQueues.delete(job.sender);
            const orderIdx = this.waitingSenderOrder.indexOf(job.sender);
            if (orderIdx !== -1) {
              this.waitingSenderOrder.splice(orderIdx, 1);
            }
          }
        }
      }

      // Continue dispatching on success, rejection or synchronous throw
      this.dispatch();
    }
  }

  // --- Observability & test inspection getters ---

  public getRunningCount(): number {
    return this.runningCount;
  }

  public getWaitingCount(): number {
    return this.waitingCount;
  }

  public getActiveHeavyForSender(sender: string): number {
    return this.senderQueues.get(sender.toLowerCase())?.activeHeavy ?? 0;
  }

  public getActiveTotalForSender(sender: string): number {
    return this.senderQueues.get(sender.toLowerCase())?.activeTotal ?? 0;
  }

  public getWaitingCountForSender(sender: string): number {
    return this.senderQueues.get(sender.toLowerCase())?.queue.length ?? 0;
  }

  public getWaitingSenders(): string[] {
    return [...this.waitingSenderOrder];
  }

  public getSenderQueueCount(): number {
    return this.senderQueues.size;
  }
}

