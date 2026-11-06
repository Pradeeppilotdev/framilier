import { describe, it, expect } from "vitest";
import { privateKeyToAccount, sign } from "viem/accounts";
import { keccak256, toHex, toBytes } from "viem";
import { p256 } from "@noble/curves/p256";
import { validateSignature } from "../../../src/services/FrameTxService/signature.js";
import { SIG_SCHEME } from "@skandha/types/lib/contracts/FrameTx.js";

function toPaddedHex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** Generates a fresh P256 keypair and its 32-byte-padded qx/qy hex halves
 * (no "0x" prefix), for building SIG_SCHEME.P256 signature payloads in tests. */
function genP256Keypair() {
  const privKey = p256.utils.randomPrivateKey();
  const uncompressedPubKey = p256.getPublicKey(privKey, false); // 0x04 || qx(32) || qy(32)
  const qxHex = toHex(uncompressedPubKey.slice(1, 33)).slice(2);
  const qyHex = toHex(uncompressedPubKey.slice(33, 65)).slice(2);
  return { privKey, uncompressedPubKey, qxHex, qyHex };
}

describe("validateSignature", () => {
  const pk = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const account = privateKeyToAccount(pk);
  const sigHash = "0x" + "11".repeat(32) as `0x${string}`;

  it("accepts a valid SECP256K1 signature with empty signer (defaults to tx.sender)", async () => {
    const { r, s, v } = await sign({ hash: sigHash, privateKey: pk });
    const vByte = Number(v! - 27n); // recovery id, per EIP-8141: v is 0 or 1
    const sigBytes = ("0x" +
      vByte.toString(16).padStart(2, "0") +
      r.slice(2) +
      s.slice(2)) as `0x${string}`;
    const result = await validateSignature(
      { scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: sigBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(true);
  });

  it("rejects a SECP256K1 signature with high-s (non-canonical)", async () => {
    // SECP256K1N // 2 + 1, an out-of-range high-s value per EIP-8141 §Signature Validation
    const highS = "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1";
    const sigBytes = ("0x00" + "11".repeat(32) + highS.slice(2)) as `0x${string}`;
    const result = await validateSignature(
      { scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: sigBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("rejects the explicit 32-byte zero digest as msg", async () => {
    const result = await validateSignature(
      { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: ("0x" + "00".repeat(32)) as `0x${string}`, signature: "0x" },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("accepts a valid P256 signature whose signer matches keccak256(qx||qy)[12:]", async () => {
    const { privKey, uncompressedPubKey, qxHex, qyHex } = genP256Keypair();
    const msgHashBytes = toBytes(sigHash);
    // Force a canonical (low-s) signature, per EIP-8141's s <= N/2 requirement —
    // @noble/curves' p256 curve config defaults to lowS: false for sign().
    const sig = p256.sign(msgHashBytes, privKey, { lowS: true });
    // Sanity-check against the library's own verifier before round-tripping
    // through validateSignature, so a failure here can't be misread as a bug
    // in validateSignature itself.
    expect(p256.verify(sig, msgHashBytes, uncompressedPubKey, { lowS: false })).toBe(true);

    const signatureBytes = ("0x" + toPaddedHex(sig.r) + toPaddedHex(sig.s) + qxHex + qyHex) as `0x${string}`;

    // Per EIP-8141: resolved_signer == keccak256(qx || qy)[12:] (LAST 20 bytes).
    const expectedSigner = ("0x" + keccak256(("0x" + qxHex + qyHex) as `0x${string}`).slice(26)) as `0x${string}`;

    const result = await validateSignature(
      { scheme: SIG_SCHEME.P256, signer: expectedSigner, msg: "0x", signature: signatureBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(true);
  });

  it("rejects a P256 signature whose signer is derived from the first 20 bytes of keccak256(qx||qy) instead of the last 20", async () => {
    const { privKey, qxHex, qyHex } = genP256Keypair();
    const msgHashBytes = toBytes(sigHash);
    const sig = p256.sign(msgHashBytes, privKey, { lowS: true });
    const signatureBytes = ("0x" + toPaddedHex(sig.r) + toPaddedHex(sig.s) + qxHex + qyHex) as `0x${string}`;

    // Deliberately the WRONG derivation (first 20 bytes, not last 20) — this
    // is the exact bug that shipped in the initial implementation.
    const wrongSigner = ("0x" + keccak256(("0x" + qxHex + qyHex) as `0x${string}`).slice(2, 42)) as `0x${string}`;

    const result = await validateSignature(
      { scheme: SIG_SCHEME.P256, signer: wrongSigner, msg: "0x", signature: signatureBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("rejects a P256 signature with high-s (non-canonical)", async () => {
    const { qxHex, qyHex } = genP256Keypair();
    // SECP256R1N // 2 + 1, an out-of-range high-s value per EIP-8141 §Signature Validation
    const highS = "0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a9";
    const signatureBytes = ("0x" + "11".repeat(32) + highS.slice(2) + qxHex + qyHex) as `0x${string}`;

    const expectedSigner = ("0x" + keccak256(("0x" + qxHex + qyHex) as `0x${string}`).slice(26)) as `0x${string}`;

    const result = await validateSignature(
      { scheme: SIG_SCHEME.P256, signer: expectedSigner, msg: "0x", signature: signatureBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("ARBITRARY scheme requires empty signer", async () => {
    const result = await validateSignature(
      { scheme: SIG_SCHEME.ARBITRARY, signer: account.address, msg: "0x", signature: "0xdead" },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });
});
