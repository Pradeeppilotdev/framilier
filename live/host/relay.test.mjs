import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleApi, initialize } from "./relay.mjs";

// node:sqlite is available in Node 22.13+. Run these D1 dialect and lifecycle
// tests there; the application and standalone Node server also work on Node 20.
const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));

function database() {
  const sql = new DatabaseSync(":memory:");
  function statement(query, values = []) {
    const compiled = () => sql.prepare(query);
    return {
      bind: (...args) => statement(query, args),
      first: () => compiled().get(...values),
      run: () => ({ meta: compiled().run(...values) }),
      execute: () => ({ results: compiled().all(...values) }),
      all: () => ({ results: compiled().all(...values) }),
    };
  }
  return {
    sql,
    prepare: statement,
    batch(stmts) {
      sql.exec("BEGIN");
      try {
        const results = stmts.map((s) => s.execute());
        sql.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        sql.exec("ROLLBACK");
        return Promise.reject(error);
      }
    },
  };
}

test(
  "a real runner must claim the fixed job before it can post its result",
  { skip: !DatabaseSync },
  async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const db = database();
    const env = { DB: db, FRAMILIER_RUNNER_TOKEN: randomUUID() };
    const runner = randomUUID(),
      rival = randomUUID();
    function call(path, method, headers, body) {
      return handleApi(new Request("https://demo.example" + path, { method, headers, body }), env);
    }
    const guest = () => call("/api/runs", "POST", { "x-framilier-run": "1" });
    const operator = (path, data) =>
      call(
        "/_runner/" + path,
        "POST",
        { authorization: "Bearer " + env.FRAMILIER_RUNNER_TOKEN },
        JSON.stringify({ runner, ...data })
      );
    assert.equal((await guest()).status, 503);
    assert.equal((await call("/api/runs", "POST", {})).status, 403);
    assert.equal(
      (await call("/api/runs", "POST", { "x-framilier-run": "1", origin: "https://outsider.example" }))
        .status,
      403
    );
    assert.equal((await call("/api/runs", "POST", { "x-framilier-run": "1" }, '{"url":"test"}')).status, 400);
    assert.equal((await call("/_runner/poll", "POST", {}, JSON.stringify({ runner }))).status, 401);
    assert.equal((await (await operator("poll", {})).json()).id, null);
    const run = await (await guest()).json();
    assert.equal(run.status, "running");
    // The deployed edge supplies an empty stream for a browser's bodyless POST.
    const edgeRequest = new Request("https://demo.example/api/runs", {
      method: "POST", headers: { "x-framilier-run": "1" }, duplex: "half",
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    });
    const joined = await handleApi(edgeRequest, env);
    assert.equal(joined.status, 202);
    assert.equal((await joined.json()).id, run.id);
    assert.equal((await (await guest()).json()).id, run.id);
    assert.equal((await (await operator("poll", {})).json()).id, run.id);
    assert.equal((await (await operator("poll", { runner: rival })).json()).id, null);
    assert.equal((await operator("report", { id: run.id, runner: rival, status: "failed" })).status, 409);
    // The node keeps computing locally while the relay cannot hear it. Once the
    // 45-second idle heartbeat would be stale, the already claimed job still lives.
    now += 90_000;
    assert.equal((await (await call("/api/runs/" + run.id, "GET")).json()).status, "running");
    assert.equal((await operator("report", { id: run.id, status: "running", policy: "fair" })).status, 200);
    now += 120_000;
    const result = {
      source: "live",
      scenario: "self-paid",
      chainId: 8141337,
      rounds: 1,
      burst: 8,
      policies: { off: {}, fifo: {}, fair: {} },
    };
    assert.equal(
      (await operator("report", { id: run.id, status: "complete", result: { ...result, source: "replay" } }))
        .status,
      400
    );
    assert.equal((await operator("report", { id: run.id, status: "complete", result })).status, 200);
    // Retrying when the acknowledgement was lost cannot replace its stored data.
    assert.equal((await operator("report", { id: run.id, status: "complete", result })).status, 200);
    assert.equal((await operator("report", { id: run.id, status: "failed" })).status, 409);
    const seen = await (await call("/api/runs/" + run.id, "GET")).json();
    assert.equal(seen.status, "complete");
    assert.deepEqual(seen.result, result);
    assert.equal((await guest()).status, 429);
    now += 46_000;
    assert.equal((await guest()).status, 503);
    db.sql.exec("UPDATE framilier_runs SET ended=0");
    await operator("poll", {});
    const next = await (await guest()).json();
    await operator("poll", {});
    now += 181_000;
    assert.equal((await operator("report", { id: next.id, status: "complete", result })).status, 409);
    assert.equal((await (await call("/api/runs/" + next.id, "GET")).json()).status, "failed");
    db.sql.close();
  }
);


test("existing relay databases migrate once and preserve self-paid jobs", { skip: !DatabaseSync }, async () => {
  const db = database();
  db.sql.exec(`CREATE TABLE framilier_runs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, ended INTEGER,
    owner TEXT, lease INTEGER, policy TEXT, result TEXT)`);
  const id = randomUUID();
  db.sql.prepare("INSERT INTO framilier_runs (id,state,created) VALUES (?,'complete',1)").run(id);
  await Promise.all([initialize(db), initialize(db)]);
  assert.equal(db.sql.prepare("SELECT scenario FROM framilier_runs WHERE id=?").get(id).scenario, "self-paid");
  assert.equal(db.sql.prepare("PRAGMA table_info(framilier_runs)").all().filter(c => c.name === "scenario").length, 1);
  db.sql.close();
});

test("relay binds a sponsor choice through claim and rejects mismatched results", { skip: !DatabaseSync }, async () => {
  const db = database();
  const env = { DB: db, FRAMILIER_RUNNER_TOKEN: randomUUID() };
  const runner = randomUUID();
  const call = (path, body, privateCall = false) => handleApi(new Request("https://demo.example" + path, {
    method: "POST", headers: privateCall ? { authorization: "Bearer " + env.FRAMILIER_RUNNER_TOKEN } : { "x-framilier-run": "1" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env);
  try {
    await call("/_runner/poll", { runner }, true);
    for (const body of ["null", "[]", "{}", { scenario: "other" }, { scenario: "self-paid", rounds: 9 }, "x".repeat(513)]) {
      assert.equal((await call("/api/runs", body)).status, 400);
    }
    const start = await call("/api/runs", { scenario: "shared-paymaster" });
    assert.equal(start.status, 202);
    const job = await start.json();
    assert.equal(job.scenario, "shared-paymaster");
    const conflict = await call("/api/runs");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).activeScenario, "shared-paymaster");
    assert.equal((await (await call("/api/runs", { scenario: "shared-paymaster" })).json()).id, job.id);
    const claim = await (await call("/_runner/poll", { runner }, true)).json();
    assert.deepEqual(claim, { id: job.id, scenario: "shared-paymaster" });
    const result = { source: "live", scenario: "self-paid", chainId: 8141337, rounds: 1, burst: 8,
      policies: { off: {}, fifo: {}, fair: {} } };
    assert.equal((await call("/_runner/report", { runner, id: job.id, status: "complete", result }, true)).status, 400);
    result.scenario = "shared-paymaster";
    assert.equal((await call("/_runner/report", { runner, id: job.id, status: "complete", result }, true)).status, 200);
    const stored = db.sql.prepare("SELECT scenario,result FROM framilier_runs WHERE id=?").get(job.id);
    assert.equal(stored.scenario, "shared-paymaster");
    assert.equal(JSON.parse(stored.result).scenario, "shared-paymaster");
  } finally { db.sql.close(); }
});
