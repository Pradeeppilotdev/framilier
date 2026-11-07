import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const runner = randomUUID();
const host = new URL(process.env.FRAMILIER_HOST_URL || "https://invalid.invalid");
const token = process.env.FRAMILIER_RUNNER_TOKEN;
if (
  !process.env.FRAMILIER_HOST_URL ||
  host.protocol !== "https:" ||
  host.username ||
  host.password ||
  !token ||
  token.length < 32
) {
  throw new Error(
    "Set FRAMILIER_HOST_URL to the public HTTPS origin and FRAMILIER_RUNNER_TOKEN to the operator secret."
  );
}
// The public service can name a job, but cannot change which local command or URL is used.
const local = "http://127.0.0.1:4173";
const options = { redirect: "error", cache: "no-store" };
async function relay(path, message) {
  const response = await fetch(new URL("/_runner/" + path, host), {
    ...options,
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ runner, ...message }),
  });
  if (response.status === 409) return null;
  if (!response.ok) throw Error("Relay returned HTTP " + response.status);
  return response.json();
}

let job = null,
  lastMessage = "";
function log(message) {
  if (message !== lastMessage) console.log(message);
  lastMessage = message;
}

async function tick() {
  if (!job) {
    const health = await fetch(local + "/", {
      ...options, method: "HEAD", signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) throw Error("Local runner unavailable");
    const { id } = await relay("poll", {});
    if (!id) { log("Listening for a comparison."); return; }
    job = { id };
  }

  if (!job.localId && !job.report) {
    try {
      const response = await fetch(local + "/api/runs", {
        ...options, method: "POST", headers: { "x-framilier-run": "1" }, signal: AbortSignal.timeout(3500),
      });
      if (response.status === 429) {
        log("Waiting for local runner cooldown.");
      } else {
        if (!response.ok) throw Error("Local runner unavailable");
        job.localId = (await response.json()).id;
        if (!job.localId) throw Error("Local runner returned no job");
        log("Running fixed private-chain comparison.");
      }
    } catch {
      // The local service may have accepted the POST before losing the connection.
      // Do not submit a second benchmark when its ID is unknown.
      job.report = { status: "failed" };
    }
  }

  if (job.localId && !job.report) {
    try {
      const response = await fetch(local + "/api/runs/" + encodeURIComponent(job.localId), {
        ...options, signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) job.report = { status: "failed" };
      else {
        if (!response.ok) throw Error("Local job temporarily unavailable");
        const state = await response.json();
        if (state.status === "complete") job.report = { status: "complete", result: state.result };
        else if (state.status === "failed") job.report = { status: "failed" };
        else if (state.policy) job.policy = state.policy;
      }
    } catch {
      log("Retrying the existing local job.");
    }
  }

  // One edge request delivers progress and renews the lease, or delivers the final
  // report. Keep a terminal report until the edge confirms it or rejects the lease.
  const update = job.report || { status: "running", policy: job.policy };
  const acknowledgement = await relay("report", { id: job.id, ...update });
  if (!acknowledgement) {
    log("Job lease expired before acknowledgement.");
    job = null;
  } else if (job.report) {
    log("Reported " + job.report.status + ".");
    job = null;
  }
}

for (;;) {
  try {
    await tick();
  } catch (error) {
    log("Relay unavailable. Retrying. " + error.name);
  }
  await sleep(5000);
}
