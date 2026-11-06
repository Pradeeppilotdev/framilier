import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { toHex } from "viem";

const zeroHash = "0x" + "00".repeat(32);

export class RpcError extends Error {
  constructor(method, error) {
    super(method + ": " + error.message);
    this.code = error.code;
    this.rpcMessage = error.message;
    this.data = error.data;
  }
}

export async function rpc(url, method, params = [], jwt) {
  const headers = { "content-type": "application/json" };
  if (jwt) {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    const message = header + "." + payload;
    const signature = createHmac("sha256", jwt).update(message).digest("base64url");
    headers.authorization = "Bearer " + message + "." + signature;
  }
  const response = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }, (_, v) =>
      typeof v === "bigint" ? toHex(v) : v),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(method + " HTTP " + response.status);
  const body = await response.json();
  if (body.error) throw new RpcError(method, body.error);
  assert.ok(Object.hasOwn(body, "result"), method + " missing result");
  return body.result;
}

// Drive an isolated Hegota execution chain. ethrex constructs the payload,
// executes it, validates it on import, and serves the canonical block/receipt.
export function privateProducer(executionUrl, engineUrl, jwt, feeRecipient) {
  const engine = (method, params) => rpc(engineUrl, method, params, jwt);
  const head = () => rpc(executionUrl, "eth_getBlockByNumber", ["latest", false]);
  const forkChoice = hash => ({ headBlockHash: hash, safeBlockHash: hash, finalizedBlockHash: hash });
  async function produce() {
    const parent = await head();
    const attributes = {
      timestamp: toHex(BigInt(parent.timestamp) + 6n),
      prevRandao: zeroHash, suggestedFeeRecipient: feeRecipient, withdrawals: [],
      parentBeaconBlockRoot: zeroHash,
      slotNumber: toHex(BigInt(parent.slotNumber ?? parent.number) + 1n),
      targetGasLimit: parent.gasLimit, inclusionListTransactions: [],
    };
    const start = await engine("engine_forkchoiceUpdatedV5", [forkChoice(parent.hash), attributes]);
    assert.equal(start.payloadStatus.status, "VALID", JSON.stringify(start));
    assert.ok(start.payloadId, "ethrex did not start building a payload");
    await pause(350);
    const built = await engine("engine_getPayloadV6", [start.payloadId]);
    const payload = built.executionPayload;
    assert.ok(payload.blockAccessList, "missing Amsterdam block access list");
    assert.equal(built.blobsBundle?.commitments?.length ?? 0, 0, "unexpected blob transaction in isolated fixture");
    const imported = await engine("engine_newPayloadV6", [
      payload, [], zeroHash, built.executionRequests ?? [], [],
    ]);
    assert.equal(imported.status, "VALID", JSON.stringify(imported));
    const selected = await engine("engine_forkchoiceUpdatedV5", [forkChoice(payload.blockHash), null]);
    assert.equal(selected.payloadStatus.status, "VALID", JSON.stringify(selected));
    const canonical = await head();
    assert.equal(canonical.hash, payload.blockHash);
    return canonical;
  }
  async function receipts(hashes, relay) {
    const results = new Map();
    const pending = new Set(hashes);
    for (let n = 0; pending.size && n < 8; n++) {
      if (relay) await relay();
      await produce();
      for (const hash of pending) {
        const mined = await rpc(executionUrl, "eth_getTransactionReceipt", [hash]);
        if (!mined) continue;
        assert.equal(mined.transactionHash, hash);
        assert.equal(mined.status, "0x1", "transaction reverted: " + hash);
        const canonical = await rpc(executionUrl, "eth_getBlockByNumber", [mined.blockNumber, false]);
        assert.equal(canonical.hash, mined.blockHash);
        assert.ok(canonical.transactions.includes(hash), "hash absent from canonical block");
        const block = { number: canonical.number, hash: canonical.hash, transactions: canonical.transactions };
        results.set(hash, { receipt: mined, block });
        pending.delete(hash);
      }
    }
    assert.equal(pending.size, 0, "Missing canonical receipts after eight private blocks: " + [...pending].join(", "));
    return results;
  }
  async function receipt(hash) {
    return (await receipts([hash])).get(hash);
  }
  return { produce, receipts, receipt };
}

