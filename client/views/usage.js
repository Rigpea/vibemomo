// Budget (route #/budget): the three numbers that matter, the ledger of API utility calls, one
// bounded utility run, and the cycle settings. Figures are the studio's own estimates; the
// provider balance is only what you observed in the Console.
import { el, clear, button, stateChip, input, select, textarea, field, toast, toastError, loading, errorBox, empty, usd, when, ago } from '../components/ui.js';
import { pauseWords } from '../components/status-words.js';

let v = null;

export function mount(host, app) {
  v = { app, head: el('span.row'), numbers: el('div'), ledger: el('section.section'), runBox: el('section.section'), cycle: el('section.section'), offs: [], run: null };
  clear(host, el('div.page', el('div.page-inner',
    el('div.page-head', el('h1', 'Budget'), v.head),
    v.numbers, v.ledger, v.runBox, v.cycle)));
  v.offs.push(app.on('budget', () => { loadBudget(); loadUsage(); }), app.on('utility', onProgress));
  loadBudget();
  loadUsage();
  renderRun();
}

export function unmount() { v?.offs.forEach((off) => off()); v = null; }

// ---------- the three numbers + cycle settings ----------
async function loadBudget() {
  if (!v) return;
  if (!v.budget) clear(v.numbers, loading('Loading budget…'));
  try {
    v.budget = await v.app.api.budget();
    renderBudget();
  } catch (err) { clear(v.numbers, errorBox(err, loadBudget)); }
}

/** The observed date as entered: a plain "YYYY-MM-DD" (older records hold an ISO time; its date part is what was entered). */
const observedDate = (obs) => {
  const raw = obs?.observedAt ?? obs?.asOf;
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(raw);
};
// The sentences come from the server with their numbers (balanceWarnings in server/api-utility/budget.mjs).
// A server without them yet still shows its warning codes as words, never as raw codes.
const warningTexts = (b) => b.warningMessages || (b.warnings || []).map((code) => `Budget warning: ${String(code).replace(/_/g, ' ')}.`);
const number = (k, val, sub, title) => el('div.number', { title }, el('div.k', k), el('div.v', val), sub ? el('div.sub', sub) : null);

function renderBudget() {
  const b = v.budget;
  const patch = async (body, msg) => {
    try { v.budget = await v.app.api.patchBudget(body); renderBudget(); toast(msg, { tone: 'ok', timeout: 2000 }); } catch (err) { toastError(err, 'Budget'); }
  };
  const pause = b.paused ? pauseWords(b) : null;
  clear(v.head,
    pause ? stateChip(pause.label, 'warn', pause.title) : null,
    // A pause the studio set has no Resume: it lifts when its cause is gone (pause.howToLift).
    pause && !pause.canResume ? null : button(pause ? 'Resume' : 'Pause', { title: pause ? 'Let API utility runs spend again' : 'Stop API utility runs from spending; everything else keeps working', onclick: () => patch({ paused: !pause }, pause ? 'API utilities resumed' : 'API utilities paused; everything else keeps working') }));
  renderRunStatus();
  const obs = b.observed || {};
  clear(v.numbers,
    el('div.numbers',
      number('Spent this cycle', usd(b.spentUsd, 2), `studio estimate · pricing ${b.pricingVersion}`, 'Sum of ledger costs in this cycle, priced with the studio pricing table'),
      number('Live ceiling', usd(b.liveCeilingUsd), `${usd(b.remainingUsd)} left`, 'Live ceiling − spent − reserved, and never more than the observed balance leaves above the reserve'),
      number('Observed balance', obs.balanceUsd != null ? usd(obs.balanceUsd) : 'Not entered', obs.balanceUsd != null ? `observed ${observedDate(obs) || 'on an unknown date'}` : 'enter it below from the Console', obs.note || '')),
    el('p.meta.prose-width', 'Only API utility runs are counted here. Claude Code sessions run on your plan, and the provider balance is shared with other apps, so the two will differ.'),
    pause?.howToLift ? el('p.note.warn', pause.howToLift) : null,
    warningTexts(b).map((w) => el('p.note.warn', w)));
  renderCycle(b, patch);
}

function renderCycle(b, patch) {
  const bal = input({ type: 'number', step: '0.01', min: '0', value: b.observed?.balanceUsd ?? '', placeholder: 'e.g. 187.40' });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const asOf = input({ type: 'date', value: observedDate(b.observed) || today() });
  const cs = input({ type: 'date', value: b.cycle?.start || '' });
  const ce = input({ type: 'date', value: b.cycle?.end || '' });
  const ceiling = input({ type: 'number', step: '1', min: '0', value: b.liveCeilingUsd });
  const w = (px, f) => el('div', { style: { width: px } }, f);
  clear(v.cycle,
    el('div.section-head', el('h2', 'Cycle and balance')),
    el('p.meta', `Cycle ${b.cycle?.start || 'not set'} → ${b.cycle?.end || 'not set'}${b.cycle?.source && b.cycle.source !== 'unknown' ? ` (${b.cycle.source})` : ''}`),
    kvList([
      ['In flight (reserved for running calls)', usd(b.reservedUsd, 2)],
      [`Active allocation (at most ${usd(b.activeAllocationUsd, 0)} per cycle)`, b.effectiveAllocationUsd < b.activeAllocationUsd ? `${usd(b.effectiveAllocationUsd)} now, capped by the observed balance` : usd(b.activeAllocationUsd)],
      ['Grant / kept back as reserve', `${usd(b.grantUsd, 0)} / ${usd(b.reserveUsd, 0)}`],
    ]),
    // The date is sent as entered ("YYYY-MM-DD"), so it reads back as the same day in every time zone.
    el('form.form-row', { style: { margin: '16px 0' }, onsubmit: (e) => { e.preventDefault(); const n = bal.value === '' ? null : Number(bal.value); patch({ observed: { balanceUsd: n, asOf: n === null ? null : (asOf.value || today()) } }, 'Observed balance saved'); } },
      w('140px', field('Observed balance ($)', bal)), w('170px', field('As of', asOf)), button('Save balance', { type: 'submit' })),
    el('form.form-row', { onsubmit: (e) => { e.preventDefault(); patch({ cycle: { start: cs.value || null, end: ce.value || null }, liveCeilingUsd: Number(ceiling.value) }, 'Cycle and ceiling saved'); } },
      w('170px', field('Cycle start', cs)), w('170px', field('Cycle end', ce)), w('120px', field('Live ceiling ($)', ceiling)), button('Save cycle', { type: 'submit' })));
}

const kvList = (rows) => el('dl.kv.small', { style: { margin: '8px 0 0' } }, rows.flatMap(([k, val]) => [el('dt', k), el('dd', val)]));

// ---------- ledger ----------
async function loadUsage() {
  if (!v) return;
  if (!v.usage) clear(v.ledger, loading('Loading the ledger…'));
  try {
    v.usage = await v.app.api.usage();
    renderUsage();
  } catch (err) { clear(v.ledger, errorBox(err, loadUsage)); }
}

function renderUsage() {
  const u = v.usage;
  const t = u.totals || {};
  const projName = (id) => v.app.state.projects.find((p) => p.id === id)?.name || id;
  const breakdown = (title, map, name = (k) => k) => el('div', el('h4', { style: { margin: '0 0 4px' } }, title),
    Object.keys(map || {}).length ? el('table.table', el('thead', el('tr', el('th', 'Name'), el('th.num', 'Calls'), el('th.num', 'Cost'))),
      el('tbody', Object.entries(map).sort((a, b) => b[1].costUsd - a[1].costUsd).map(([k, x]) => el('tr', el('td', name(k)), el('td.num', x.calls), el('td.num', usd(x.costUsd, 4))))))
      : el('p.meta', 'No calls this cycle.'));
  clear(v.ledger,
    el('div.section-head', el('h2', 'Ledger'), el('span.meta', `${t.calls || 0} calls · ${usd(t.costUsd || 0, 4)} estimated`)),
    u.recent?.length ? el('div', { style: { overflowX: 'auto' } }, el('table.table',
      el('thead', el('tr', ['When', 'Task', 'Model', 'In', 'Out', 'Cost', 'Result'].map((h, i) => el('th', { class: i >= 3 && i <= 5 ? 'num' : '' }, h)))),
      el('tbody', u.recent.slice(0, 30).map((l) => el('tr',
        el('td.small', { title: when(l.ts) }, ago(l.ts)), el('td', l.task), el('td.small.mono', l.model),
        el('td.num', l.inputTokens ?? 0), el('td.num', l.outputTokens ?? 0), el('td.num', usd(l.costUsd || 0, 4)),
        el('td', l.ok ? 'ok' : el('span', { title: l.error || '', style: { color: l.cancelled ? 'var(--muted)' : 'var(--danger)' } }, l.cancelled ? 'cancelled' : (l.error || 'failed').slice(0, 40)))))))) : el('p.meta', 'No API calls recorded yet; utility runs appear here with tokens and estimated cost.'),
    el('details.more', { style: { marginTop: '12px' } }, el('summary', 'Totals by model, task and project'),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '24px', marginTop: '8px' } },
        breakdown('By model', t.byModel), breakdown('By task', t.byTask), breakdown('By project', t.byProject, projName))));
}

// ---------- run a utility ----------
function exampleFor(inputs) {
  if (!inputs || typeof inputs !== 'object') return {};
  const out = {};
  for (const [k, desc] of Object.entries(inputs)) {
    const d = String(desc).replace(/\?$/, '');
    if (d.endsWith('[]')) out[k] = [];
    else if (d.startsWith('number')) out[k] = 0;
    else if (d.startsWith('object')) out[k] = {};
    else if (d.includes('|')) out[k] = d.split('|')[0];
    else out[k] = '';
  }
  return out;
}

async function renderRun() {
  const head = (status) => el('div.section-head', el('h2', 'Run a utility'), status || null);
  clear(v.runBox, head(), loading());
  let util;
  try { util = await v.app.api.utility(); } catch (err) { return clear(v.runBox, head(), errorBox(err, renderRun)); }
  if (!v) return;
  const tasks = util.availableTasks || [];
  const sel = select(tasks.map((t) => [t.name, t.name]), tasks[0]?.name, { 'aria-label': 'Utility task' });
  const desc = el('p.hint', { style: { marginTop: '-8px', marginBottom: '16px' } });
  const json = textarea({ rows: 7, class: 'mono', spellcheck: false });
  const result = el('div', { 'aria-live': 'polite' });
  const runBtn = button('Run', { variant: 'primary' });
  const cancelBtn = button('Cancel', { variant: 'quiet', hidden: true });
  const fill = () => {
    const t = tasks.find((x) => x.name === sel.value);
    clear(desc, `${t?.description || ''} At most ${t?.maxOutputTokens} output tokens.`);
    json.value = JSON.stringify(t?.example || exampleFor(t?.inputs), null, 2);
  };
  sel.addEventListener('change', fill);
  fill();
  runBtn.addEventListener('click', async () => {
    let inputObj;
    try { inputObj = JSON.parse(json.value || '{}'); } catch (err) { return clear(result, el('p.note.danger', `Input is not valid JSON: ${err.message}`)); }
    v.run = { task: sel.value, runId: null, phase: 'starting', result, cancelBtn };
    runBtn.disabled = true; cancelBtn.hidden = false; cancelBtn.disabled = true;
    clear(result, loading(`Running ${sel.value}…`));
    try {
      const out = await v.app.api.runUtility(sel.value, { projectId: v.app.projectId(), input: inputObj });
      clear(result, el('p.meta', `validated · ${out.model} · ${out.usage?.inputTokens ?? 0} in / ${out.usage?.outputTokens ?? 0} out · ${usd(out.costUsd, 4)} · ${out.attempts} attempt(s) · ${out.durationMs} ms`),
        el('pre.out', JSON.stringify(out.output, null, 2)));
    } catch (err) { clear(result, runError(err)); }
    finally { if (v) v.run = null; runBtn.disabled = false; cancelBtn.hidden = true; }
  });
  cancelBtn.addEventListener('click', async () => {
    if (!v?.run?.runId) return;
    try { await v.app.api.cancelUtility(v.run.runId); toast('Cancel requested'); } catch (err) { toastError(err); }
  });
  v.util = util;
  v.runStatus = el('span');
  renderRunStatus();
  clear(v.runBox, head(v.runStatus),
    el('p.meta.prose-width', 'Bounded tasks with a schema-checked JSON result; each run is gated by the live ceiling and logged to the ledger.'),
    el('div', { style: { maxWidth: '640px', marginTop: '12px' } }, field('Task', sel), desc, field('Input (JSON)', json), el('div.row', runBtn, cancelBtn), el('div', { style: { marginTop: '12px' } }, result)));
}

/** The chip beside "Run a utility": follows the budget, because a pause can start or lift while the form holds typed input. */
function renderRunStatus() {
  if (!v?.runStatus) return;
  const pausedState = v.budget || v.util;
  const pause = pausedState.paused ? pauseWords(pausedState) : null;
  clear(v.runStatus, !v.util.configured ? stateChip('No API key', 'warn', 'Add a studio API key in Settings › API key')
    : pause ? stateChip(pause.label, 'warn', pause.title) : el('span.meta', `ready · ${v.util.model}`));
}

function runError(err) {
  const settings = button('Open Settings', { small: true, onclick: () => v.app.go('settings') });
  const sentence = (s) => { const t = String(s || '').trim(); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };
  const spent = (s) => (/nothing was (sent or )?spent/i.test(s) ? '' : ' Nothing was spent.');
  if (err.code === 'not_configured') return el('div.note.warn', el('p', `No API key: add a studio API key in Settings. Nothing was sent or spent.`), settings);
  // The server's refusal text is one humane sentence; show it as it is.
  if (err.code === 'budget_paused' || err.code === 'budget_exceeded') { const m = sentence(err.message); return el('div.note.warn', el('p', `${m}${spent(m)}`)); }
  if (err.code === 'cancelled') return el('p.note', 'Run cancelled.');
  return el('div.note.danger', el('p', `${err.code || 'error'} (${err.status || '?'}): ${err.message}`));
}

function onProgress(d) {
  if (!v?.run || d.task && d.task !== v.run.task && !(v.run.runId && d.runId === v.run.runId)) return;
  if (d.phase === 'started' && !v.run.runId) { v.run.runId = d.runId; v.run.cancelBtn.disabled = false; }
  if (v.run.runId && d.runId !== v.run.runId) return;
  const label = { started: 'Reserved budget, starting…', calling: `Calling the model (attempt ${d.attempt})…`, retrying: `Retrying after an error (${d.error})…`, repairing: 'Output failed validation; asking for one repair…' }[d.phase];
  if (label) clear(v.run.result, loading(label));
}
