import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readReport } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const replayPaths = {
  "self-paid": "sidecar/evidence/compare/merged-main-7d052e7",
  "shared-paymaster": "sidecar/evidence/compare/shared-paymaster-smoke",
};
const isScenario = value => Object.hasOwn(replayPaths, value);

function requestScenario(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    function cleanup() {
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", aborted);
    }
    function fail(error) { cleanup(); req.resume(); reject(error); }
    function aborted() { fail(new Error("Request interrupted")); }
    function data(chunk) {
      bytes += chunk.length;
      if (bytes > 512) return fail(new Error("Request too large"));
      chunks.push(chunk);
    }
    function end() {
      cleanup();
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.length) return resolve("self-paid");
        const body = JSON.parse(text);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).length !== 1 || !isScenario(body.scenario)) throw Error("Invalid scenario");
        resolve(body.scenario);
      } catch (error) { reject(error); }
    }
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", aborted);
  });
}
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const runTimeout = 10 * 60_000;
const cooldown = 60_000;

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runComparison(root, signal, updatePolicy, scenario) {
  if (!isScenario(scenario)) throw Error("Unknown scenario");
  const scratch = await mkdtemp(path.join(tmpdir(), "framilier-web-"));
  const evidence = path.join(scratch, "result");
  try {
    signal.throwIfAborted();
    // Only operator-selected executable paths can affect the fixed workload.
    const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, FRAMILIER_RUN_TMPDIR: scratch };
    for (const key of ["FRAMILIER_ETHREX_BIN", "FRAMILIER_BUN_BIN"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(path.join(root, "framilier"),
      ["compare", "--rounds", "1", "--bursts", "8", "--output", evidence, "--plain",
        ...(scenario === "shared-paymaster" ? ["--shared-paymaster"] : [])],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => {
      const phase = /^Starting (baseline|fifo|fair) on a fresh private chain/.exec(line);
      if (phase) updatePolicy(phase[1] === "baseline" ? "off" : phase[1]);
    });

    let forceKill;
    const stop = () => {
      signalGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 3000);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      signal.throwIfAborted();
      if (code !== 0) throw new Error("Comparison exited with code " + code);
    } finally {
      clearTimeout(forceKill);
      signal.removeEventListener("abort", stop);
      output.close();
      // Also collect descendants left behind by an interrupted runner.
      signalGroup(child.pid, "SIGKILL");
    }
    return await readReport(evidence, "live");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function createDemo({ root = defaultRoot, compare = runComparison, now = Date.now, timeout = runTimeout } = {}) {
  const runs = new Map();
  let active, controller, pending;
  const replays = new Map();
  let nextStart = 0;
  let stopping = false;

  function start(scenario) {
    const run = { id: randomUUID(), scenario, status: "running", startedAt: new Date(now()).toISOString() };
    runs.set(run.id, run);
    active = run;
    controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeout);
    pending = (async () => {
      try {
        const result = await compare(root, signal, policy => { run.policy = policy; }, scenario);
        if (result?.scenario !== scenario || result.source !== "live") throw Error("Mismatched comparison result");
        run.result = result;
        run.status = "complete";
      } catch (error) {
        console.error("Live comparison failed:", error.message);
        run.status = "failed";
        run.error = signal.aborted ? "The live run was interrupted or timed out." : "The live run failed verification or execution. Please try again later.";
      } finally {
        delete run.policy;
        clearTimeout(timer);
        active = controller = null;
        nextStart = now() + cooldown;
      }
    })();
    return run;
  }

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const route = req.url;
      if ((req.method === "GET" || req.method === "HEAD") && assets.has(route)) {
        const [filename, type] = assets.get(route);
        const content = await readFile(path.join(here, "public", filename));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }

      const url = new URL(route, "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/replay") {
        const scenario = url.searchParams.get("scenario") ?? "self-paid";
        if (!isScenario(scenario) || [...url.searchParams.keys()].some(key => key !== "scenario") ||
            url.searchParams.getAll("scenario").length > 1)
          return sendJson(res, 400, { error: "Choose self-paid or shared-paymaster." });
        // Share verification work only among requests for the same archive.
        if (!replays.has(scenario)) replays.set(scenario,
          readReport(path.join(root, replayPaths[scenario]), "replay").catch(error => { replays.delete(scenario); throw error; }));
        return sendJson(res, 200, await replays.get(scenario));
      }

      // A single host slot; finished records are bounded in age and count.
      for (const [id, run] of runs) {
        if (run !== active && (now() - Date.parse(run.startedAt) > 3600_000 || runs.size > 8)) runs.delete(id);
      }
      if (req.method === "POST" && route === "/api/runs") {
        // The header requires a successful preflight for browser requests from another origin.
        // This server grants no cross-origin access. Public judges use only the fixed command.
        if (req.headers["x-framilier-run"] !== "1" || req.headers["sec-fetch-site"] === "cross-site")
          return sendJson(res, 403, { error: "Start the comparison from this page." });
        let scenario;
        try { scenario = await requestScenario(req); }
        catch { return sendJson(res, 400, { error: "Choose only a self-paid or shared-paymaster scenario." }); }
        if (stopping) return sendJson(res, 503, { error: "The runner is stopping." });
        if (active) return active.scenario === scenario ? sendJson(res, 202, active)
          : sendJson(res, 409, { error: `The runner is busy with a ${active.scenario} comparison. Try this scenario after it finishes.`, activeScenario: active.scenario });
        if (now() < nextStart) {
          res.setHeader("Retry-After", Math.ceil((nextStart - now()) / 1000));
          return sendJson(res, 429, { error: "The runner is cooling down. Try again shortly." });
        }
        return sendJson(res, 202, start(scenario));
      }
      if (req.method === "GET" && route.startsWith("/api/runs/")) {
        const run = runs.get(route.slice("/api/runs/".length));
        if (run) return sendJson(res, 200, run);
      }
      sendJson(res, 404, { error: "This page or run could not be found." });
    } catch (error) {
      console.error("Live demo request failed:", error.message);
      sendJson(res, 500, { error: "The requested result is unavailable." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 128;

  async function close() {
    stopping = true;
    controller?.abort();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([closed, pending]);
  }
  return { server, close };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, close } = createDemo({ root: realpathSync(process.env.FRAMILIER_ROOT || defaultRoot) });
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`framilier live comparison listening at http://${host}:${server.address().port}`));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
