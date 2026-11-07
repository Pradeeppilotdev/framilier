import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

// jsdom is already pinned by the existing devnet-ui workspace.
const require = createRequire(new URL('../sidecar/packages/devnet-ui/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const markup = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const paymaster = '0x' + 'a'.repeat(40);
const hash = digit => '0x' + digit.repeat(64);

function report(scenario, source = 'replay') {
  const sponsored = scenario === 'shared-paymaster';
  return {
    scenario, source, chainId: 8141337, rounds: source === 'live' ? 1 : 20, burst: 8,
    completedAt: '2026-11-07T02:00:00.000Z',
    evidence: {
      totalMined: source === 'live' ? 30 : 1020, scope: 'all measured loads including idle',
      paymaster: sponsored ? paymaster : null, sponsorshipChecked: sponsored,
      paymasterStake: sponsored ? {amountWei: '12000000000000000', delay: 86400} : null,
      workload: 'hash-chain'
    },
    policies: Object.fromEntries(['off', 'fifo', 'fair'].map((mode, i) => [mode, {
      bAdmissionMs: {p50: 100 + i, p95: 110 + i}, aBatchMs: {p50: 200 + i, p95: 210 + i},
      timeline: [{wallet: 'A', index: 1, startMs: -10, endMs: 5, hash: hash('1')},
        {wallet: 'B', index: 1, startMs: 0, endMs: 2, hash: hash('2')}],
      evidence: {minedCount: 10, receipts: [
        {wallet: 'A', hash: hash('1'), blockHash: hash('3'), payer: sponsored ? paymaster : null, feeWei: sponsored ? '1000000000' : null},
        {wallet: 'B', hash: hash('2'), blockHash: hash('4'), payer: sponsored ? paymaster : null, feeWei: sponsored ? '2000000000' : null}
      ]}
    }]))
  };
}

async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('UI did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function page(fetch, stored) {
  const dom = new JSDOM(markup, {runScripts: 'outside-only', url: 'https://framilier.test/'});
  const {window} = dom;
  window.AbortSignal = AbortSignal;
  window.fetch = fetch;
  if (stored) window.sessionStorage.setItem('framilier-run', stored);
  window.eval(script);
  const find = selector => window.document.querySelector(selector);
  const select = scenario => {
    const input = find('input[value="' + scenario + '"]');
    input.checked = true;
    input.dispatchEvent(new window.Event('change', {bubbles: true}));
  };
  return {window, find, select, close: () => window.close()};
}
const replayScenario = path => new URL(path, 'https://framilier.test').searchParams.get('scenario');

test('selector sends the chosen scenario and keeps saved versus live evidence explicit', async () => {
  const requests = [];
  const ui = page(async (path, options) => {
    if (path.startsWith('/api/replay')) return Response.json(report(replayScenario(path)));
    if (path === '/api/runs') {
      requests.push(options);
      return Response.json({id: 'sponsor-run', scenario: 'shared-paymaster', status: 'running'});
    }
    if (path === '/api/runs/sponsor-run') return Response.json({scenario: 'shared-paymaster', status: 'complete', result: report('shared-paymaster', 'live')});
    throw Error(path);
  });
  try {
    await until(() => ui.find('#source-label').textContent === 'Verified saved replay');
    assert.match(ui.find('#metric-cards').textContent, /p95/);
    ui.select('shared-paymaster');
    await until(() => ui.find('#payer-address').textContent === paymaster);
    assert.match(ui.find('#scenario-description').textContent, /two separate senders/);
    assert.match(ui.find('#payer-stake').textContent, /0\.012 devnet ETH · 24-hour/);
    assert.match(ui.find('#inclusion-count').textContent, /1,020/);
    assert.match(ui.find('#reproduce').textContent, /--shared-paymaster/);
    assert.match(ui.find('#receipt-list').textContent, /0\.000000001 devnet ETH/);
    assert.equal(ui.find('#receipt-list a'), null, 'local hashes must not invent explorer links');
    ui.find('#run').click();
    assert.equal(ui.find('#scenario-options').disabled, true);
    await until(() => ui.find('#source-label').textContent === 'Fresh live result');
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body), {scenario: 'shared-paymaster'});
    assert.equal(requests[0].headers['X-Framilier-Run'], '1');
    assert.equal(ui.find('#scenario-options').disabled, false);
    assert.doesNotMatch(ui.find('#metric-cards').textContent, /p95/);
    assert.match(ui.find('#inclusion-count').textContent, /30 recorded/);
    ui.find('#switch').click();
    assert.equal(ui.find('#source-label').textContent, 'Verified saved replay');
    ui.select('self-paid');
    await until(() => ui.find('#metrics').hidden === false);
    assert.equal(ui.find('#sponsor-details').hidden, true);
    assert.equal(ui.find('#switch').hidden, true, 'live sponsored result must not appear in self-paid cache');
  } finally { ui.close(); }
});

test('late replay responses cannot overwrite the selected scenario', async () => {
  let release;
  const selfPaid = new Promise(resolve => { release = resolve; });
  const ui = page(path => replayScenario(path) === 'self-paid' ? selfPaid : Promise.resolve(Response.json(report('shared-paymaster'))));
  try {
    ui.select('shared-paymaster');
    await until(() => ui.find('#payer-address').textContent === paymaster);
    release(Response.json(report('self-paid')));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(ui.find('#result-scenario').textContent, 'Shared paymaster');
    assert.equal(ui.find('#payer-address').textContent, paymaster);
    assert.equal(ui.find('#sponsor-details').hidden, false);
  } finally { ui.close(); }
});

test('busy, cooldown and mismatched live results preserve the previous verified replay', async () => {
  let response = () => Response.json({error: 'The runner is busy with another scenario.'}, {status: 409});
  const ui = page(async path => path.startsWith('/api/replay')
    ? Response.json(report(replayScenario(path)))
    : path === '/api/runs' ? response()
    : Response.json({scenario: 'shared-paymaster', status: 'complete', result: report('shared-paymaster', 'live')}));
  try {
    await until(() => ui.find('#source-label').textContent === 'Verified saved replay');
    ui.find('#run').click();
    await until(() => ui.find('#feedback').textContent.includes('busy'));
    assert.equal(ui.find('#source-label').textContent, 'Verified saved replay');
    response = () => Response.json({error: 'Cooling down'}, {status: 429, headers: {'Retry-After': '42'}});
    ui.find('#run').click();
    await until(() => ui.find('#feedback').textContent.includes('42 seconds'));
    response = () => Response.json({id: 'wrong-mode', scenario: 'self-paid'});
    ui.find('#run').click();
    await until(() => ui.find('#feedback').textContent.includes('different scenario'));
    assert.equal(ui.find('#source-label').textContent, 'Verified saved replay');
    assert.equal(ui.find('#scenario-options').disabled, false);
  } finally { ui.close(); }
});

test('unavailable scenario replay is an error, never a fallback from another scenario', async () => {
  const paths = [];
  const ui = page(async path => { paths.push(path); return Response.json({error: 'Unavailable'}, {status: 503}); });
  try {
    await until(() => ui.find('#source-label').textContent === 'Saved replay unavailable');
    assert.equal(ui.find('#metrics').hidden, true);
    assert.equal(ui.find('#run').disabled, false);
    ui.select('shared-paymaster');
    await until(() => ui.find('#source-label').textContent === 'Saved replay unavailable');
    assert.deepEqual(paths, ['/api/replay?scenario=self-paid', '/api/replay?scenario=shared-paymaster']);
    assert.equal(ui.find('#result-scenario').textContent, 'Shared paymaster');
  } finally { ui.close(); }
});

test('reconnect remembers scenario and protects the selection while polling', async () => {
  let finish;
  const state = new Promise(resolve => { finish = resolve; });
  const paths = [];
  const ui = page(async path => {
    paths.push(path);
    return path.startsWith('/api/replay') ? Response.json(report(replayScenario(path))) : state;
  }, JSON.stringify({id: 'existing-job', scenario: 'shared-paymaster'}));
  try {
    await until(() => paths.includes('/api/runs/existing-job'));
    assert.equal(ui.find('#scenario-options').disabled, true);
    ui.select('self-paid');
    assert.equal(ui.find('input[value="shared-paymaster"]').checked, true);
    finish(Response.json({scenario: 'shared-paymaster', status: 'complete', result: report('shared-paymaster', 'live')}));
    await until(() => ui.find('#source-label').textContent === 'Fresh live result');
    assert.equal(ui.find('#result-scenario').textContent, 'Shared paymaster');
    assert.equal(ui.window.sessionStorage.getItem('framilier-run'), null);
    assert.ok(!paths.includes('/api/runs'), 'reconnect must not start another job');
  } finally { ui.close(); }
});
