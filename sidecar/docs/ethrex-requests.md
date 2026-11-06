# Requests for ethrex (`eip8141-tracer`)

Things the sidecar cannot do better without a change in the execution client. Each comes from the
traffic playground run of 2026-09-25 (`deploy/devnet/playground/`).

## Say which frame failed, and why, in `ethrex_simulateFrameTransaction`

When a simulation fails, the result carries only `executionError`, and for every failure of the
validation prefix that text is the same: `validation prefix frame reverted`. The explorer therefore
cannot tell these apart, and neither can the sender:

| Playground scenario | Actual cause | What ethrex says |
| --- | --- | --- |
| Sender has no funds | balance below the maximum cost | `validation prefix frame reverted` |
| Verification given 100 gas | out of gas | `validation prefix frame reverted` |
| Verification loops forever | out of gas | `validation prefix frame reverted` |
| Verification reverts | explicit revert | `validation prefix frame reverted` |
| Verification transfers value | write in a static (read-only) frame | `validation prefix frame reverted` |
| Verification calls a contract that reverts | nested revert | `validation prefix frame reverted` |

Please return, for a failed simulation, alongside `executionError`:

- `failedFrameIndex`: the index of the frame that failed;
- `haltReason`: one of `revert` (with the revert data), `out_of_gas`, `invalid_opcode`,
  `stack_error`, `static_violation`, `insufficient_funds`, `nonce_mismatch`;
- for `insufficient_funds`, the payer address, its balance and the required maximum cost.

With that sidecar can report the failing frame and map `out_of_gas` to its `out-of-gas` rule and
reverts to `execution`, instead of one generic `simulation` failure. Until then the sidecar checks the
payer's balance itself and lists the frame gas limits (`FrameTxValidationService.explainPrefixRevert`).
