import type { Check, Peer } from "../src/protocol/schemas";
import { MockNode, passingChecks, type MockFrame, type MockTx } from "./state";

/** The fixed base time used by tests, so their expectations never change. */
export const T0 = 1_760_000_000_000;

/** Deterministic pseudo-random hex, so fixture hashes and addresses look real and never change. */
function hexOf(seed: number, length: number): string {
  let x = (seed * 2_654_435_761) % 2 ** 32;
  let out = "";
  while (out.length < length) {
    x = (x * 1_664_525 + 1_013_904_223) % 2 ** 32;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export const hashOf = (seed: number): string => `0x${hexOf(seed, 64)}`;
export const addrOf = (seed: number): string => `0x${hexOf(seed + 1000, 40)}`;

const TOKEN = addrOf(20);
const PAYER = addrOf(10);
const FACTORY = addrOf(11);
const TRANSFER = `0xa9059cbb${hexOf(7, 128)}`;

const selfVerify: MockFrame = { mode: 1, flags: 3, target: null, execution: 30_000 };
const userOp = (data = TRANSFER): MockFrame => ({ mode: 2, flags: 0, target: TOKEN, execution: 60_000, data });

function selfRelay(seed: number, nonce: number, at: number, status: MockTx["status"] = "New"): MockTx {
  const sender = addrOf(seed);
  return {
    hash: hashOf(100 + seed),
    sender,
    payer: sender,
    nonce,
    status,
    frames: [{ ...selfVerify }, userOp()],
    maxFeePerGas: 2_000_000_000n,
    submittedTime: at,
  };
}

/**
 * Every fixture transaction, with times counted from `t0`. Tests use `TX`
 * (built from `T0`); the dev servers pass a `t0` just before "now" so the pages
 * read as recent.
 */
export function makeTx(t0: number) {
  return {
    onChain: selfRelay(1, 0, t0 + 1_000),
    sponsored: {
      hash: hashOf(102),
      sender: addrOf(2),
      payer: PAYER,
      nonce: 3,
      status: "New",
      frames: [
        { mode: 1, flags: 2, target: null, execution: 20_000 },
        { mode: 1, flags: 1, target: PAYER, execution: 25_000 },
        userOp(),
      ],
      maxFeePerGas: 3_500_000_000n,
      submittedTime: t0 + 30_000,
    } satisfies MockTx,
    fresh: selfRelay(3, 1, t0 + 60_000),
    bannedOpcode: selfRelay(4, 2, t0 + 65_000),
    noPrefix: {
      hash: hashOf(105),
      sender: addrOf(5),
      payer: addrOf(5),
      nonce: 0,
      status: "New",
      frames: [userOp()],
      maxFeePerGas: 1_000_000_000n,
      submittedTime: t0 + 68_000,
    } satisfies MockTx,
    waived: { ...selfRelay(8, 4, t0 + 70_000, "Pending"), payer: addrOf(8) },
    reverted: selfRelay(9, 5, t0 + 72_000),
    replacedOld: { ...selfRelay(6, 5, t0 + 80_000), hash: hashOf(106), maxFeePerGas: 1_500_000_000n },
    replacedNew: { ...selfRelay(6, 5, t0 + 95_000), hash: hashOf(107), maxFeePerGas: 4_000_000_000n },
    onlySecondary: selfRelay(12, 0, t0 + 100_000),
    withFactory: {
      hash: hashOf(113),
      sender: addrOf(13),
      payer: addrOf(13),
      factory: FACTORY,
      nonce: 0,
      status: "New",
      frames: [
        { mode: 0, flags: 0, target: FACTORY, execution: 200_000, state: 32_000 },
        { ...selfVerify },
        userOp(),
      ],
      maxFeePerGas: 2_000_000_000n,
      submittedTime: t0 + 110_000,
    } satisfies MockTx,
  };
}

/** The fixed-time set the tests use. */
export const TX = makeTx(T0);

const clean = (tx: MockTx): Check[] => passingChecks(tx);

const bannedOpcodeChecks: Check[] = [
  ...["gas-limit", "prefix", "structure", "signature", "simulation", "trace-alignment", "OP-061", "execution"].map(
    (rule): Check => ({ rule, verdict: "pass" }),
  ),
  { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "out-of-gas", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "payer uses banned opcode: DIFFICULTY" },
  { rule: "create", frameIndex: 0, entity: "payer", verdict: "pass" },
  {
    rule: "storage",
    frameIndex: 0,
    entity: "payer",
    verdict: "fail",
    detail: `unstaked payer accessed ${addrOf(30)} slot 0x0000000000000000000000000000000000000000000000000000000000000001`,
  },
  { rule: "COD-010", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "entrypoint-access", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "mempool", verdict: "skipped" },
];

const noPrefixChecks: Check[] = [
  { rule: "gas-limit", verdict: "pass" },
  { rule: "prefix", verdict: "fail", detail: "frame transaction validation prefix not recognized" },
  ...["structure", "signature", "simulation", "trace-alignment", "OP-061", "execution", "mempool"].map(
    (rule): Check => ({ rule, verdict: "skipped" }),
  ),
  ...["out-of-gas", "OP-011", "create", "storage", "COD-010", "entrypoint-access"].map(
    (rule): Check => ({ rule, verdict: "skipped" }),
  ),
];

const waivedChecks = (tx: MockTx): Check[] =>
  clean(tx).map((c) =>
    c.rule === "OP-011" && c.entity === "payer"
      ? { ...c, detail: "waived (whitelisted entity): payer uses banned opcode: GAS" }
      : c,
  );

export function peersAt(t0: number): Peer[] {
  return [
    {
      peerId: "16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4",
      direction: "outbound",
      connectedAt: t0 - 3_600_000,
      lastReceivedAt: t0 + 60_000,
      agentVersion: "skandha/4.1.1",
      supportedMempools: ["QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk"],
    },
    {
      peerId: "16Uiu2HAm3PqWzE9nD5sTt8fVhK2uYxAqGcJb7rLmN4oXdRe1Ca6p",
      direction: "inbound",
      connectedAt: t0 - 120_000,
      lastReceivedAt: t0 + 30_000,
      agentVersion: null,
      supportedMempools: [],
    },
  ];
}

export const PEERS: Peer[] = peersAt(T0);

const clone = (tx: MockTx): MockTx => ({ ...tx, frames: tx.frames.map((f) => ({ ...f })) });

/** The primary fixture node: a busy pool with one of every interesting state. */
export function seedPrimary(node: MockNode, t0 = T0): MockNode {
  const t = makeTx(t0);
  const peerA = "gossip:16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4";

  node.admit(clone(t.onChain), "rpc", undefined, t0 + 1_000);
  node.setStatus(t.onChain.hash, "Submitted", undefined, t0 + 2_500);
  node.setStatus(t.onChain.hash, "OnChain", undefined, t0 + 11_000);

  node.admit(clone(t.sponsored), peerA);
  node.setStatus(t.sponsored.hash, "Submitted", undefined, t0 + 31_000);

  node.admit(clone(t.fresh));
  node.reject(clone(t.bannedOpcode), bannedOpcodeChecks, peerA);
  node.reject(clone(t.noPrefix), noPrefixChecks, "rpc");
  node.admit(clone(t.waived), "rpc", waivedChecks(t.waived));
  node.admit(clone(t.reverted));
  node.setStatus(t.reverted.hash, "Reverted", "execution reverted: insufficient allowance", t0 + 74_000);
  node.admit(clone(t.replacedOld));
  node.replace(t.replacedOld.hash, clone(t.replacedNew), "rpc", t0 + 95_000);
  node.admit(clone(t.withFactory));

  node.setReputationEntry({
    address: addrOf(1),
    opsSeen: 12,
    opsIncluded: 11,
    status: "ok",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x6f05b59d3b20000", // 0.5 ETH
    unstakeDelaySec: 86_400,
    withdrawTime: "0x0",
    isStaked: true,
  });
  node.setReputationEntry({
    address: addrOf(4),
    opsSeen: 30,
    opsIncluded: 20,
    status: "throttled",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x0",
    unstakeDelaySec: 0,
    withdrawTime: "0x0",
    isStaked: false,
  });
  node.setReputationEntry({
    address: addrOf(5),
    opsSeen: 50,
    opsIncluded: 5,
    status: "banned",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x0",
    unstakeDelaySec: 0,
    withdrawTime: "0x0",
    isStaked: false,
  });

  return node;
}

/** A second node that saw part of the same traffic a little later, plus one transaction of its own. */
export function seedSecondary(node: MockNode, t0 = T0): MockNode {
  const t = makeTx(t0);
  const via = "gossip:16Uiu2HAm3PqWzE9nD5sTt8fVhK2uYxAqGcJb7rLmN4oXdRe1Ca6p";
  node.admit({ ...clone(t.onChain), submittedTime: t0 + 1_240 }, via, undefined, t0 + 1_240);
  node.setStatus(t.onChain.hash, "OnChain", undefined, t0 + 11_400);
  node.admit({ ...clone(t.fresh), submittedTime: t0 + 61_200 }, via, undefined, t0 + 61_200);
  node.admit(clone(t.onlySecondary), "rpc");
  return node;
}

export function primaryNode(now?: () => number, t0 = T0): MockNode {
  return seedPrimary(
    new MockNode({ name: "Devnet miner", bootId: "0a1b2c3d4e5f6071", peers: peersAt(t0), now }),
    t0,
  );
}

export function secondaryNode(now?: () => number, t0 = T0): MockNode {
  return seedSecondary(new MockNode({ name: "Local peer", bootId: "7160f5e4d3c2b1a0", p2pEnabled: false, now }), t0);
}

export function disabledNode(): MockNode {
  return new MockNode({ name: "No explorer", explorerEnabled: false });
}

/** A fresh self-relay transaction for live demos and browser tests (`n` picks its hash and sender). */
export function liveTx(n: number, at: number): MockTx {
  return { ...selfRelay(200 + n, 0, at), hash: hashOf(300 + n) };
}
