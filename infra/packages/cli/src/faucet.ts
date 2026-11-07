import { DEVNET_ENDPOINTS } from '@frameforge/sdk';

export interface FaucetResponse {
  txHash: string;
  amount: string;
}

export async function requestDevnetFaucet(recipientAddress: string): Promise<FaucetResponse> {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'skandha_explorer_faucet',
    params: [recipientAddress],
  };

  const response = await fetch(DEVNET_ENDPOINTS.DEVNET_1.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`Faucet RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  return data.result as FaucetResponse;
}

