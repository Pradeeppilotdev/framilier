import { keccak256, encodePacked, Hex, toHex, stringToHex } from 'viem';

export interface Guardian {
  secret: Hex;
  nullifierSecret: Hex;
}

/**
 * Creates a guardian leaf hash from secrets.
 */
export function computeGuardianLeaf(secret: Hex, nullifierSecret: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [secret, nullifierSecret]));
}

/**
 * Computes a Merkle root from an array of leaves.
 */
export function computeMerkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  let currentLevel = [...leaves];
  while (currentLevel.length > 1) {
    const nextLevel: Hex[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        nextLevel.push(keccak256(encodePacked(['bytes32', 'bytes32'], [currentLevel[i], currentLevel[i + 1]])));
      } else {
        nextLevel.push(currentLevel[i]);
      }
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0];
}

/**
 * Computes the nullifier hash (prevents double-recovery).
 */
export function computeNullifierHash(nullifierSecret: Hex): Hex {
  return keccak256(encodePacked(['string', 'bytes32'], ['FRAME_GUARDIAN_NULLIFIER', nullifierSecret]));
}

/**
 * Generates a mock or real Groth16 proof byte sequence for testing.
 */
export function generateZKRecoveryProof(
  root: Hex,
  nullifierHash: Hex,
  newSignatureCommitment: Hex,
  newOwner: Hex
): Hex {
  // Computes the cryptographic challenge matching ZKRecoveryValidator.sol
  const challenge = keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'bytes32', 'address'],
      [root, nullifierHash, newSignatureCommitment, newOwner]
    )
  );
  
  // Pad out to 128 bytes to simulate full Groth16 A, B, C point values
  return (challenge + '00'.repeat(96)) as Hex;
}

/**
 * Generates a Post-Quantum signature key commitment (e.g. Dilithium / Falcon public key hash).
 */
export function createPQKeyCommitment(pqPublicKeyString: string): Hex {
  return keccak256(stringToHex(`POST_QUANTUM_ML_DSA_PUBKEY:${pqPublicKeyString}`));
}

