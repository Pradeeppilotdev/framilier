import { describe, it, expect } from "vitest";
import {
  AdmissionScheduler,
  SchedulerMode,
} from "../../../src/services/AdmissionScheduler/index.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

const SENDER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SENDER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SENDER_C = "0xcccccccccccccccccccccccccccccccccccccccc";

interface HoldableJob<T = string> {
  name: string;
  fn: () => Promise<T>;
  isStarted: () => boolean;
  waitForStart: () => Promise<void>;
  release: (val?: T) => void;
  reject: (err: any) => void;
  promise?: Promise<T>;
}

function createHoldableJob<T = string>(name: string, resultValue: T = name as any): HoldableJob<T> {
  let started = false;
  let startResolver: () => void;
  const startPromise = new Promise<void>((res) => {
    startResolver = res;
  });

  let finishResolver: (val: T) => void;
  let finishRejecter: (err: any) => void;
  const finishPromise = new Promise<T>((res, rej) => {
    finishResolver = res;
    finishRejecter = rej;
  });

  const fn = async (): Promise<T> => {
    started = true;
    startResolver();
    return finishPromise;
  };

  return {
    name,
    fn,
    isStarted: () => started,
    waitForStart: () => startPromise,
    release: (val: T = resultValue) => finishResolver(val),
    reject: (err: any) => finishRejecter(err),
  };
}

describe("AdmissionScheduler", () => {
  it("rejects invalid modes and invalid operator limits before accepting work", () => {
    expect(() => new AdmissionScheduler({ mode: "typo" as SchedulerMode })).toThrow(/mode/i);
    for (const slots of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => new AdmissionScheduler({ slots })).toThrow(/slots/i);
    }
    expect(() => new AdmissionScheduler({ maxHeavyPerSender: 0 })).toThrow(/heavy/i);
    expect(() => new AdmissionScheduler({ maxWaiting: -1 })).toThrow(/waiting/i);
    expect(() => new AdmissionScheduler({ heavyThreshold: -1n })).toThrow(/threshold/i);
  });

  it("keeps the successor's turn when a sender drains its last waiting job", async () => {
    const scheduler = new AdmissionScheduler({ mode: "fair", slots: 1 });
    const held = createHoldableJob("A0");
    const first = scheduler.submit(SENDER_A, false, held.fn);
    const order: string[] = [];
    const enqueue = (sender: string, id: string) =>
      scheduler.submit(sender, false, async () => { order.push(id); });
    const queued = [
      enqueue(SENDER_A, "A1"), enqueue(SENDER_A, "A2"),
      enqueue(SENDER_B, "B1"), enqueue(SENDER_C, "C1"),
    ];
    held.release();
    await Promise.all([first, ...queued]);
    expect(order).toEqual(["B1", "C1", "A1", "A2"]);
  });

  it("uses a free slot for another sender when a capped sender fills the waiting queue", async () => {
    const scheduler = new AdmissionScheduler({ mode: "fair", slots: 4, maxHeavyPerSender: 2, maxWaiting: 1 });
    const held = createHoldableJob("A");
    const heavy = Array.from({ length: 3 }, () => scheduler.submit(SENDER_A, true, held.fn));
    try {
      expect(scheduler.getWaitingCount()).toBe(1);
      await expect(scheduler.submit(SENDER_A, false, async () => "jump")).rejects.toThrow(/queue is full/i);
      await expect(scheduler.submit(SENDER_B, false, async () => "B")).resolves.toBe("B");
      expect(scheduler.getWaitingCount()).toBe(1);
    } finally {
      held.release();
      await Promise.all(heavy);
    }
  });

  it("supports zero waiting slots without dropping work that can start immediately", async () => {
    const scheduler = new AdmissionScheduler({ mode: "fifo", slots: 1, maxWaiting: 0 });
    const held = createHoldableJob("first");
    const first = scheduler.submit(SENDER_A, false, held.fn);
    await held.waitForStart();
    const next = scheduler.submit(SENDER_B, false, async () => "second");
    held.release();
    await expect(next).rejects.toThrow(/queue is full/i);
    await first;
    await expect(scheduler.submit(SENDER_C, false, async () => "third")).resolves.toBe("third");
  });

  describe("Definition of done - Core Requirements", () => {
    it("With four A jobs held, FIFO must leave B waiting until a slot opens", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fifo",
        slots: 4,
        maxWaiting: 64,
      });

      const a1 = createHoldableJob("A1");
      const a2 = createHoldableJob("A2");
      const a3 = createHoldableJob("A3");
      const a4 = createHoldableJob("A4");
      const b1 = createHoldableJob("B1");

      const pA1 = scheduler.submit(SENDER_A, true, a1.fn);
      const pA2 = scheduler.submit(SENDER_A, true, a2.fn);
      const pA3 = scheduler.submit(SENDER_A, true, a3.fn);
      const pA4 = scheduler.submit(SENDER_A, true, a4.fn);

      // Wait for all 4 A jobs to start
      await Promise.all([a1.waitForStart(), a2.waitForStart(), a3.waitForStart(), a4.waitForStart()]);

      expect(scheduler.getRunningCount()).toBe(4);
      expect(scheduler.getWaitingCount()).toBe(0);

      // Now B submits a job
      const pB1 = scheduler.submit(SENDER_B, false, b1.fn);

      // Give microtasks a turn to run
      await new Promise((r) => setTimeout(r, 10));

      // With four A jobs held, FIFO must leave B waiting until a slot opens
      expect(b1.isStarted()).toBe(false);
      expect(scheduler.getRunningCount()).toBe(4);
      expect(scheduler.getWaitingCount()).toBe(1);

      // Release A1 to open a slot
      a1.release("A1-done");
      expect(await pA1).toBe("A1-done");

      // B1 can now start!
      await b1.waitForStart();
      expect(b1.isStarted()).toBe(true);
      expect(scheduler.getRunningCount()).toBe(4);
      expect(scheduler.getWaitingCount()).toBe(0);

      // Release the rest
      a2.release();
      a3.release();
      a4.release();
      b1.release("B1-done");

      expect(await pB1).toBe("B1-done");
      await Promise.all([pA2, pA3, pA4]);

      expect(scheduler.getRunningCount()).toBe(0);
      expect(scheduler.getWaitingCount()).toBe(0);
    });

    it("With fair settings: A1 and A2 start, A3 and A4 wait, and B starts while A1 and A2 are running; then release and show A3 and A4 finish", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 4,
        maxHeavyPerSender: 2,
        maxWaiting: 64,
      });

      const a1 = createHoldableJob("A1");
      const a2 = createHoldableJob("A2");
      const a3 = createHoldableJob("A3");
      const a4 = createHoldableJob("A4");
      const b1 = createHoldableJob("B1");

      const dispatchOrder: string[] = [];
      const track = (job: HoldableJob) => {
        job.waitForStart().then(() => dispatchOrder.push(job.name));
      };
      [a1, a2, a3, a4, b1].forEach(track);

      // Submit A1 and A2 (heavy)
      const pA1 = scheduler.submit(SENDER_A, true, a1.fn);
      const pA2 = scheduler.submit(SENDER_A, true, a2.fn);

      await Promise.all([a1.waitForStart(), a2.waitForStart()]);

      // A1 and A2 are running
      expect(a1.isStarted()).toBe(true);
      expect(a2.isStarted()).toBe(true);
      expect(scheduler.getRunningCount()).toBe(2);
      expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(2);

      // Submit A3 and A4 (heavy) -> capped by maxHeavyPerSender (2)
      const pA3 = scheduler.submit(SENDER_A, true, a3.fn);
      const pA4 = scheduler.submit(SENDER_A, true, a4.fn);

      await new Promise((r) => setTimeout(r, 10));

      expect(a3.isStarted()).toBe(false);
      expect(a4.isStarted()).toBe(false);
      expect(scheduler.getWaitingCount()).toBe(2);
      expect(scheduler.getWaitingCountForSender(SENDER_A)).toBe(2);

      // Now B submits while A1 and A2 are still running
      const pB1 = scheduler.submit(SENDER_B, true, b1.fn);

      // B starts while A1 and A2 are still running!
      await b1.waitForStart();
      expect(b1.isStarted()).toBe(true);
      expect(a1.isStarted()).toBe(true);
      expect(a2.isStarted()).toBe(true);
      expect(a3.isStarted()).toBe(false);
      expect(a4.isStarted()).toBe(false);

      expect(scheduler.getRunningCount()).toBe(3);
      expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(2);
      expect(scheduler.getActiveHeavyForSender(SENDER_B)).toBe(1);
      expect(scheduler.getWaitingCount()).toBe(2);

      // Start order assertion so far: A1, A2, B1
      expect(dispatchOrder).toEqual(["A1", "A2", "B1"]);

      // Release A1
      a1.release();
      await pA1;

      // Slot opened for A, A3 should start!
      await a3.waitForStart();
      expect(a3.isStarted()).toBe(true);
      expect(a4.isStarted()).toBe(false);
      expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(2); // A2 and A3 active
      expect(dispatchOrder).toEqual(["A1", "A2", "B1", "A3"]);

      // Release A2
      a2.release();
      await pA2;

      // A4 should start!
      await a4.waitForStart();
      expect(a4.isStarted()).toBe(true);
      expect(dispatchOrder).toEqual(["A1", "A2", "B1", "A3", "A4"]);

      // Release remaining jobs and show A3 and A4 both finish
      b1.release("B1-done");
      a3.release("A3-done");
      a4.release("A4-done");

      expect(await pB1).toBe("B1-done");
      expect(await pA3).toBe("A3-done");
      expect(await pA4).toBe("A4-done");

      expect(scheduler.getRunningCount()).toBe(0);
      expect(scheduler.getWaitingCount()).toBe(0);
      expect(scheduler.getSenderQueueCount()).toBe(0);
    });
  });

  describe("Round-robin selection across waiting senders", () => {
    it("rotates fairly among eligible senders", async () => {
      // 1 slot to serialize dispatching
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 1,
        maxHeavyPerSender: 2,
      });

      const initial = createHoldableJob("initial");
      const pInitial = scheduler.submit(SENDER_A, false, initial.fn);
      await initial.waitForStart();

      const a1 = createHoldableJob("A1");
      const b1 = createHoldableJob("B1");
      const c1 = createHoldableJob("C1");
      const a2 = createHoldableJob("A2");
      const b2 = createHoldableJob("B2");

      const dispatchOrder: string[] = [];
      [a1, b1, c1, a2, b2].forEach((j) => {
        j.waitForStart().then(() => dispatchOrder.push(j.name));
      });

      // Submit in order: A1, B1, C1, A2, B2
      const pA1 = scheduler.submit(SENDER_A, false, a1.fn);
      const pB1 = scheduler.submit(SENDER_B, false, b1.fn);
      const pC1 = scheduler.submit(SENDER_C, false, c1.fn);
      const pA2 = scheduler.submit(SENDER_A, false, a2.fn);
      const pB2 = scheduler.submit(SENDER_B, false, b2.fn);

      // Release initial job (belonged to SENDER_A)
      initial.release();
      await pInitial;

      // Round-robin should advance past A to B1!
      await b1.waitForStart();
      expect(dispatchOrder).toEqual(["B1"]);
      b1.release();
      await pB1;

      // Then C1!
      await c1.waitForStart();
      expect(dispatchOrder).toEqual(["B1", "C1"]);
      c1.release();
      await pC1;

      // Then A1!
      await a1.waitForStart();
      expect(dispatchOrder).toEqual(["B1", "C1", "A1"]);
      a1.release();
      await pA1;

      // Then B2!
      await b2.waitForStart();
      expect(dispatchOrder).toEqual(["B1", "C1", "A1", "B2"]);
      b2.release();
      await pB2;

      // Then A2!
      await a2.waitForStart();
      expect(dispatchOrder).toEqual(["B1", "C1", "A1", "B2", "A2"]);
      a2.release();
      await pA2;
    });
  });

  describe("Global concurrency limit", () => {
    it("never exceeds total configured slots in flight", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 3,
        maxHeavyPerSender: 2,
      });

      let currentActive = 0;
      let maxObservedActive = 0;

      const jobs = Array.from({ length: 9 }, (_, i) => {
        const sender = i % 3 === 0 ? SENDER_A : i % 3 === 1 ? SENDER_B : SENDER_C;
        const job = createHoldableJob(`job-${i}`);
        const originalFn = job.fn;
        job.fn = async () => {
          currentActive++;
          if (currentActive > maxObservedActive) maxObservedActive = currentActive;
          try {
            return await originalFn();
          } finally {
            currentActive--;
          }
        };
        return { sender, job };
      });

      const promises = jobs.map(({ sender, job }) => scheduler.submit(sender, false, job.fn));

      // Wait a moment for slots to fill
      await new Promise((r) => setTimeout(r, 20));

      expect(scheduler.getRunningCount()).toBe(3);
      expect(maxObservedActive).toBe(3);

      // Release all jobs
      for (const { job } of jobs) {
        job.release();
        await new Promise((r) => setTimeout(r, 5));
      }

      await Promise.all(promises);
      expect(maxObservedActive).toBeLessThanOrEqual(3);
      expect(scheduler.getRunningCount()).toBe(0);
    });
  });

  describe("Queue overflow and recovery", () => {
    it("rejects with retryable SERVER_ERROR when waiting queue is full and recovers", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 1,
        maxWaiting: 2,
      });

      const held = createHoldableJob("held");
      const pHeld = scheduler.submit(SENDER_A, false, held.fn);
      await held.waitForStart();

      const wait1 = createHoldableJob("wait1");
      const wait2 = createHoldableJob("wait2");
      const pWait1 = scheduler.submit(SENDER_A, false, wait1.fn);
      const pWait2 = scheduler.submit(SENDER_B, false, wait2.fn);

      expect(scheduler.getWaitingCount()).toBe(2);

      // 3rd waiting job must reject immediately
      const overflowJob = createHoldableJob("overflow");
      await expect(scheduler.submit(SENDER_C, false, overflowJob.fn)).rejects.toThrow(
        /Admission queue is full/
      );
      expect(overflowJob.isStarted()).toBe(false);

      // Recovery: release held job -> round-robin advances to next sender SENDER_B (wait2)!
      held.release();
      await pHeld;

      // Because SENDER_A just ran, fair round-robin rotates to SENDER_B
      await wait2.waitForStart();
      expect(wait2.isStarted()).toBe(true);
      expect(wait1.isStarted()).toBe(false);

      // Now queue has space (waitingCount is 1: only wait1 is waiting)
      const recoveryJob = createHoldableJob("recovery");
      const pRecovery = scheduler.submit(SENDER_C, false, recoveryJob.fn);

      // Release wait2 -> rotates to SENDER_A (wait1)
      wait2.release();
      await pWait2;

      await wait1.waitForStart();
      expect(wait1.isStarted()).toBe(true);
      wait1.release();
      await pWait1;

      // Then rotates to SENDER_C (recoveryJob)
      await recoveryJob.waitForStart();
      expect(recoveryJob.isStarted()).toBe(true);
      recoveryJob.release();
      await pRecovery;

      expect(scheduler.getRunningCount()).toBe(0);
      expect(scheduler.getWaitingCount()).toBe(0);
    });
  });

  describe("Error handling and slot release", () => {
    it("releases slot and dispatches next when job throws synchronously", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 1,
      });

      const syncError = new Error("synchronous crash");
      const syncThrowingJob = () => {
        throw syncError;
      };

      const next = createHoldableJob("next");

      // Submit sync-throwing job and queued next job
      const pThrow = scheduler.submit(SENDER_A, true, syncThrowingJob);
      const pNext = scheduler.submit(SENDER_B, true, next.fn);

      await expect(pThrow).rejects.toThrow("synchronous crash");

      // Slot must be released and next job must start!
      await next.waitForStart();
      expect(next.isStarted()).toBe(true);
      expect(scheduler.getRunningCount()).toBe(1);

      next.release();
      await pNext;
      expect(scheduler.getRunningCount()).toBe(0);
    });

    it("releases slot and dispatches next when job rejects asynchronously", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 1,
      });

      const failing = createHoldableJob("failing");
      const next = createHoldableJob("next");

      const pFail = scheduler.submit(SENDER_A, true, failing.fn);
      const pNext = scheduler.submit(SENDER_B, true, next.fn);

      await failing.waitForStart();
      failing.reject(new Error("async failure"));

      await expect(pFail).rejects.toThrow("async failure");

      await next.waitForStart();
      expect(next.isStarted()).toBe(true);

      next.release();
      await pNext;
      expect(scheduler.getRunningCount()).toBe(0);
    });
  });

  describe("Empty queue cleanup", () => {
    it("removes empty sender queues after active jobs complete", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "fair",
        slots: 2,
      });

      const jA = createHoldableJob("A");
      const pA = scheduler.submit(SENDER_A, true, jA.fn);
      await jA.waitForStart();

      expect(scheduler.getSenderQueueCount()).toBe(1);

      jA.release();
      await pA;

      expect(scheduler.getSenderQueueCount()).toBe(0);
      expect(scheduler.getWaitingSenders()).toHaveLength(0);
    });
  });

  describe("Mode 'off' compatibility", () => {
    it("executes immediately without limits or queueing", async () => {
      const scheduler = new AdmissionScheduler({
        mode: "off",
        slots: 1,
      });

      expect(scheduler.mode).toBe("off");

      const j1 = createHoldableJob("j1");
      const j2 = createHoldableJob("j2");

      const p1 = scheduler.submit(SENDER_A, true, j1.fn);
      const p2 = scheduler.submit(SENDER_A, true, j2.fn);

      // Both should have started immediately despite slots: 1
      await Promise.all([j1.waitForStart(), j2.waitForStart()]);
      expect(j1.isStarted()).toBe(true);
      expect(j2.isStarted()).toBe(true);

      j1.release();
      j2.release();

      await Promise.all([p1, p2]);
    });
  });
});
