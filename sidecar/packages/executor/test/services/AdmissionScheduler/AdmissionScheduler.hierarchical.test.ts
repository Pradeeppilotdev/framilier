import { describe, it, expect } from "vitest";
import {
  AdmissionScheduler,
} from "../../../src/services/AdmissionScheduler/index.js";

const PAYMASTER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYMASTER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USER_1 = "0x1111111111111111111111111111111111111111";
const USER_2 = "0x2222222222222222222222222222222222222222";
const USER_3 = "0x3333333333333333333333333333333333333333";

interface HoldableJob<T = string> {
  name: string;
  fn: () => Promise<T>;
  isStarted: () => boolean;
  waitForStart: () => Promise<void>;
  release: (val?: T) => void;
  reject: (err: any) => void;
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

describe("Framilier 2.0: Hierarchical Fair Queuing (H-FQ) & Anti-Sybil Scheduler", () => {
  it("interleaves two distinct users sharing the SAME paymaster (solves shared paymaster HoL)", async () => {
    const scheduler = new AdmissionScheduler({
      mode: "fair",
      slots: 2,
      maxHeavyPerSender: 2,
      maxHeavyPerSponsor: 2,
    });

    const executionOrder: string[] = [];

    const jobA1 = createHoldableJob("A1");
    const jobA2 = createHoldableJob("A2");
    const jobA3 = createHoldableJob("A3");
    const jobB1 = createHoldableJob("B1");

    // User 1 sends 3 heavy jobs sponsored by PAYMASTER_A
    const pA1 = scheduler.submit({ sender: USER_1, sponsor: PAYMASTER_A, isHeavy: true }, async () => {
      executionOrder.push("A1");
      return jobA1.fn();
    });
    const pA2 = scheduler.submit({ sender: USER_1, sponsor: PAYMASTER_A, isHeavy: true }, async () => {
      executionOrder.push("A2");
      return jobA2.fn();
    });
    const pA3 = scheduler.submit({ sender: USER_1, sponsor: PAYMASTER_A, isHeavy: true }, async () => {
      executionOrder.push("A3");
      return jobA3.fn();
    });

    // User 2 sends 1 heavy job sponsored by the SAME PAYMASTER_A
    const pB1 = scheduler.submit({ sender: USER_2, sponsor: PAYMASTER_A, isHeavy: true }, async () => {
      executionOrder.push("B1");
      return jobB1.fn();
    });

    // Slots = 2: A1 and A2 are running (User 1 has 2 heavy jobs running)
    await jobA1.waitForStart();
    await jobA2.waitForStart();

    expect(executionOrder).toEqual(["A1", "A2"]);

    // When A1 finishes, the scheduler rotates senders under PAYMASTER_A: User 2's B1 MUST start next before A3!
    jobA1.release("done");
    await jobB1.waitForStart();

    expect(executionOrder).toEqual(["A1", "A2", "B1"]);

    jobA2.release("done");
    jobB1.release("done");
    await pA1;
    await pA2;
    await pB1;

    // Finally A3 runs
    await jobA3.waitForStart();
    jobA3.release("done");
    await pA3;

    expect(executionOrder).toEqual(["A1", "A2", "B1", "A3"]);
  });

  it("prevents Sybil multi-wallet burner attack via sponsor collateral anchoring", async () => {
    const scheduler = new AdmissionScheduler({
      mode: "fair",
      slots: 4,
      maxHeavyPerSponsor: 2, // At most 2 heavy slots per collateral sponsor
    });

    const executionOrder: string[] = [];

    // Attacker creates 4 disposable burner wallets all drawing from ATTACKER_SPONSOR
    const ATTACKER_SPONSOR = "0xbad0000000000000000000000000000000000000";
    const burner1 = "0xburner111111111111111111111111111111111";
    const burner2 = "0xburner222222222222222222222222222222222";
    const burner3 = "0xburner333333333333333333333333333333333";
    const burner4 = "0xburner444444444444444444444444444444444";

    const job1 = createHoldableJob("burner1");
    const job2 = createHoldableJob("burner2");
    const job3 = createHoldableJob("burner3");
    const job4 = createHoldableJob("burner4");

    const p1 = scheduler.submit({ sender: burner1, sponsor: ATTACKER_SPONSOR, isHeavy: true }, async () => {
      executionOrder.push("burner1");
      return job1.fn();
    });
    const p2 = scheduler.submit({ sender: burner2, sponsor: ATTACKER_SPONSOR, isHeavy: true }, async () => {
      executionOrder.push("burner2");
      return job2.fn();
    });
    const p3 = scheduler.submit({ sender: burner3, sponsor: ATTACKER_SPONSOR, isHeavy: true }, async () => {
      executionOrder.push("burner3");
      return job3.fn();
    });
    const p4 = scheduler.submit({ sender: burner4, sponsor: ATTACKER_SPONSOR, isHeavy: true }, async () => {
      executionOrder.push("burner4");
      return job4.fn();
    });

    // Honest user with their own collateral/sponsor
    const HONEST_SPONSOR = "0xg00d000000000000000000000000000000000000";
    const honestJob = createHoldableJob("honest");
    const pHonest = scheduler.submit({ sender: USER_3, sponsor: HONEST_SPONSOR, isHeavy: true }, async () => {
      executionOrder.push("honest");
      return honestJob.fn();
    });

    await job1.waitForStart();
    await job2.waitForStart();
    await honestJob.waitForStart();

    // Burner 1 and Burner 2 run (hitting ATTACKER_SPONSOR's cap of 2).
    // Honest user runs immediately in slot 3!
    // Burner 3 and 4 are blocked from taking slot 4 despite having different wallet addresses!
    expect(executionOrder).toContain("burner1");
    expect(executionOrder).toContain("burner2");
    expect(executionOrder).toContain("honest");
    expect(executionOrder).not.toContain("burner3");
    expect(executionOrder).not.toContain("burner4");

    job1.release();
    job2.release();
    honestJob.release();
    await p1;
    await p2;
    await pHonest;

    await job3.waitForStart();
    await job4.waitForStart();
    job3.release();
    job4.release();
    await p3;
    await p4;
  });

  it("Deficit Round Robin (DRR) gas weighting prioritizes lightweight frames", async () => {
    const scheduler = new AdmissionScheduler({
      mode: "fair",
      slots: 2,
      enableDRR: true,
      drrQuantum: 200_000n, // 200k gas credit per round
      maxHeavyPerSender: 2,
    });

    // A submits a 105k gas transaction (light multisig verification)
    // B submits a 993k gas transaction (massive Keccak loop)
    const order: string[] = [];
    
    await scheduler.submit({ sender: USER_1, declaredGas: 105_000n }, async () => {
      order.push("light-105k");
    });

    await scheduler.submit({ sender: USER_2, declaredGas: 993_512n }, async () => {
      order.push("heavy-993k");
    });

    expect(order).toEqual(["light-105k", "heavy-993k"]);
  });
});

