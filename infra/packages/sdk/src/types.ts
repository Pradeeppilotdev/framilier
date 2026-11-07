import { Address, Hex } from 'viem';

export enum FrameMode {
  DEFAULT = 0, // Normal EVM execution
  VERIFY = 1,  // Validation / authorization
  SENDER = 2,  // Authenticated call as tx.sender
}

export enum ApprovalScope {
  NONE = 0x00,
  PAY = 0x01,
  EXEC = 0x02,
  ALL = 0x03, // Self-paid (both Pay and Exec)
}

export type PaymentMode = 'self' | 'sponsored';
export type RouteMode = 'public' | 'altmempool';

export interface Frame {
  mode: FrameMode;
  target: Address;
  gasLimit: bigint;
  value: bigint;
  data: Hex;
}

export interface FrameTransaction {
  type: 6; // EIP-8141 Frame Transaction Type
  chainId: number;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  frames: Frame[];
  signatures?: Hex[];
}

export interface BuildFrameTxOptions {
  account: Address;
  target: Address;
  callData: Hex;
  value?: bigint;
  gasLimit?: bigint;
  selfPaid?: boolean; // TOGGLE: true = Self-Paid (0x03), false = Sponsored (0x01 + 0x02)
  paymentMode?: PaymentMode;
  routeMode?: RouteMode;
  paymaster?: Address;
  paymasterData?: Hex;
  validationData?: Hex;
  chainId?: number;
  nonce?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface ZKRecoveryParams {
  account: Address;
  nullifierHash: Hex;
  newSignatureCommitment: Hex; // New key commitment (e.g. Post-Quantum key hash)
  newOwner: Address;
  proof: Hex; // Groth16 proof bytes
  selfPaid?: boolean;
  instant?: boolean; // false = timelocked with 24h veto; true = bypass delay if authorized
}
