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
    if (summary) rows.push({ mode, label, summary, state: snapshot(trial, burst) });
    inclusions += arm.summary.reduce((sum, r) => sum + r.aMined + r.bMined, 0);
  }

  heading("framilier  /  compare", `${source === "saved" ? "Saved report" : "Live run"} · ${statuses[report.status] ?? "Unknown status"}`);
  line(accent("━".repeat(width)));
  line(`Local chain ${report.chainId} · ${roundCount} measured ${roundCount === 1 ? "round" : "rounds"} per load`);
  line(paint("1", `Wallet A: ${burst} heavy checks   +   Wallet B: 1 cheap check`));
  line(`Fees: ${report.sharedPaymaster ? "shared paymaster for both wallets" : "each wallet pays its own"}`);
  line(subdued(`Showing burst ${burst}. All loads: idle, ${report.bursts.join(", ")}.`));
  line();
  const baseline = rows.some(row => row.label === "Default") ? "Default = scheduler settings unreported" : "Off = scheduler disabled";
  line(`${baseline} · FIFO = arrival order · Fair = sender rotation`);
  if (pending.length) line(pending.join("   ·   "));
  if (!rows.length) { line("No measured policies available."); return lines.join("\n"); }

  line();
  heading("1  Admission latency", "Lower is faster");
  line("B = one response. A batch = all A responses.");
  line(subdued("Timed from submission to acceptance; mining is checked afterward."));
  line();
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
  const fifo = rows.find(row => row.mode === "fifo")?.summary;
  const fair = rows.find(row => row.mode === "fair")?.summary;
  if (fifo && fair) {
    line();
    line(paint("1", "Fair vs FIFO at this load"));
    function change(label, before, after, lower, higher) {
      const delta = after - before;
      if (delta === 0) return `${label}: unchanged.`;
      if (Math.abs(delta) < 0.05) return `${label}: difference below 0.1 ms.`;
      const percent = before > 0 ? `${(Math.abs(delta) / before * 100).toFixed(1)}% ` : "";
      return `${label}: ${percent}${delta < 0 ? lower : higher} (${ms(Math.abs(delta))} ${delta < 0 ? "less" : "more"}).`;
    }
    line(change(metric, number(fifo), number(fair), "lower", "higher"));
    if (fifo.aBatchMs && fair.aBatchMs) {
      line(change(batchMetric, fifo.aBatchMs.p50, fair.aBatchMs.p50, "shorter", "longer"));
    }
  }

  line();
  heading("2  When B got a turn", `Round 1 of ${roundCount}`);
  line("Each tile is an A check, grouped by its state when B's check began.");
  line(`${paint("36", "█")} finished   ${paint("33", "▒")} running   ${subdued("░")} yet to start`);
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
  heading("3  Evidence", source === "saved" ? "Saved measurements" : "Fresh local measurements");
  line(`${inclusions.toLocaleString("en-US")} recorded inclusions across all measured loads and policies, including idle.`);
  const sponsorship = modes.map(mode => report.policies[mode]?.sponsorship).find(Boolean);
  if (report.sharedPaymaster && sponsorship && /^0x[0-9a-f]{40}$/i.test(sponsorship.paymaster)) {
    line(`Shared fee payer: ${sponsorship.paymaster}`);
    line("Receipt payer, sponsor fees and stake checked against saved evidence.");
  }
  if (roundCount < 20) line(`Smoke run · ${roundCount} ${single ? "round shows observed times" : "rounds show medians"}; use repeated runs for tail latency.`);
  else line(subdued("Local workload measurements; p95 is taken across these rounds."));
  line(subdued("Use --plain for every burst and percentile."));
  return lines.join("\n");
}
