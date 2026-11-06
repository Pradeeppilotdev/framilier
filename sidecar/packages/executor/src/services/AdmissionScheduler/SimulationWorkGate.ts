import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as Codes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

export type SimulationLane = "admission" | "estimate" | "maintenance";
type Job = { lane: SimulationLane; run: () => Promise<unknown>; resolve: (v: any) => void; reject: (e: unknown) => void };

/** One execution budget shared by every sidecar simulation entry point.
 * Auxiliary work leaves one slot available for admission when slots > 1.
 * Round-robin lanes prevent a continuous admission stream starving maintenance.
 * A running slot is held until the underlying operation settles, even if its
 * HTTP caller disconnects. This gate never pretends a timeout stopped execution.
 */
export class SimulationWorkGate {
  private running = 0;
  private auxiliary = 0;
  private queues: Record<SimulationLane, Job[]> = { admission: [], estimate: [], maintenance: [] };
  private readonly lanes: SimulationLane[] = ["admission", "estimate", "maintenance"];

  constructor(private slots = 4, private maxWaiting = 64, private enabled = true) {
    if (!Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting < 0) {
      throw new Error("Invalid simulation capacity");
    }
  }

  submit<T>(lane: SimulationLane, run: () => Promise<T>): Promise<T> {
    if (!this.enabled) return Promise.resolve().then(run);
    const canStart = this.running < this.slots &&
      (lane === "admission" || this.auxiliary < Math.max(1, this.slots - 1));
    // Bound each lane independently so estimates cannot consume admission's backlog.
    if (this.queues[lane].length >= this.maxWaiting && (!canStart || this.queues[lane].length > 0)) {
      return Promise.reject(new RpcError(`Simulation ${lane} queue is full; retry later`, Codes.SERVER_ERROR));
    }
    return new Promise<T>((resolve, reject) => {
      this.queues[lane].push({ lane, run, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.running < this.slots) {
      let job: Job | undefined;
      for (const [index, lane] of this.lanes.entries()) {
        if (lane !== "admission" && this.auxiliary >= Math.max(1, this.slots - 1)) continue;
        job = this.queues[lane].shift();
        if (job) {
          // Rotate only the lane that ran. A lane skipped because auxiliary
          // capacity is full keeps its turn when an auxiliary slot opens.
          this.lanes.splice(index, 1);
          this.lanes.push(lane);
          break;
        }
      }
      if (!job) break;
      this.running++;
      if (job.lane !== "admission") this.auxiliary++;
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    try { job.resolve(await job.run()); }
    catch (error) { job.reject(error); }
    finally {
      this.running--;
      if (job.lane !== "admission") this.auxiliary--;
      this.dispatch();
    }
  }
}
