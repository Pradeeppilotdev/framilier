import { FrameTransaction } from '@frameforge/sdk';
import { simulateFrameAdmission, sendFrameTransaction, AdmissionResult } from './actions.js';

export interface FrameActions {
  simulateFrameAdmission(frameTx: FrameTransaction): Promise<AdmissionResult>;
  sendFrameTransaction(
    frameTx: FrameTransaction,
    options?: { forceAltMempool?: boolean; gatewayUrl?: string }
  ): Promise<{ txHash: string; endpointUsed: string; admission: AdmissionResult }>;
}

/**
 * Viem client decorator that adds native EIP-8141 & Alt-Mempool actions.
 */
export function frameActions() {
  return (client: any): FrameActions => ({
    simulateFrameAdmission: (frameTx: FrameTransaction) => simulateFrameAdmission(client, frameTx),
    sendFrameTransaction: (frameTx: FrameTransaction, options?: { forceAltMempool?: boolean; gatewayUrl?: string }) =>
      sendFrameTransaction(client, frameTx, options),
  });
}
