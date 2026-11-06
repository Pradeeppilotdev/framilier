/**
 * "Simulating a frame transaction" means executing the EIP-8141
 * protocol-defined per-frame behavior directly against a real
 * EIP-8141-aware execution client (ethrex), not an ABI-encoded call to a
 * deployed EntryPoint contract. There is no on-chain contract to
 * `eth_call`/`debug_traceCall` against here.
 *
 * Eligible transactions make one traced-simulation RPC after the budget preflight:
 * `GethTracer.simulateFrameTransaction(rawTx, true)`. A traced response
 * carries every field an untraced one would (`gasUsed`/`frames`/`payer`/
 * `executionStatus`/`executionError`) plus `erc7562Trace` on top - so the
 * same response feeds both `FrameTxValidationService.validate(tx,
 * simResult)` (the admission-gate check, which needs the trace) and this
 * method's own gas/receipt mapping (which only needs the plain fields).
 * An earlier version of this method made two separate round trips (an
 * untraced call here, plus a second traced call inside `validate()`
 * fetching its own copy of the same simulation) - both redundant with
 * each other, since nothing about tracing changes the deterministic
 * gasUsed/frames/payer outcome of the same rawTx against the same block.
 */
import { Logger } from "@skandha/types/lib/index.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { ExecutionRevertedError, PublicClient, TransactionRejectedRpcError } from "viem";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  FrameSimulationReceipt,
  FrameSimulationStatus,
  FrameTxSimulationResult,
} from "@skandha/types/lib/executor/validation/frameTxSimulation.js";
import { encodeRawFrameTx } from "../FrameTxService/codec.js";
import { EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../ExplorerService/checkCollector.js";
import { GethTracer } from "../UserOpValidation/GethTracer.js";
import {
  FrameTxValidationResult,
  FrameTxValidationService,
  isEthrexTransactionRejection,
} from "../UserOpValidation/validators/frameTx.js";

import { SimulationWorkGate, SimulationLane } from "../AdmissionScheduler/SimulationWorkGate.js";

export interface FrameTxSimulateAndValidateResult {
  simulation: FrameTxSimulationResult;
  validation: FrameTxValidationResult;
}

export class FrameTxSimulationService {
  private gethTracer: GethTracer;

  constructor(
    publicClient: PublicClient,
    private frameTxValidationService: FrameTxValidationService,
    private logger: Logger,
    private workGate: SimulationWorkGate = new SimulationWorkGate()
  ) {
    this.gethTracer = new GethTracer(publicClient);
  }

  async simulate(
    tx: FrameTransaction,
    collector?: CheckCollector,
    lane: SimulationLane = "admission"
  ): Promise<FrameTxSimulateAndValidateResult> {
    return this.workGate.submit(lane, () => this.simulateNow(tx, collector));
  }

  private async simulateNow(tx: FrameTransaction, collector?: CheckCollector): Promise<FrameTxSimulateAndValidateResult> {
    // The same gate is used by RPC admission, gossip admission, estimates and
    // revalidation. Over-budget declarations must never trigger traced execution.
    const prepared = await this.frameTxValidationService.preflight(tx, collector);
    const rawTx = encodeRawFrameTx(tx);

    const result = await this.gethTracer
      .simulateFrameTransaction(rawTx, true)
      .catch(async (error) => {
        this.logger.error(error, "ethrex_simulateFrameTransaction failed");
        // viem supplies details for HTTP failures as well as RPC verdicts.
        // A generic server error is only a verdict when ethrex identifies
        // the transaction or its validation prefix as the cause.
        const detail = typeof error?.details === "string" ? error.details : undefined;
        const explicitRejection = error?.code === ExecutionRevertedError.code ||
          error?.code === TransactionRejectedRpcError.code;
        // The pinned ethrex uses -32015 for VM errors; older nodes also use
        // the generic -32000. Both may carry infrastructure failures.
        const executionError = error?.code === -32015 || error?.code === RpcErrorCodes.SERVER_ERROR;
        if (detail && (explicitRejection || (executionError && isEthrexTransactionRejection(detail)))) {
          const explained = await this.frameTxValidationService.explainFailure(
            tx,
            detail
          );
          collector?.fail(EXPLORER_RULES.SIMULATION, explained);
          throw new RpcError(explained, RpcErrorCodes.VALIDATION_FAILED);
        }
        const message = `ethrex_simulateFrameTransaction call failed: ${
          detail ?? error?.message ?? String(error)
        }`;
        collector?.fail(EXPLORER_RULES.SIMULATION, message);
        throw new Error(message);
      });

    // Mapped and handed to the collector as soon as the trace is known, so a
    // transaction rejected by `validate()` below (which reads the very same
    // `result`) still leaves its per-frame receipts on the collector for the
    // explorer - `simulate()`'s own return value below is never reached in
    // that case.
    //
    // ethrex's per-frame result is only `{gasUsed, succeeded}` - a simpler,
    // pre-existing shape that predates this plan and does not match
    // EIP-8141's full on-chain receipt encoding byte-for-byte (see
    // FrameSimulationReceipt's doc comment). `succeeded` maps onto the same
    // two-value "success"/"reverted" vocabulary `result.executionStatus`
    // already uses at the top level, so a consumer handling one handles the
    // other identically.
    const frameReceipts: FrameSimulationReceipt[] | undefined = result.frames?.map((frame) => ({
      status: (frame.succeeded ? "success" : "reverted") as FrameSimulationStatus,
      gasUsed: {
        execution: frame.gasUsed,
        // ethrex's simulation RPC doesn't currently break out
        // execution-vs-state gas separately - documented gap, not a real
        // zero reading. A mined receipt is the authoritative source once
        // one exists.
        state: "0x0",
      },
      // This simulation RPC doesn't capture logs - only a real mined
      // receipt (ReceiptService, via eth_getTransactionReceipt) would.
      logs: [],
    }));
    if (frameReceipts) collector?.setFrameReceipts(frameReceipts);

    // Admission-gate check, reusing this same traced result - no second
    // RPC round-trip. `validate()` throws its own RpcError on failure,
    // which propagates unchanged - callers see the same rejection reason
    // `sendFrameTransaction` enforces at submit time, not a generic
    // simulation failure.
    const validation = await this.frameTxValidationService.validate(
      tx,
      result,
      collector,
      prepared
    );

    // Fail closed, mirroring FrameTxValidationService.validate()'s own
    // convention: missing gas/frame data (`gasUsed`/`frames` are `null`
    // together whenever the tx was rejected before or during execution, per
    // EthrexSimulateFrameTransactionResult's doc comment) must not produce a
    // hollow/default FrameTxSimulationResult. `result.canonicalMempoolValid`
    // is deliberately NOT part of this condition: ethrex reports execution
    // results independently of its own canonical-mempool-policy opinion, and
    // `validate()` above already ran the sidecar's own ERC-7562/pre_verify-aware
    // admission check against this same trace - that, not ethrex's opinion,
    // is the real gate.
    if (result.gasUsed == null || result.frames == null || !frameReceipts) {
      throw new RpcError("ethrex omitted frame gas or receipt data after validation", RpcErrorCodes.INTERNAL_ERROR);
    }

    const simulation: FrameTxSimulationResult = {
      cumulativeGasUsed: result.gasUsed,
      payer: result.payer,
      frameReceipts,
    };

    return { simulation, validation };
  }
}
