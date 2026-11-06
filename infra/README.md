# FrameForge

> **Modular Account & Frame Infrastructure for EIP-8141 & ERC-8421**

FrameForge provides an end-to-end developer stack for constructing, verifying, and dispatching EIP-8141 Native Frame Transactions, pluggable ZK Recovery, and dual-mempool routing (Canonical Public Mempool & ERC-8421 Alternative Mempool).

---

## 📦 Monorepo Architecture

FrameForge is organized as a modular pnpm workspace:

| Package | Path | Description |
| :--- | :--- | :--- |
| **`@frameforge/contracts`** | `packages/contracts` | Smart contracts including `FrameAccount.sol` (ERC-8286 compliant), `ZKRecoveryValidator.sol`, `MultiTenantPaymaster.sol`, and `SimplePaymaster.sol`. |
| **`@frameforge/sdk`** | `packages/sdk` | Core transaction builder (`buildFrameTransaction`, `buildZKRecoveryFrameTransaction`), ZK proof generation, Merkle tree math, and nullifier management. |
| **`@frameforge/viem`** | `packages/viem` | Viem extension for EIP-8141 Frame Transactions with automated pre-flight simulation (`simulateFrameAdmission`) and dual-mempool dispatch (`sendFrameTransaction`). |
| **`@frameforge/cli`** | `packages/cli` | Developer CLI (`frameforge`) for creating modular accounts, funding via devnet faucet, dispatching frame transactions, and executing ZK recovery. |

---

## ⚡ How Mempool Routing Works (<=100k vs >100k Verification Gas)

EIP-8141 transactions consist of discrete frames executed in sequence (`VERIFY` mode frames followed by `SENDER` execution frames). 

Under the **ERC-8421 Alt-Mempool Specification** (`BUDGET-010`):

1. **Canonical Public Mempool (`<= 100,000` VERIFY gas)**:
   - For standard validation (e.g. single ECDSA signature checks or lightweight rules).
   - Total verification gas across all `VERIFY` frames must remain `<= 100,000`.
   - Dispatched to the canonical L1/L2 RPC endpoint (`https://altmempool.forshtat.com`).

2. **ERC-8421 Alt-Mempool (`> 100,000` VERIFY gas)**:
   - For heavy or complex cryptographic verification (such as Groth16 ZK-SNARK recovery proofs, Post-Quantum signature checks, or complex multi-tenant quota checks).
   - In FrameForge, `ZKRecoveryValidator` consumes `~260,000` verification gas, which mathematically exceeds the public mempool limit and requires admission into the Alternative Mempool.
   - Dispatched to the Alt-Mempool gateway (`https://altmempoolgateway.forshtat.com/rpc`).
   - Entities staked in the `NaiveStakingRegistry` unlock an elevated admission ceiling of up to **1,000,000 gas**.

---

## 🛠️ CLI Quickstart

Install dependencies and build:
```bash
pnpm install
pnpm run build
```

### 1. Create a Modular Smart Account
```bash
node packages/cli/dist/bin/frameforge.js create-wallet
```

### 2. Request Testnet ETH from the Devnet Faucet
```bash
node packages/cli/dist/bin/frameforge.js faucet --address <YOUR_ACCOUNT_ADDRESS>
```

### 3. Dispatch a Frame Transaction
```bash
# Self-Paid (Account pays native ETH)
node packages/cli/dist/bin/frameforge.js send-tx --account <ACCOUNT> --target <TARGET> --self-paid

# Sponsored (Paymaster covers gas)
node packages/cli/dist/bin/frameforge.js send-tx --account <ACCOUNT> --target <TARGET> --sponsored
```

### 4. Execute ZK Guardian Recovery & Post-Quantum Sig Upgrade
```bash
node packages/cli/dist/bin/frameforge.js recover-zk --account <ACCOUNT> --new-owner <NEW_OWNER_ADDRESS>
```

---

## 🧪 Testing

Run the end-to-end integration test suite:
```bash
node test_e2e.mjs
```
Verifies account creation, self-paid frame routing, paymaster sponsored 3-frame pipeline, and ZK recovery alt-mempool admission.
