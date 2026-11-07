import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bridge = new URL("./runner-bridge.mjs", import.meta.url).href;

function exercise({ scenario = "shared-paymaster", localScenario = scenario, localStatus = 202, resultScenario = scenario } = {}) {
  // Execute the actual bridge with an in-process fetch substitute. No real host,
  // node, credentials or benchmark are involved in these transport tests.
  const script = `
    const options=${JSON.stringify({ scenario, localScenario, localStatus, resultScenario })};
    const calls=[];
    globalThis.fetch=async (input, init={})=>{
      const url=new URL(input);
      const body=init.body ? JSON.parse(init.body) : null;
      const name=url.pathname;
      calls.push({name,body});
      if(name==='/' && init.method==='HEAD')return new Response(null,{status:200});
      if(name==='/_runner/poll')return Response.json({id:'public-job',scenario:options.scenario});
      if(name==='/api/runs')return Response.json({id:'local-job',scenario:options.localScenario},{status:options.localStatus});
      if(name==='/api/runs/local-job')return Response.json({status:'complete',scenario:options.localScenario,
        result:{source:'live',scenario:options.resultScenario}});
      if(name==='/_runner/report'){
        console.log('TEST_RESULT '+JSON.stringify(calls));
        setTimeout(()=>process.exit(0),20);
        return Response.json({ok:true});
      }
      throw Error('Unexpected request');
    };
    await import(${JSON.stringify(bridge)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 3000,
    env: { PATH: process.env.PATH, FRAMILIER_HOST_URL: "https://demo.example", FRAMILIER_RUNNER_TOKEN: "test-only-runner-secret-at-least-32-characters" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const line = result.stdout.split("\n").find(value => value.startsWith("TEST_RESULT "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("TEST_RESULT ".length));
}

test("bridge carries the selected scenario to the fixed local endpoint and result", () => {
  for (const scenario of ["self-paid", "shared-paymaster"]) {
    const calls = exercise({ scenario });
    assert.deepEqual(calls.find(call => call.name === "/api/runs").body, { scenario });
    const report = calls.find(call => call.name === "/_runner/report").body;
    assert.equal(report.status, "complete");
    assert.equal(report.result.scenario, scenario);
  }
});

test("bridge rejects unsupported jobs or an unexpected local scenario", () => {
  let calls = exercise({ scenario: "arbitrary-options" });
  assert.ok(!calls.some(call => call.name.startsWith("/api/")));
  assert.equal(calls.at(-1).body.status, "failed");
  calls = exercise({ localScenario: "self-paid" });
  assert.ok(!calls.some(call => call.name === "/api/runs/local-job"));
  assert.equal(calls.at(-1).body.status, "failed");
  calls = exercise({ resultScenario: "self-paid" });
  assert.equal(calls.at(-1).body.status, "failed");
});

test("bridge keeps the lease while another local scenario is still running", () => {
  const calls = exercise({ localStatus: 409 });
  assert.equal(calls.filter(call => call.name === "/api/runs").length, 1);
  assert.equal(calls.at(-1).body.status, "running");
  assert.equal(calls.at(-1).body.result, undefined);
});
