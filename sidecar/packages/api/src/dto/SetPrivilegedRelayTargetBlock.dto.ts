import { Matches } from "class-validator";
import { Hex } from "viem";

export class SetPrivilegedRelayTargetBlockArgs {
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  txHash!: Hex;

  @Matches(/^0x[0-9a-fA-F]+$/)
  targetBlock!: Hex;
}
