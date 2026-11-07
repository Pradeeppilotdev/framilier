import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";

const stages = {
  prepare: "Preparing fixture",
  chain: "Starting private chain",
  deploy: "Deploying wallets and sidecar",
  controls: "Checking stake and negative controls",
  measure: "Measuring admission and mining receipts",
  save: "Saving measured evidence",
  verify: "Verifying samples and receipt evidence",
};
const policyLabels = { off: "Off", fifo: "FIFO", fair: "Fair" };
const elapsed = value => `${Math.max(0, value / 1000).toFixed(1)}s`;
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f]/g, " ");

// Only the TTY coordinator constructs this view. These are observed lifecycle
// stages, never estimated percentages or animations of the measured queue.
export function createCompareProgress({ stream = process.stdout, plan, modes, chainId, now = () => performance.now() }) {
  let active;
  let timer;
  let lineOpen = false;
  const width = () => Math.max(10, Math.floor(stream.columns || 80) - 1);
  const write = text => stream.write(text);
  function wrapped(text) {
    let rest = clean(text);
    while (rest.length > width()) {
      const at = rest.lastIndexOf(" ", width());
      const end = at > 0 ? at : width();
      write(rest.slice(0, end).trimEnd() + "\n");
      rest = rest.slice(end).trimStart();
    }
    write(rest + "\n");
  }
  function render() {
    if (!active) return;
    const suffix = `  ${elapsed(now() - active.started)}`;
    const prefix = `[${active.index + 1}/${modes.length}] ${policyLabels[active.mode]}  `;
    const available = width() - prefix.length - suffix.length;
    const detail = available > 1 ? stages[active.stage].slice(0, available) : "";
    write("\r\x1b[2K" + (prefix + detail + suffix).slice(0, width()));
    lineOpen = true;
  }
  function stop() {
    clearInterval(timer);
    timer = undefined;
    if (lineOpen) { write("\r\x1b[2K"); lineOpen = false; }
  }
  wrapped("framilier / Live comparison");
  wrapped(`Private local chain ${chainId} · ${plan.rounds} measured ${plan.rounds === 1 ? "round" : "rounds"} per load`);
  wrapped(`Wallet A: bursts of ${plan.bursts.join(", ")} heavy checks. Wallet B: one cheap check per trial.`);
  wrapped(plan.sharedPaymaster ? "Fees: both wallets use one shared paymaster." : "Fees: each wallet pays for its own transactions.");
  wrapped("Off: scheduling disabled · FIFO: arrival order · Fair: sender turns");
  wrapped("Each policy starts a fresh chain; setup, warm-up and receipt checks take time.");
  if (plan.rounds < 20) wrapped("Smoke run: use 20 or more rounds to inspect tail latency.");
  write("\n");
  return {
    start(mode, index) {
      stop();
      active = { mode, index, stage: "prepare", started: now() };
      render();
      timer = setInterval(render, 1000);
      timer.unref();
    },
    stage(stage) {
      if (!active || !Object.hasOwn(stages, stage)) return;
      active.stage = stage;
      render();
    },
    complete(mined) {
      if (!active) return;
      const { mode, index, started } = active;
      stop();
      wrapped(`[${index + 1}/${modes.length}] ${policyLabels[mode]} complete · ${mined} measured transactions mined · ${elapsed(now() - started)}`);
      active = undefined;
    },
    failed(logPath) {
      if (!active) return;
      const { mode, index, started } = active;
      stop();
      wrapped(`[${index + 1}/${modes.length}] ${policyLabels[mode]} failed after ${elapsed(now() - started)}`);
      wrapped(`Diagnostics: ${logPath}`);
      active = undefined;
    },
    close() { stop(); active = undefined; },
  };
}

// Diagnostic output goes directly to a private file descriptor, so a long run
// cannot accumulate logs in the coordinator's memory or overwrite its display.
export async function runLoggedFixture({ executable, args, input, env, logPath, onStage }) {
  const fd = openSync(logPath, "wx", 0o600);
  let child;
  try {
    child = spawn(executable, args, { env, stdio: ["pipe", fd, fd, "ipc"] });
  } finally { closeSync(fd); }
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  child.on("message", message => {
    if (message?.type === "framilier:stage" && typeof message.stage === "string" && Object.hasOwn(stages, message.stage)) onStage?.(message.stage);
  });
  try {
    const closed = once(child, "close");
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const [code, signal] = await closed;
    if (code !== 0) throw new Error(`Fixture exited with ${signal || code}`);
  } catch (error) {
    throw new Error(`${error.message}; diagnostics: ${logPath}`, { cause: error });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
