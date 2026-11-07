const fs = require('fs');
const path = require('path');
const { createWalletClient, createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const RPC_URL = process.env.DEVNET_RPC || 'https://altmempool.forshtat.com';
const PRIVATE_KEY = process.env.DEPLOYER_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const devnetChain = {
  id: 1337,
  name: 'EIP-8141 Devnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const artifactsDir = path.join(__dirname, 'artifacts');

function loadArtifact(name) {
  const file = path.join(artifactsDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Artifact ${name} not found. Run compile.js first.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function deploy() {
  console.log('\n======================================================');
  console.log('   🚀  FrameForge Live Devnet Contract Deployer');
  console.log('======================================================');
  console.log(`Target RPC: ${RPC_URL}`);

  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`Deployer Address: ${account.address}`);

  const publicClient = createPublicClient({ chain: devnetChain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: devnetChain, transport: http(RPC_URL) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer Balance: ${Number(balance) / 1e18} ETH`);

  const zkAddress = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
  console.log(`✅ ZKRecoveryValidator Already Deployed at: ${zkAddress}`);

  // Deploy SimplePaymaster
  console.log('\n--- Deploying SimplePaymaster.sol ---');
  const paymasterArtifact = loadArtifact('SimplePaymaster');
  const pmDeployHash = await walletClient.deployContract({
    abi: paymasterArtifact.abi,
    bytecode: `0x${paymasterArtifact.bytecode}`,
    args: [],
    value: 100000000000000000n, // Deposit 0.1 ETH
  });
  console.log(`SimplePaymaster Deploy Tx: ${pmDeployHash}`);
  console.log('Waiting for block confirmation...');
  const pmReceipt = await publicClient.waitForTransactionReceipt({ hash: pmDeployHash });
  console.log(`✅ SimplePaymaster Deployed at: ${pmReceipt.contractAddress} (Funded with 0.1 ETH)`);

  // Authorize wildcard address(0) to sponsor any user for demo testing
  console.log('Authorizing universal demo sponsorship on Paymaster...');
  const authTx = await walletClient.writeContract({
    address: pmReceipt.contractAddress,
    abi: paymasterArtifact.abi,
    functionName: 'setAuthorizedSender',
    args: ['0x0000000000000000000000000000000000000000', true],
  });
  await publicClient.waitForTransactionReceipt({ hash: authTx });
  console.log(`✅ Paymaster sponsorship authorization confirmed: ${authTx}`);

  // Save deployment manifest
  const manifest = {
    network: 'EIP-8141 Devnet',
    rpc: RPC_URL,
    gateway: 'https://altmempoolgateway.forshtat.com/rpc',
    explorer: 'https://altmempoolexplorer.forshtat.com',
    chainId: 1337,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    contracts: {
      ZKRecoveryValidator: zkAddress,
      SimplePaymaster: pmReceipt.contractAddress,
    },
    explorerUrls: {
      ZKRecoveryValidator: `https://altmempoolexplorer.forshtat.com/address/${zkAddress}`,
      SimplePaymaster: `https://altmempoolexplorer.forshtat.com/address/${pmReceipt.contractAddress}`,
      paymasterDeployTx: `https://altmempoolexplorer.forshtat.com/tx/${pmDeployHash}`,
    },
  };

  const manifestPath = path.join(__dirname, 'deployment-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n======================================================`);
  console.log(`🎉 Both Contracts Successfully Deployed on Devnet!`);
  console.log(`======================================================\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

deploy().catch(console.error);
