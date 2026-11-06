import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { keccak256 } from "viem";
import { encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";
import { rpc, RpcError } from "./producer.mjs";

const burst = 4;
const repetitions = 12;
export const backgroundCandidateCount = 2 * burst * (repetitions + 1); // Both busy conditions, including warm-up.
const roundMs = x => Math.round(x * 1000) / 1000;
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function describe(values) {
  if (!values.length) return null;
  return { n: values.length, min: Math.min(...values), median: roundMs(median(values)), max: Math.max(...values) };
}
function comparison(trials, treatment, control) {
  const differences = [];
  for (let i = 0; i < repetitions; i++) {
    const latency = kind => trials.find(t => t.round === i && t.kind === kind).honestMs;
    differences.push(latency(treatment) - latency(control));
  }
  return { medianDifferenceMs: roundMs(median(differences)),
    slowerRounds: differences.filter(v => v > 0).length, rounds: repetitions };
}
const hashOf = tx => keccak256(encodeRawFrameTx(tx));

export async function measureAdmission({ local, meter, noisyWallet, honestWallet, makeNoisy, makeHonest, mine, control }) {
  assert.equal(new URL(local).hostname, "127.0.0.1");
  assert.equal(Number(await rpc(local, "eth_chainId")), 8141337);
  assert.notEqual(noisyWallet.toLowerCase(), honestWallet.toLowerCase());
  assert.ok(control === "early" || control === "valid");
  const orders = [
    ["idle", control, "late"], [control, "late", "idle"], ["late", "idle", control],
    ["idle", "late", control], ["late", control, "idle"], [control, "idle", "late"],
  ];
  let serial = 0;
  const unique = new Set();
  async function reputation() {
    const { items } = await rpc(local, "skandha_explorer_listReputation", [{ limit: 100 }]);
    const row = items.find(e => e.address.toLowerCase() === noisyWallet.toLowerCase());
    assert.ok(row?.isStaked, "expected a real registered stake");
    return { seen: Number(row.opsSeen), included: Number(row.opsIncluded), status: row.status };
  }
  async function send(tx) {
    const start = performance.now();
    try {
      const result = await rpc(local, "eth_sendFrameTransaction", [tx]);
      return { result, start, end: performance.now() };
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      return { error, start, end: performance.now() };
    }
  }
  async function trial(round, kind) {
    const background = [];
    for (let i = 0; i < (kind === "idle" ? 0 : burst); i++) {
      background.push(await makeNoisy(kind, ++serial));
    }
    const honest = await makeHonest();
    const hash = hashOf(honest);
    const hashes = background.map(hashOf);
    for (const h of [hash, ...hashes]) {
      assert.ok(!unique.has(h), "reused candidate hash");
      unique.add(h);
    }
    const before = await reputation();
    const capture = meter.observe(hash, hashes);
    const pending = Promise.all(background.map(send));
    if (background.length) {
      // Admit the valid probe as soon as the first competing simulation reaches
      // the client. A missing trace is a failed setup, not a fast measurement.
      await Promise.race([capture.firstBackgroundTrace, pending.then(() => {
        assert.ok(capture.events.some(e => hashes.includes(e.hash)), "no competing simulation reached ethrex");
      })]);
    }
    const [answer, replies] = await Promise.all([send(honest), pending]);
    meter.clear();
    assert.equal(answer.result, hash, answer.error?.message);
    const expected = kind === "early" ? /one witness required|6f6e65207769746e657373207265717569726564/i :
      /wrong witness|77726f6e67207769746e657373/i;
    function trace(h) {
      const events = capture.events.filter(e => e.hash === h);
      assert.equal(events.length, 1, "expected one ethrex simulation for " + h);
      assert.ok(events[0].end !== null);
      return events[0];
    }
    const hTrace = trace(hash);
    const backgrounds = replies.map((reply, i) => {
      const accepted = kind === "valid";
      if (accepted) assert.equal(reply.result, hashes[i], reply.error?.message);
      else {
        assert.ok(reply.error, "invalid candidate unexpectedly admitted");
        assert.match(reply.error.rpcMessage, expected);
      }
      const t = trace(hashes[i]);
      return {
        hash: hashes[i], nonceKey: background[i].nonceKeys[0].toString(), nonceSeq: background[i].nonceSeq.toString(),
        outcome: accepted ? "admitted" : "rejected", rejectionCode: reply.error?.code, rejectionReason: reply.error?.rpcMessage,
        admissionMs: roundMs(reply.end - reply.start),
        simulationRpcMs: roundMs(t.end - t.start),
        traceStartRelativeToHonestMs: roundMs(t.start - answer.start),
        traceEndRelativeToHonestMs: roundMs(t.end - answer.start),
      };
    });
    const after = await reputation();
    // Drain every admission before the next trial. The producer checks that each
    // receipt belongs to the canonical block. Mining is outside all timers.
    const admitted = kind === "valid" ? [hash, ...hashes] : [hash];
    const mined = await mine(admitted);
    for (const h of admitted) {
      const { receipt } = mined.get(h);
      assert.deepEqual(receipt.frameReceipts.map(f => f.status), ["0x1", "0x1"]);
    }
    if (kind === "valid") {
      for (const item of backgrounds) {
        const { receipt } = mined.get(item.hash);
        const verifyGas = Number(BigInt(receipt.frameReceipts[0].gasUsed));
        assert.ok(verifyGas >= 990000 && verifyGas <= 997200, "valid background skipped the expensive path");
        item.mined = { blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, verifyGas };
      }
    }
    const { receipt } = mined.get(hash);
    const active = backgrounds.filter(t => t.traceStartRelativeToHonestMs <= 0 && t.traceEndRelativeToHonestMs > 0).length;
    if (background.length) assert.ok(active > 0, "probe missed the background simulation");
    return { round, kind, honestHash: hash, honestMs: roundMs(answer.end - answer.start),
      honestSimulationRpcMs: roundMs(hTrace.end - hTrace.start),
      backgroundActiveAtHonestSend: active, honestBlock: Number(receipt.blockNumber), honestBlockHash: receipt.blockHash,
      background: backgrounds, reputation: { before, after } };
  }
  const warmup = [];
  for (const kind of orders[0]) warmup.push(await trial(-1, kind));
  const initial = await reputation();
  const trials = [];
  for (let round = 0; round < repetitions; round++) {
    for (const kind of orders[round % orders.length]) trials.push(await trial(round, kind));
    if ((round + 1) % 4 === 0) console.log("Completed paired benchmark round", round + 1, "of", repetitions);
  }
  const final = await reputation();
  const conditions = {};
  for (const kind of orders[0]) {
    const group = trials.filter(t => t.kind === kind);
    const background = group.flatMap(t => t.background);
    conditions[kind] = {
      honestAdmittedAndMined: group.length, honestAdmissionMs: describe(group.map(t => t.honestMs)),
      honestSimulationRpcMs: describe(group.map(t => t.honestSimulationRpcMs)),
      backgroundRejections: background.filter(b => b.outcome === "rejected").length,
      backgroundAdmittedAndMined: background.filter(b => b.mined).length, backgroundSimulationCalls: background.length,
      backgroundSimulationRpcMs: describe(background.map(v => v.simulationRpcMs)),
      honestStartedDuringBackgroundTrace: group.filter(t => t.backgroundActiveAtHonestSend > 0).length,
      seenDeltaDuringAdmission: group.reduce((sum, t) => sum + t.reputation.after.seen - t.reputation.before.seen, 0),
    };
  }
  return { burst, pairedRounds: repetitions, conditionOrders: orders, noisyWallet, honestWallet,
    observed: { conditions, ...(control === "valid" ? {
      lateMinusValid: comparison(trials, "late", "valid"), validMinusIdle: comparison(trials, "valid", "idle"),
    } : { lateMinusEarly: comparison(trials, "late", "early") }),
      lateMinusIdle: comparison(trials, "late", "idle"), reputation: { initial, final } },
    warmup, trials };
}

