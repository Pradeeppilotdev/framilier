'use strict';

const byId = id => document.getElementById(id);
const runButton = byId('run');
const switchButton = byId('switch');
const policies = {off: 'Unscheduled', fifo: 'FIFO', fair: 'Sender fair'};
const nf = new Intl.NumberFormat('en', {maximumFractionDigits: 1});
const scenarioLabels = {'self-paid': 'Each wallet pays', 'shared-paymaster': 'Shared paymaster'};
const reports = new Map(Object.keys(scenarioLabels).map(scenario => [scenario, {saved: null, live: null}]));
let selectedScenario = 'self-paid', current, isRunning = false, runId = null, replayRequest = 0;
const scenarioOptions = byId('scenario-options');
const scenarioInputs = [...document.querySelectorAll('input[name="scenario"]')];
const cache = () => reports.get(selectedScenario);
const validScenario = value => Object.hasOwn(scenarioLabels, value);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function alertUser(message, problem = false) {
  const feedback = byId('feedback');
  feedback.hidden = !message;
  feedback.classList.toggle('problem', problem);
  if (feedback.textContent !== message) feedback.textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {cache: 'no-store', ...options, signal: AbortSignal.timeout(18000)});
  let body;
  try { body = await response.json(); } catch { /* An unavailable host may serve an HTML error page. */ }
  if (!response.ok || !body) {
    const error = new Error(body?.error || 'The live runner is unavailable.');
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
    throw error;
  }
  return body;
}

function hasMeasurements(report, scenario) {
  return report?.scenario === scenario && report?.chainId === 8141337 && Number.isInteger(report.rounds) && report.rounds >= 1
    && ['fifo', 'fair', 'off'].every(mode => Number.isFinite(report.policies?.[mode]?.bAdmissionMs?.p50)
      && Number.isFinite(report.policies[mode].aBatchMs?.p50)
      && (report.rounds < 20 || Number.isFinite(report.policies[mode].bAdmissionMs.p95)));
}

function traceLane(mode, result) {
  const lane = el('div', 'lane');
  const name = el('div', 'lane-name');
  name.append(el('h3', '', policies[mode]));
  lane.append(name);
  const events = result.timeline;
  if (!events?.length || !events.some(event => event.wallet === 'B')) {
    lane.append(el('p', 'unknown', 'Simulation start times unavailable for this round.'));
    return lane;
  }
  const b = events.find(event => event.wallet === 'B');
  const earlier = events.filter(event => event.startMs < b.startMs).length;
  const atSameTime = events.filter(event => event.startMs === b.startMs).length;
  name.append(el('small', '', atSameTime > 1 ? 'B tied at #' + (earlier + 1) : 'B starts #' + (earlier + 1)));

  const body = el('div');
  const tiles = el('div', events.length > 10 ? 'tiles dense' : 'tiles');
  tiles.setAttribute('role', 'img');
  tiles.setAttribute('aria-label', 'Simulation starts: ' + events.map(e => e.wallet + (e.wallet === 'A' ? e.index : '')).join(', '));
  for (const event of events) {
    const tile = el('span', event.wallet === 'B' ? 'tile b' : 'tile', event.wallet);
    if (event.wallet === 'A') tile.append(el('sub', '', event.index));
    tile.title = 'Wallet ' + event.wallet + ' · start ' + nf.format(event.startMs) + ' ms relative to B submission';
    tiles.append(tile);
  }
  const heavy = events.filter(event => event.wallet === 'A');
  const finished = heavy.filter(event => event.endMs <= b.startMs).length;
  const running = heavy.filter(event => event.startMs <= b.startMs && event.endMs > b.startMs).length;
  body.append(tiles, el('p', 'trace-note', 'When B started, ' + finished + ' of A’s checks had finished · ' + running + ' running · ' + (heavy.length - finished - running) + ' yet to start'));
  lane.append(body);
  return lane;
}

function valueCell(mode, value) {
  const cell = el('div');
  const number = el('span', 'value', nf.format(value));
  number.append(el('span', 'unit', 'ms'));
  cell.append(el('span', 'subhead', policies[mode]), number);
  return cell;
}

function metricCard(title, suffix, fifo, fair) {
  const card = el('article', 'card');
  const heading = el('h3', '', title);
  if (suffix) heading.append(el('span', 'metric-kind', ' / ' + suffix));
  const numbers = el('div', 'numbers');
  numbers.append(valueCell('fifo', fifo), valueCell('fair', fair));
  const diff = fair - fifo;
  const delta = diff === 0 ? 'Same duration under both policies.' : Math.abs(diff) < 0.05 ? 'Difference below 0.1 ms.' : nf.format(Math.abs(diff)) + ' ms ' + (diff < 0 ? 'faster' : 'slower') + ' with sender fairness.';
  card.append(heading, numbers, el('p', 'delta', delta));
  return card;
}

function updateSwitch() {
  const {saved, live} = cache();
  switchButton.hidden = !(saved && live);
  switchButton.textContent = current === saved ? 'View latest live run' : 'View saved replay';
}

function ether(wei) {
  if (!/^(0|[1-9][0-9]*)$/.test(wei || '')) return null;
  const digits = wei.padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '');
}

function showEvidence(report) {
  const evidence = report.evidence;
  const available = Number.isSafeInteger(evidence?.totalMined) && evidence.totalMined > 0;
  byId('evidence').hidden = !available;
  if (!available) return;
  byId('inclusion-count').textContent = evidence.totalMined.toLocaleString('en') + ' recorded inclusions';
  byId('evidence-scope').textContent = 'Synthetic hash-chain workload, across all measured loads including the idle control and all three policies. Receipt checks follow the admission timing.';
  const sponsored = report.scenario === 'shared-paymaster' && evidence.sponsorshipChecked === true
    && /^0x[0-9a-f]{40}$/i.test(evidence.paymaster || '');
  byId('payer-check').textContent = sponsored
    ? 'Both wallets use the same receipt payer. Sponsor fees and stake match the verified evidence. Scheduling still gives each sender its own turn.'
    : report.scenario === 'shared-paymaster'
      ? 'Sponsorship evidence is unavailable for this result.'
      : 'Each wallet pays its own fees. The workload is a hash-chain verification check.';
  byId('sponsor-details').hidden = !sponsored;
  byId('payer-address').textContent = sponsored ? evidence.paymaster : '';
  const amount = ether(evidence.paymasterStake?.amountWei);
  const delay = evidence.paymasterStake?.delay;
  byId('payer-stake').textContent = sponsored && amount && Number.isFinite(delay)
    ? amount + ' devnet ETH · ' + nf.format(delay / 3600) + '-hour unstake delay'
    : 'Unavailable';

  byId('receipt-scope').textContent = 'Round 1 at burst ' + report.burst + '. These hashes belong to the private local chain; there is no public explorer for this run.';
  const groups = [];
  for (const [mode, label] of Object.entries(policies)) {
    const receipts = report.policies[mode].evidence?.receipts;
    if (!Array.isArray(receipts) || !receipts.length) continue;
    const group = el('details', 'receipt-policy');
    group.append(el('summary', '', label + ' · ' + receipts.length + ' receipts in this round'));
    const list = el('ol', 'receipt-list');
    let a = 0;
    for (const receipt of receipts) {
      const item = el('li');
      item.append(el('strong', '', receipt.wallet === 'B' ? 'Wallet B' : 'Wallet A · ' + (++a)));
      const hashes = el('dl');
      for (const [name, value] of [['Transaction', receipt.hash], ['Block', receipt.blockHash], ['Payer', receipt.payer]]) {
        if (!value) continue;
        const row = el('div');
        const description = el('dd');
        description.append(el('code', '', value));
        row.append(el('dt', '', name), description);
        hashes.append(row);
      }
      const fee = ether(receipt.feeWei);
      if (fee !== null) {
        const row = el('div');
        row.append(el('dt', '', 'Fee'), el('dd', '', fee + ' devnet ETH'));
        hashes.append(row);
      }
      item.append(hashes);
      list.append(item);
    }
    group.append(list);
    groups.push(group);
  }
  byId('receipts').hidden = !groups.length;
  byId('receipt-list').replaceChildren(...groups);
}

function show(report) {
  if (report.scenario !== selectedScenario) return;
  current = report;
  const live = report.source === 'live';
  const bField = report.rounds >= 20 ? 'p95' : 'p50';
  const bStat = report.rounds === 1 ? '' : bField === 'p95' ? 'p95' : 'median';
  const aStat = report.rounds === 1 ? '' : 'median';
  byId('source-label').textContent = live ? 'Fresh live result' : 'Verified saved replay';
  byId('source-dot').classList.toggle('live', live);
  byId('rounds').textContent = report.rounds + ' measured ' + (report.rounds === 1 ? 'round' : 'rounds') + ' · burst ' + report.burst;
  byId('result-scenario').textContent = scenarioLabels[report.scenario];
  byId('trace-round').textContent = 'Round 1 / ' + report.rounds;
  byId('lanes').replaceChildren(...['fifo','fair'].map(mode => traceLane(mode, report.policies[mode])));
  byId('measurement').textContent = report.rounds === 1 ? 'Single-round smoke test' : 'Across ' + report.rounds + ' measured rounds';
  const {fifo, fair} = report.policies;
  byId('metric-cards').replaceChildren(
    metricCard('Wallet B admission', bStat, fifo.bAdmissionMs[bField], fair.bAdmissionMs[bField]),
    metricCard('Wallet A batch', aStat, fifo.aBatchMs.p50, fair.aBatchMs.p50)
  );
  byId('detail-b').textContent = ('B admission ' + bStat).trim();
  byId('detail-a').textContent = ('A batch ' + aStat).trim();
  const rows = Object.entries(policies).map(([mode, label]) => {
    const row = el('tr'), result = report.policies[mode];
    const name = el('th', '', label);
    name.scope = 'row';
    row.append(name, el('td', '', nf.format(result.bAdmissionMs[bField]) + ' ms'), el('td', '', nf.format(result.aBatchMs.p50) + ' ms'));
    return row;
  });
  byId('baseline').replaceChildren(...rows);
  const end = new Date(report.completedAt);
  const time = Number.isNaN(end.valueOf()) ? '' : ' · ' + end.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  byId('meta').textContent = 'Private execution chain ' + report.chainId + ' · ' + report.burst + ' heavy transactions per burst' + time + '. Admission time covers the sidecar response. Block inclusion is checked separately.';
  byId('metrics').hidden = false;
  showEvidence(report);
  updateSwitch();
}

async function loadReplay(scenario, request) {
  const report = await api('/api/replay?scenario=' + encodeURIComponent(scenario));
  if (!hasMeasurements(report, scenario) || report.source !== 'replay') throw new Error('The saved comparison could not be verified.');
  if (request !== replayRequest || scenario !== selectedScenario) return;
  reports.get(scenario).saved = report;
  if (!current) show(report);
  else updateSwitch();
}

function selectScenario(scenario) {
  if (!validScenario(scenario)) return;
  if (isRunning) {
    for (const input of scenarioInputs) input.checked = input.value === selectedScenario;
    return;
  }
  selectedScenario = scenario;
  current = null;
  for (const input of scenarioInputs) input.checked = input.value === scenario;
  byId('scenario-description').textContent = scenario === 'shared-paymaster'
    ? 'One staked paymaster sponsors A and B. They remain two separate senders for admission scheduling.'
    : 'A and B pay their own fees. Compare how each sender gets a turn.';
  byId('reproduce').textContent = './framilier compare' + (scenario === 'shared-paymaster' ? ' --shared-paymaster' : '') + ' --rounds 1 --bursts 8';
  byId('source-label').textContent = 'Loading saved replay';
  byId('source-dot').classList.remove('live');
  byId('rounds').textContent = '';
  byId('result-scenario').textContent = scenarioLabels[scenario];
  byId('lanes').replaceChildren(el('p', 'waiting', 'Loading measured start order…'));
  byId('trace-round').textContent = '';
  byId('metrics').hidden = true;
  byId('evidence').hidden = true;
  switchButton.hidden = true;
  byId('run-label').textContent = cache().live ? 'Run again' : 'Run comparison';
  alertUser('');
  const previous = cache().live || cache().saved;
  if (previous) show(previous);
  const request = ++replayRequest;
  loadReplay(scenario, request).catch(() => {
    if (request !== replayRequest || scenario !== selectedScenario || current) return;
    byId('source-label').textContent = 'Saved replay unavailable';
    byId('lanes').replaceChildren(el('p', 'waiting', 'A verified trace will appear after a successful live comparison.'));
    if (!isRunning) alertUser('The saved replay for this scenario could not load. You can still request a live comparison.', true);
  });
  runButton.disabled = false;
}

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
function remember(id, scenario) {
  try {
    if (id) sessionStorage.setItem('framilier-run', JSON.stringify({id, scenario}));
    else sessionStorage.removeItem('framilier-run');
  } catch { /* The comparison also works without browser storage. */ }
}
function recall() {
  try {
    const stored = sessionStorage.getItem('framilier-run');
    if (!stored) return null;
    const value = stored.startsWith('{') ? JSON.parse(stored) : {id: stored, scenario: 'self-paid'};
    return validScenario(value.scenario) && /^[\w-]{1,80}$/.test(value.id || '') ? value : null;
  } catch { return null; }
}

async function run(existing) {
  if (isRunning) return;
  const scenario = selectedScenario;
  if (existing && existing.scenario !== scenario) return;
  isRunning = true;
  scenarioOptions.disabled = true;
  runButton.disabled = true;
  byId('run-label').textContent = 'Running comparison…';
  alertUser(existing ? 'Reconnecting to your live run…' : 'Starting ' + scenarioLabels[scenario].toLowerCase() + ' on the private node…');
  let completed = false;
  try {
    if (!existing) {
      const job = await api('/api/runs', {
        method: 'POST', headers: {'X-Framilier-Run': '1', 'Content-Type': 'application/json'}, body: JSON.stringify({scenario})
      });
      if (!/^[\w-]{1,80}$/.test(job.id || '') || job.scenario !== scenario) throw new Error('The runner returned a different or invalid scenario.');
      runId = job.id;
      remember(runId, scenario);
    } else runId = existing.id;
    const deadline = Date.now() + 20 * 60 * 1000;
    let failures = 0;
    while (Date.now() < deadline) {
      let state;
      try {
        state = await api('/api/runs/' + encodeURIComponent(runId));
        failures = 0;
      } catch (err) {
        if (err.status === 404 || ++failures >= 3) throw err;
        await sleep(1800);
        continue;
      }
      if (state.scenario !== scenario) throw new Error('The runner returned a different scenario.');
      if (state.status === 'complete') {
        if (!hasMeasurements(state.result, scenario) || state.result.source !== 'live') throw new Error('Live verification evidence was incomplete.');
        reports.get(scenario).live = state.result;
        show(state.result);
        completed = true;
        alertUser('Live run complete. The trace, timings and receipt evidence below are from this run.');
        return;
      }
      if (state.status === 'failed') throw new Error(state.error || 'The live comparison failed.');
      if (!['queued','running'].includes(state.status)) throw new Error('The runner returned an unknown state.');
      const active = policies[state.policy];
      alertUser(active ? 'Running ' + active + ' on the private node. Collecting traces and receipts…' : 'Comparison in progress. Starting nodes and collecting receipts…');
      await sleep(2000);
    }
    throw new Error('The runner did not finish within 20 minutes.');
  } catch (err) {
    const text = err.status === 429
      ? 'The runner is cooling down.' + (err.retryAfter > 0 ? ' Try again in ' + err.retryAfter + ' seconds.' : ' Try again shortly.')
      : err.status === 409 ? (err.message || 'The runner is busy with another scenario. Try again when it finishes.')
      : (err.message === 'Failed to fetch' || err.name === 'TimeoutError' ? 'The live runner could not be reached.' : err.message || 'The live run failed.');
    alertUser(text + (current ? ' Showing the previous verified result for this scenario.' : ''), true);
  } finally {
    remember(null);
    runId = null;
    isRunning = false;
    scenarioOptions.disabled = false;
    runButton.disabled = false;
    byId('run-label').textContent = completed || cache().live ? 'Run again' : 'Run comparison';
  }
}

for (const input of scenarioInputs) input.addEventListener('change', () => {
  if (input.checked) selectScenario(input.value);
});
runButton.addEventListener('click', () => run(null));
switchButton.addEventListener('click', () => {
  const {saved, live} = cache();
  show(current === saved ? live : saved);
  if (!isRunning) alertUser('');
});
const previousRun = recall();
selectScenario(previousRun?.scenario || 'self-paid');
if (previousRun) run(previousRun);
