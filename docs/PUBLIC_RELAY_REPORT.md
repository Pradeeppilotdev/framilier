# Public relay report

On 6 November 2026 the organizers' primary alternative mempool on chain `1337` admitted framilier's signed hash-chain workload. Its final public status was `Cancelled`. The execution receipt was null at the 14:02 IST recheck. The same workload mined separately on private chain `8141337`.

| Item | Value |
| --- | --- |
| Public transaction | [0x89d35f0f123f0ae0bca2f6775ecb6b0e46a168cc351aa8095be12a319b109e2a](https://explorer.altmempool.wtf/tx/0x89d35f0f123f0ae0bca2f6775ecb6b0e46a168cc351aa8095be12a319b109e2a?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| Mined stake transaction | [0x93cdd6fe08f4523b84f05a0a07fb7f643d4cdc47cf3d675efca8f59455469651](https://explorer.altmempool.wtf/tx/0x93cdd6fe08f4523b84f05a0a07fb7f643d4cdc47cf3d675efca8f59455469651?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc), public block 966 |
| Public RPC submission | 13:35:46 IST, after the organizers' 2M-declaration example mined in block 913 |
| Explorer events in IST | Admitted 13:35:46.454. Submitted 13:35:47.107, 13:35:56.931, 13:36:06.926 and 13:36:16.943. Dropped 13:36:26.944. |
| Exact terminal reason | `relayed 4 times without being included in a block` |
| Node identity | Primary sidecar boot ID `bb2fdf74c0a68783` at submission and at the recheck |

The participant submitted one high-budget candidate. The four subsequent submissions are sidecar relay events. The stake and deployment have successful public receipts. All recorded admission checks for the high-budget candidate passed.

A separate execution RPC dry-run of the identical signed bytes returned `executionStatus: success`, two successful frames and 993,512 VERIFY gas. It also returned `canonicalMempoolValid: false` with `prefix gas budget exceeded: 1000000 > 100000 (MAX_VERIFY_GAS)`. The canonical mempool check and the alternative relay are separate paths. The public lifecycle records the terminal reason above. Attributing the omission to the cap requires the relay or builder's per-attempt logs.

For the operators: can the primary relayer or builder logs identify the submission response, target block or payload-selection reason for this hash between **08:05:47 and 08:06:27 UTC**? The claim here covers this transaction only.

[Public receipts, admission and simulation snapshot](../sidecar/evidence/public-admission-1337.json) · [Public submission code](../sidecar/test/framilier/public-inclusion.mjs) · [Separate private mined receipt](../sidecar/evidence/private-inclusion.json)
