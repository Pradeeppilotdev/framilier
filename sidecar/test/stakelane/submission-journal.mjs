import assert from "node:assert/strict";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { decodeFrameTx, encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";

// Install a complete intent before broadcasting. link() preserves the original
// if a concurrent process has already chosen a transaction for the same step.
export async function saveSubmissionIntent(file, contents) {
  const directory = await mkdtemp(path.join(path.dirname(file), ".intent-"));
  const temp = path.join(directory, "intent.json");
  try {
    await writeFile(temp, contents, { mode: 0o600 });
    await link(temp, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Recovery only rebroadcasts the original signed bytes, never rebuilds with a
// new nonce, fee or signature. Infrastructure errors propagate before broadcast.
export async function recoverSubmission(intent, isFrame, observe) {
  for (const kind of isFrame ? ["receipt", "transaction", "sidecar"] : ["receipt", "transaction"]) {
    const result = await observe(kind, intent.hash);
    if (result === null) continue;
    assert.ok(result && typeof result === "object" && !Array.isArray(result), `Invalid ${kind} observation; cannot confirm absence`);
    return null;
  }
  const raw = intent.signedTransaction;
  assert.ok(raw, "Legacy journal lacks signed bytes; inspect its hash before manual recovery");
  assert.equal(keccak256(raw), intent.hash, "Journal signed bytes do not match saved hash");
  if (!isFrame) return [raw];
  assert.ok(raw.startsWith("0x06"), "Journal is not a frame transaction");
  const tx = decodeFrameTx(toBytes(`0x${raw.slice(4)}`));
  assert.equal(encodeRawFrameTx(tx), raw, "Frame journal is not canonical");
  return [tx];
}
