'use strict';

const byId = id => document.getElementById(id);
const runButton = byId('run');
const switchButton = byId('switch');
const policies = {off: 'Unscheduled', fifo: 'FIFO', fair: 'Sender fair'};
const nf = new Intl.NumberFormat('en', {maximumFractionDigits: 1});
let savedReport, liveReport, current, isRunning = false, runId = null;

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

function hasMeasurements(report) {
  return report?.chainId === 8141337 && Number.isInteger(report.rounds) && report.rounds >= 1
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
  const tiles = el('div', 'tiles');
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
  const delta = diff === 0 ? 'Same duration under both policies.' : nf.format(Math.abs(diff)) + ' ms ' + (diff < 0 ? 'faster' : 'slower') + ' with sender fairness.';
  card.append(heading, numbers, el('p', 'delta', delta));
  return card;
}

function updateSwitch() {
  switchButton.hidden = !(savedReport && liveReport);
  switchButton.textContent = current === savedReport ? 'View latest live run' : 'View saved replay';
}

function show(report) {
  current = report;
  const live = report.source === 'live';
  const bField = report.rounds >= 20 ? 'p95' : 'p50';
  const bStat = report.rounds === 1 ? '' : bField === 'p95' ? 'p95' : 'median';
  const aStat = report.rounds === 1 ? '' : 'median';
  byId('source-label').textContent = live ? 'Fresh live result' : 'Verified saved replay';
  byId('source-dot').classList.toggle('live', live);
  byId('rounds').textContent = report.rounds + ' measured ' + (report.rounds === 1 ? 'round' : 'rounds') + ' per policy';
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
  updateSwitch();
}

async function loadReplay() {
  let report;
  try {
    report = await api('/api/replay');
  } catch {
    report = await api('./replay.json');
  }
  if (!hasMeasurements(report) || report.source !== 'replay') throw new Error('The saved comparison could not be verified.');
  savedReport = report;
  if (!current) show(report);
  else updateSwitch();
}

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
function remember(id) {
  try {
    if (id) sessionStorage.setItem('framilier-run', id);
    else sessionStorage.removeItem('framilier-run');
  } catch { /* The comparison also works without browser storage. */ }
}
function recall() {
  try { return sessionStorage.getItem('framilier-run'); } catch { return null; }
}

async function run(existingId) {
  if (isRunning) return;
  isRunning = true;
  runButton.disabled = true;
  byId('run-label').textContent = 'Running comparison…';
  alertUser(existingId ? 'Reconnecting to your live run…' : 'Starting a fresh comparison on the private node…');
  let completed = false;
  try {
    if (!existingId) {
      const job = await api('/api/runs', {method:'POST', headers:{'X-Framilier-Run':'1'}});
      if (!/^[\w-]{1,80}$/.test(job.id || '')) throw new Error('The live runner is unavailable.');
      runId = job.id;
      remember(runId);
    } else runId = existingId;
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
      if (state.status === 'complete') {
        if (!hasMeasurements(state.result) || state.result.source !== 'live') throw new Error('Live verification evidence was incomplete.');
        liveReport = state.result;
        show(liveReport);
        completed = true;
        alertUser('Live run complete. The trace and measurements below are from this run.');
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
      : (err.message === 'Failed to fetch' || err.name === 'TimeoutError' ? 'The live runner could not be reached.' : err.message || 'The live run failed.');
    alertUser(text + (current ? ' Showing the previous verified result.' : ''), true);
  } finally {
    remember(null);
    runId = null;
    isRunning = false;
    runButton.disabled = false;
    byId('run-label').textContent = completed || liveReport ? 'Run again' : 'Run comparison';
  }
}

runButton.addEventListener('click', () => run(null));
switchButton.addEventListener('click', () => {
  show(current === savedReport ? liveReport : savedReport);
  if (!isRunning) alertUser('');
});
loadReplay().catch(() => {
  if (current) return;
  byId('source-label').textContent = 'No saved replay loaded';
  byId('lanes').replaceChildren(el('p', 'waiting', 'A verified trace will appear after a successful live comparison.'));
}).finally(() => {
  const id = recall();
  if (id && /^[\w-]{1,80}$/.test(id)) run(id);
  else runButton.disabled = false;
});
