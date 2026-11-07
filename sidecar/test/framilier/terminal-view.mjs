import { stripVTControlCharacters } from "node:util";

export function useTerminalView(stream, plain = false) {
  return Boolean(stream?.isTTY && !plain && process.env.TERM !== "dumb");
}

const labels = { off: "Off", fifo: "FIFO", fair: "Fair" };
const statuses = { complete: "Complete", "baseline-only": "Baseline only", incomplete: "Incomplete", failed: "Failed", running: "Running", unavailable: "Unavailable", "in-progress": "In progress" };
const ms = value => `${value.toFixed(1)} ms`;

// The observer timestamps A and B against the same clock. A trace that ends
// exactly as B starts has finished; one starting at that instant is running.
function snapshot(trial, burst) {
  const at = trial?.beforeHonestTraceMs;
  if (!Number.isFinite(at) || at < 0 || at > trial.honestMs || trial.background?.length !== burst) return null;
  const state = { finished: 0, running: 0, later: 0 };
  for (const job of trial.background) {
    const start = job.traceStartRelativeToHonestMs;
    const end = job.traceEndRelativeToHonestMs;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    if (end <= at) state.finished++;
    else if (start <= at) state.running++;
    else state.later++;
  }
  return state;
}

export function renderTerminalReport(report, trialsByMode, { source = "saved", columns = 80, color = false } = {}) {
  const width = Number.isFinite(columns) && columns > 0 ? Math.min(96, Math.floor(columns)) : 80;
  const paint = (code, value) => color && value ? `\x1b[${code}m${value}\x1b[0m` : value;
  const accent = value => paint("1;36", value);
  const subdued = value => paint("90", value);
  const lines = [];
  function line(value = "") {
    // For narrow terminals reflow overlong captions; escape sequences never
    // consume a display column or get sliced in half.
    const plain = stripVTControlCharacters(value);
    if (plain.length <= width) { lines.push(value); return; }
    let rest = plain.trim();
    while (rest.length > width) {
      const space = rest.lastIndexOf(" ", width);
      const end = space > 0 ? space : width;
      lines.push(rest.slice(0, end).trimEnd());
      rest = rest.slice(end).trimStart();
    }
    if (rest) lines.push(rest);
  }
  function heading(title, detail) {
    const gap = width - title.length - detail.length;
    if (gap >= 3) line(paint("1", title) + " ".repeat(gap) + subdued(detail));
    else { line(paint("1", title)); line(subdued(detail)); }
  }

  const burst = Math.max(...report.bursts);
  const roundCount = report.rounds;
  const modes = Object.keys(labels).filter(mode => report.requestedModes.includes(mode));
  const rows = [];
  const pending = [];
  let inclusions = 0;
  for (const mode of modes) {
    const arm = report.policies[mode];
    const label = mode === "off" && arm?.status === "measured" && !arm.schedulerReadback ? "Default" : labels[mode];
    if (arm?.status !== "measured") {
      pending.push(`${label}: ${statuses[arm?.status] ?? "Awaiting measurement"}`);
      continue;
    }
    const summary = arm.summary.find(row => row.burst === burst);
    const trial = trialsByMode?.[mode]?.find(t => t.round === 0 && t.burst === burst);
    if (summary) rows.push({ label, summary, state: snapshot(trial, burst) });
    inclusions += arm.summary.reduce((sum, r) => sum + r.aMined + r.bMined, 0);
  }

  heading("framilier  /  Admission scheduler", `${source === "saved" ? "Saved report" : "Live run"} · ${statuses[report.status] ?? "Unknown status"}`);
  line(accent("━".repeat(width)));
  line(`Local chain ${report.chainId}   ·   Burst ${burst}   ·   ${roundCount} measured ${roundCount === 1 ? "round" : "rounds"} per load`);
  if (pending.length) line(pending.join("   ·   "));
  if (!rows.length) { line("No measured policies available."); return lines.join("\n"); }

  line();
  heading("Wallet B’s turn", `Round 1 of ${roundCount}`);
  line("Each tile shows one heavy check from A when B’s cheap check began.");
  line();
  for (const { label, state } of rows) {
    const name = paint("1", label.padEnd(8));
    if (!state) { line(`  ${name}Trace timing unavailable`); continue; }
    const { finished, running, later } = state;
    const strip = [
      ...Array(finished).fill(paint("36", "█")),
      ...Array(running).fill(paint("33", "▒")),
      ...Array(later).fill(subdued("░")),
    ].join(" ");
    const description = `${finished} finished · ${running} running · ${later} yet to start`;
    const card = `  ${name}${strip}   ${description}`;
    if (stripVTControlCharacters(card).length <= width) line(card);
    else { line(`  ${name}${strip}`); line(`    ${description}`); }
  }

  line();
  heading("Admission time", `${burst} heavy ${burst === 1 ? "transaction" : "transactions"} from A`);
  const single = roundCount === 1;
  const showTail = roundCount >= 20;
  const metric = showTail ? "B p95" : single ? "B time" : "B median";
  const batchMetric = single ? "A batch" : "A batch median";
  const number = row => showTail ? row.bAdmissionMs.p95 : row.bAdmissionMs.p50;
  const maximum = Math.max(...rows.map(({ summary }) => number(summary)));
  const wide = width >= 70;
  const barWidth = wide ? Math.min(32, width - 53) : Math.max(3, Math.min(24, width - 22));
  if (wide) line(`  ${"Policy".padEnd(8)}${metric.padStart(barWidth + 11)}${showTail ? "B median".padStart(12) : ""}${batchMetric.padStart(17)}`);
  for (const { label, summary } of rows) {
    const value = number(summary);
    const lit = maximum > 0 && value > 0 ? Math.max(1, Math.round(value / maximum * barWidth)) : 0;
    const bar = paint(label === "Fair" ? "36" : "34", "█".repeat(lit)) + subdued("░".repeat(barWidth - lit));
    const batch = summary.aBatchMs ? ms(summary.aBatchMs.p50) : "—";
    if (wide) {
      line(`  ${label.padEnd(8)}${bar} ${ms(value).padStart(10)}${showTail ? ms(summary.bAdmissionMs.p50).padStart(12) : ""}${batch.padStart(17)}`);
    } else {
      line(`  ${paint("1", label)}  ${metric} ${ms(value)}`);
      line(`  ${bar}`);
      const aMetric = `${batchMetric} ${batch}`;
      const bMetric = `B median ${ms(summary.bAdmissionMs.p50)}`;
      if (showTail && 2 + bMetric.length + 3 + aMetric.length <= width) {
        line(`  ${bMetric} · ${aMetric}`);
      } else {
        if (showTail) line(`  ${bMetric}`);
        line(`  ${aMetric}`);
      }
    }
  }
  line();
  line(subdued("─".repeat(width)));
  line(`${inclusions.toLocaleString("en-US")} recorded inclusions across all measured loads and policies.`);
  if (roundCount < 20) line("Smoke run · use the full comparison for tail latency.");
  line(subdued("Use --plain for every burst and percentile."));
  return lines.join("\n");
}
