import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDemo } from "./server.mjs";

async function startServer(t, options) {
  const demo = createDemo(options);
  demo.server.listen(0, "127.0.0.1");
  await once(demo.server, "listening");
  t.after(() => demo.close());
  const base = "http://127.0.0.1:" + demo.server.address().port;
  return (route, init) => fetch(base + route, init);
}

const post = { method: "POST", headers: { "X-Framilier-Run": "1" } };

test("same fixed job is shared, polled, rate limited and expired", async t => {
  let finish, calls = 0, time = 100_000;
  const request = await startServer(t, {
    now: () => time,
    compare: async (_root, _signal, update) => {
      calls++;
      update("fifo");
      return new Promise(resolve => { finish = resolve; });
    },
  });
  const [first, second] = await Promise.all([request("/api/runs", post), request("/api/runs", post)]);
  assert.equal(first.status, 202);
  const job = await first.json();
  assert.equal(job.scenario, "self-paid");
  assert.equal((await second.json()).id, job.id);
  const route = "/api/runs/" + job.id;
  assert.equal((await (await request(route)).json()).policy, "fifo");
  assert.equal(calls, 1);
  finish({ source: "live", scenario: "self-paid" });
  const result = await (await request(route)).json();
  assert.equal(result.status, "complete");
  assert.deepEqual(result.result, { source: "live", scenario: "self-paid" });
  const retry = await request("/api/runs", post);
  assert.equal(retry.status, 429);
  assert.equal(retry.headers.get("retry-after"), "60");
  time += 3600_001;
  assert.equal((await request(route)).status, 404);
});

test("public clients cannot provide benchmark options or launch a cross-origin form", async t => {
  const request = await startServer(t, { compare: () => assert.fail("must not run") });
  assert.equal((await request("/api/runs", { method: "POST" })).status, 403);
  assert.equal((await request("/api/runs", { method: "POST", headers: { ...post.headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await request("/api/runs", { ...post, body: "8" })).status, 400);
  assert.equal((await request("/api/runs?rounds=500", post)).status, 404);
  assert.equal((await request("/.git/config")).status, 404);
});

test("timeout is a terminal failure and does not return a replay or a private error", async t => {
  const request = await startServer(t, { timeout: 15, compare: async (_root, signal) => {
    await once(signal, "abort"); throw new Error("internal diagnostics");
  } });
  const job = await (await request("/api/runs", post)).json();
  await delay(30);
  const row = await (await request("/api/runs/" + job.id)).json();
  assert.equal(row.status, "failed");
  assert.match(row.error, /timed out/);
  assert.equal(row.result, undefined);
  assert.doesNotMatch(row.error, /internal diagnostics/);
});

test("saved route serves verified reports without running the benchmark", async t => {
  const request = await startServer(t, { compare: () => assert.fail("must not run") });
  const res = await request("/api/replay");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, "replay");
  assert.equal(data.rounds, 20);
  assert.ok(data.policies.fair.timeline.some(event => event.wallet === "B"));
});


test("sponsor selection is bound to the job and never joins another scenario", async t => {
  let finish, received;
  const request = await startServer(t, {
    compare: async (_root, _signal, _update, scenario) => {
      received = scenario;
      return new Promise(resolve => { finish = resolve; });
    },
  });
  const sponsored = { ...post, body: JSON.stringify({ scenario: "shared-paymaster" }) };
  const first = await request("/api/runs", sponsored);
  assert.equal(first.status, 202);
  const job = await first.json();
  assert.equal(job.scenario, "shared-paymaster");
  assert.equal(received, "shared-paymaster");
  assert.equal((await (await request("/api/runs", sponsored)).json()).id, job.id);
  const conflict = await request("/api/runs", post);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).activeScenario, "shared-paymaster");
  finish({ source: "live", scenario: "shared-paymaster" });
  const done = await (await request("/api/runs/" + job.id)).json();
  assert.equal(done.status, "complete");
  assert.equal(done.result.scenario, "shared-paymaster");
});

test("invalid or oversized scenario payloads cannot start a benchmark", async t => {
  const request = await startServer(t, { compare: () => assert.fail("must not run") });
  for (const body of ['null', '[]', '{}', '{"scenario":"zk"}', '{"scenario":"self-paid","rounds":500}',
      '{"scenario":"shared-paymaster","url":"https://example.com"}', ' '.repeat(513)]) {
    assert.equal((await request("/api/runs", { ...post, body })).status, 400, body.slice(0, 100));
  }
});

test("a completed result from a different scenario is an explicit failure", async t => {
  const request = await startServer(t, { compare: async () => ({ source: "live", scenario: "self-paid" }) });
  const job = await (await request("/api/runs", { ...post, body: '{"scenario":"shared-paymaster"}' })).json();
  const state = await (await request("/api/runs/" + job.id)).json();
  assert.equal(state.status, "failed");
  assert.equal(state.result, undefined);
});

test("replay scenario selects its own verified evidence and rejects extra query options", async t => {
  const request = await startServer(t, { compare: () => assert.fail("must not run") });
  const a = await (await request("/api/replay?scenario=self-paid")).json();
  const b = await (await request("/api/replay?scenario=shared-paymaster")).json();
  assert.equal(a.scenario, "self-paid");
  assert.equal(a.rounds, 20);
  assert.equal(b.scenario, "shared-paymaster");
  assert.equal(b.rounds, 1);
  assert.equal(b.source, "replay");
  for (const route of ["/api/replay?scenario=nope", "/api/replay?scenario=self-paid&rounds=5",
      "/api/replay?scenario=self-paid&scenario=shared-paymaster"]) {
    assert.equal((await request(route)).status, 400);
  }
});
