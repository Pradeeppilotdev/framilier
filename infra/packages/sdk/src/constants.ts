export const DEVNET_ENDPOINTS = {
  DEVNET_1: {
    rpc: 'https://altmempool.forshtat.com',
    gateway: 'https://altmempoolgateway.forshtat.com/rpc',
  },
  EXPLORER: 'https://altmempoolexplorer.forshtat.com',
  CHAIN_ID: 1337,
};

export const DEPLOYED_CONTRACTS = {
  ZK_RECOVERY_VALIDATOR: '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const,
  SIMPLE_PAYMASTER: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const,
};

export const GAS_LIMITS = {
  PUBLIC_MEMPOOL_MAX_VERIFY_GAS: 100_000n,
  ALT_MEMPOOL_MAX_VERIFY_GAS: 1_000_000n,
  DEFAULT_VERIFY_GAS: 80_000n,
  ZK_VERIFY_GAS: 260_000n, // Triggers Alt-Mempool!
  EXECUTION_GAS: 150_000n,
};
