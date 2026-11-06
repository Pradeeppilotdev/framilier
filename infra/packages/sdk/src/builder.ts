import { encodeAbiParameters, parseAbiParameters, Hex, toHex, concat } from 'viem';
import { Frame, FrameMode, FrameTransaction, BuildFrameTxOptions, ZKRecoveryParams } from './types.js';
import { DEVNET_ENDPOINTS, GAS_LIMITS, DEPLOYED_CONTRACTS, DEMO_TENANT } from './constants.js';

/**
 * Builds an EIP-8141 Frame Transaction supporting both Self-Paid and Sponsored Multi-Tenant modes.
 */
export function buildFrameTransaction(options: BuildFrameTxOptions): FrameTransaction {
  const isSelfPaid = options.paymentMode ? options.paymentMode === 'self' : options.selfPaid !== false;
  const frames: Frame[] = [];

  if (isSelfPaid) {
    // MODE A: SELF-PAID (Account pays gas directly via 0x03)
    // Frame 0: VERIFY mode on the smart account
    const validationPrefix = options.validationData || '0x01'; // 0x01 indicates isSelfPaid flag
    frames.push({
      mode: FrameMode.VERIFY,
      target: options.account,
      gasLimit: options.gasLimit || GAS_LIMITS.DEFAULT_VERIFY_GAS,
      value: 0n,
      data: validationPrefix,
    });

    // Frame 1: SENDER mode on the target contract
    frames.push({
      mode: FrameMode.SENDER,
      target: options.target,
      gasLimit: options.gasLimit || GAS_LIMITS.EXECUTION_GAS,
      value: options.value || 0n,
      data: options.callData,
    });
  } else {
    // MODE B: SPONSORED (Multi-Tenant Paymaster pays gas via 0x01, Account approves execution via 0x02)
    const paymasterAddress = options.paymaster || DEPLOYED_CONTRACTS.MULTI_TENANT_PAYMASTER;
    const tenantId = options.tenantId || DEMO_TENANT.TENANT_ID;
    const paymasterData = options.paymasterData || tenantId;

    // Frame 0: VERIFY mode on Paymaster (Approves Payment 0x01)
    frames.push({
      mode: FrameMode.VERIFY,
      target: paymasterAddress,
      gasLimit: 120_000n,
      value: 0n,
      data: paymasterData,
    });

    // Frame 1: VERIFY mode on Account (Approves Execution 0x02)
    const validationPrefix = options.validationData || '0x00'; // 0x00 indicates sponsored flag
    frames.push({
      mode: FrameMode.VERIFY,
      target: options.account,
      gasLimit: options.gasLimit || GAS_LIMITS.DEFAULT_VERIFY_GAS,
      value: 0n,
      data: validationPrefix,
    });

    // Frame 2: SENDER mode on target contract
    frames.push({
      mode: FrameMode.SENDER,
      target: options.target,
      gasLimit: options.gasLimit || GAS_LIMITS.EXECUTION_GAS,
      value: options.value || 0n,
      data: options.callData,
    });
  }

  return {
    type: 6,
    chainId: options.chainId || DEVNET_ENDPOINTS.CHAIN_ID,
    nonce: options.nonce || 0n,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas || 1_000_000_000n,
    maxFeePerGas: options.maxFeePerGas || 20_000_000_000n,
    frames,
  };
}

/**
 * Builds a Frame Transaction specifically for ZK Guardian Recovery and Signature Rotation.
 * Consumes ~260,000 verify gas, automatically qualifying for the Alt-Mempool!
 * Supports timelocked challenge periods to protect against leaked guardian secrets.
 */
export function buildZKRecoveryFrameTransaction(
  validatorAddress: Hex,
  params: ZKRecoveryParams,
  options?: Partial<BuildFrameTxOptions>
): FrameTransaction {
  const isSelfPaid = params.selfPaid !== false;
  const instant = params.instant ?? false;

  // Encode ZK Recovery payload:
  // actionType: 1 (ZK Recovery)
  // isSelfPaid: 1 or 0
  // ABI encoded: (nullifierHash, newSignatureCommitment, newOwner, instant, zkProof)
  const encodedZkData = encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, address, bool, bytes'),
    [params.nullifierHash, params.newSignatureCommitment, params.newOwner, instant, params.proof]
  );

  const header = concat([
    toHex(1, { size: 1 }), // actionType = 1 (ZK Recovery)
    toHex(isSelfPaid ? 1 : 0, { size: 1 }) // isSelfPaid flag
  ]);

  const frameData = concat([header, encodedZkData]);

  const frames: Frame[] = [
    {
      mode: FrameMode.VERIFY,
      target: validatorAddress,
      gasLimit: GAS_LIMITS.ZK_VERIFY_GAS, // ~260,000 gas, triggers Alt-Mempool routing!
      value: 0n,
      data: frameData,
    },
    {
      mode: FrameMode.SENDER,
      target: params.account,
      gasLimit: GAS_LIMITS.EXECUTION_GAS,
      value: 0n,
      data: '0x',
    },
  ];

  return {
    type: 6,
    chainId: options?.chainId || DEVNET_ENDPOINTS.CHAIN_ID,
    nonce: options?.nonce || 0n,
    maxPriorityFeePerGas: options?.maxPriorityFeePerGas || 1_000_000_000n,
    maxFeePerGas: options?.maxFeePerGas || 20_000_000_000n,
    frames,
  };
}
