import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleApi } from "./relay.mjs";

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
  async () => {
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
    const result = {
      source: "live",
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
    const seen = await (await call("/api/runs/" + run.id, "GET")).json();
    assert.equal(seen.status, "complete");
    assert.deepEqual(seen.result, result);
    assert.equal((await guest()).status, 429);
    db.sql.exec("UPDATE framilier_runner SET seen=0");
    assert.equal((await guest()).status, 503);
    db.sql.exec("UPDATE framilier_runs SET ended=0");
    await operator("poll", {});
    const next = await (await guest()).json();
    await operator("poll", {});
    db.sql.exec("UPDATE framilier_runs SET lease=0 WHERE state='running'");
    assert.equal((await operator("report", { id: next.id, status: "complete", result })).status, 409);
    assert.equal((await (await call("/api/runs/" + next.id, "GET")).json()).status, "failed");
    db.sql.close();
  }
);
