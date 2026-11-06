import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { decodeFrameTx, encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";

// Recovery only rebroadcasts the original signed bytes, never rebuilds with a
// new nonce, fee or signature. Infrastructure errors propagate before broadcast.
export async function recoverSubmission(intent, isFrame, observe) {
  if (await observe("receipt", intent.hash)) return null;
  if (await observe("transaction", intent.hash)) return null;
  if (isFrame && await observe("sidecar", intent.hash)) return null;
  const raw = intent.signedTransaction;
  assert.ok(raw, "Legacy journal lacks signed bytes; inspect its hash before manual recovery");
  assert.equal(keccak256(raw), intent.hash, "Journal signed bytes do not match saved hash");
  if (!isFrame) return [raw];
  assert.ok(raw.startsWith("0x06"), "Journal is not a frame transaction");
  const tx = decodeFrameTx(toBytes(`0x${raw.slice(4)}`));
  assert.equal(encodeRawFrameTx(tx), raw, "Frame journal is not canonical");
  return [tx];
}
