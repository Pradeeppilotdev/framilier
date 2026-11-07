# FrameForge

> **Modular Account & Frame Infrastructure for EIP-8141 & ERC-8421**

FrameForge provides an end-to-end developer stack for constructing, verifying, and dispatching EIP-8141 Native Frame Transactions, pluggable ZK Recovery, and dual-mode execution (Self-Paid vs SimplePaymaster, and Public Mempool vs ERC-8421 Alt-Mempool).

---

## 📦 Monorepo Architecture

FrameForge is organized as a modular pnpm workspace:

| Package | Path | Description |
| :--- | :--- | :--- |
| **`@frameforge/contracts`** | `packages/contracts` | Smart contracts: `FrameAccount.sol` (ERC-8286 compliant), `ZKRecoveryValidator.sol` (ZK Nullifier Recovery), and `SimplePaymaster.sol` (EIP-8141 gas sponsorship). |
| **`@frameforge/sdk`** | `packages/sdk` | Core transaction builder (`buildFrameTransaction`, `buildZKRecoveryFrameTransaction`), ZK proof generation, Merkle tree math, and nullifier management. |
| **`@frameforge/viem`** | `packages/viem` | Viem extension for EIP-8141 Frame Transactions with automated pre-flight simulation (`simulateFrameAdmission`) and dual-mempool dispatch (`sendFrameTransaction`). |
| **`@frameforge/cli`** | `packages/cli` | Developer CLI (`frameforge`) for creating modular accounts, funding via devnet faucet, dispatching frame transactions with dual toggles, and executing ZK recovery. |

---

## 🎛️ Dual-Mode Architecture

### Toggle 1: Payment Mode (`self-paid` vs `sponsored`)
* **Self-Paid (`APPROVE_ALL = 0x03`)**: The `FrameAccount` pays its own gas fee directly in native ETH.
  * Structure: 2 frames (`[VERIFY Account, SENDER Target]`).
* **Sponsored (`APPROVE_PAY = 0x01` + `APPROVE_EXEC = 0x02`)**: `SimplePaymaster` sponsors the transaction gas.
  * Structure: 3 frames (`[VERIFY SimplePaymaster, VERIFY Account, SENDER Target]`).

### Toggle 2: Mempool Routing (`public` vs `altmempool`)
* **Canonical Public Mempool (`<= 100,000` VERIFY gas)**:
  * For standard lightweight validation (e.g. single ECDSA signature checks).
  * Dispatched to the canonical L1/L2 RPC endpoint (`https://altmempool.forshtat.com`).
* **ERC-8421 Alt-Mempool Gateway (`> 100,000` VERIFY gas)**:
  * For heavy cryptographic validation (e.g. `ZKRecoveryValidator` Groth16 verification consuming **~260,000 gas**).
  * Dispatched to the Alt-Mempool gateway (`https://altmempoolgateway.forshtat.com/rpc`).

---

## 🛠️ CLI Usage (Built on Top of the SDK)

```bash
# 1. Create a Modular Smart Account
node packages/cli/dist/bin/frameforge.js create-wallet

# 2. Fund Wallet via Devnet Faucet
node packages/cli/dist/bin/frameforge.js faucet --address <ACCOUNT_ADDRESS>

# 3. Dispatch Frame Transaction with Toggles
# Self-Paid via Public Mempool
node packages/cli/dist/bin/frameforge.js send-tx --account <ACCOUNT> --target <TARGET> --payment self --route public

# Sponsored via SimplePaymaster
node packages/cli/dist/bin/frameforge.js send-tx --account <ACCOUNT> --target <TARGET> --payment sponsored

# Force Alt-Mempool Gateway
node packages/cli/dist/bin/frameforge.js send-tx --account <ACCOUNT> --target <TARGET> --route altmempool

# 4. Perform ZK Guardian Recovery (Auto-routed to Alt-Mempool)
node packages/cli/dist/bin/frameforge.js recover-zk --account <ACCOUNT> --new-owner <NEW_OWNER_ADDRESS>
```

---

## 🧪 Testing

Run the end-to-end integration test suite:
```bash
node test_e2e.mjs
```
