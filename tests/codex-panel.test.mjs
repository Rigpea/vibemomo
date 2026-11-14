// The real workbenches/codex/panel.js, client/components/codex-words.js and client/components/session-parts.js on a
// stub DOM, as tests/companion-panel.test.mjs does for the Companion. Risks covered: the head must name the brain, the
// model and the login as the status route gave them; the defaults must be config.toml's and read-only; a choice must
// reach the session before it shows; no CLI, signed out and a refused model must each read as their own state with what
// to do; a new session must start read-only again. Layout and a real run are scripts/ui-check/verify-codex.cjs's.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as words from '../client/components/companion-words.js';
import * as codexWords from '../client/components/codex-words.js';

// ---------- a stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', placeholder: '', title: '' });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100;
    this._text = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, e = {}) { const ev = { preventDefault() {}, ...e }; for (const fn of this.listeners[type] || []) fn(ev); return ev; }
  focus() { document.activeElement = this; }
  querySelector(sel) { return all(this).find((n) => n !== this && n.tag === sel) || null; }
  get textContent() { return this._text ?? this.kids.map(textOf).join(' '); }
  set textContent(v) { this._text = String(v); this.kids = []; }
}
const textOf = (n) => (typeof n === 'string' ? n : n.hidden ? '' : n.textContent);
function el(spec, props, ...children) {
  if (props === null || props === undefined || props instanceof N || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const node = new N(spec);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') { if (v) node.classes.add(v); } else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
const toasts = [];
const ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c))); return node; },
  button: (text, { onclick, disabled, title, variant, small, icon, ...rest } = {}) => el('button', { onclick, disabled, title, ...rest, dataset: { variant: variant || '' } }, text || title),
  select: (options, value, props = {}) => el('select', { ...props, value }, options.map(([v, l]) => el('option', { value: v }, l))),
  textarea: (props = {}) => el('textarea', props),
  stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text),
  empty: (sentence, more) => el('div.empty', el('p', sentence), more ? el('p', more) : null),
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
};
const transcript = {
  renderTurn: (t) => el(`div.turn.${t.role}`, t.text || t.error || ''),
  orderedItems: (items) => items.filter((x) => x.kind === 'text').map((x) => el('p', x.text)),
  liveTurn: () => { const body = el('div'); return { node: el('div.turn.live', body), body }; },
  toolRows: (events, label) => { const calls = events.filter((e) => e.kind === 'tool'); return calls.length ? el('div.turn-events.traj', calls.map((e) => el('div', label(e)))) : null; },
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

globalThis.document = { activeElement: null };
globalThis.__ui = ui;
globalThis.__transcript = transcript;
globalThis.__words = words;
globalThis.__codexWords = codexWords;
const swap = (src) => src
  .replace(/import \{([^}]*)\} from '(?:\/components|\.)\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/transcript\.js';/, 'const {$1} = globalThis.__transcript;')
  .replace(/import \{([^}]*)\} from '\/components\/session-parts\.js';/, 'const {$1} = globalThis.__parts;')
  .replace(/import \{([^}]*)\} from '(?:\/components|\.)\/companion-words\.js';/, 'const {$1} = globalThis.__words;')
  .replace(/import \{([^}]*)\} from '\/components\/codex-words\.js';/, 'const {$1} = globalThis.__codexWords;');
globalThis.__parts = await import(`data:text/javascript,${encodeURIComponent(swap(await fsp.readFile(new URL('../client/components/session-parts.js', import.meta.url), 'utf8')))}`);
const panel = await import(`data:text/javascript,${encodeURIComponent(swap(await fsp.readFile(new URL('../workbenches/codex/panel.js', import.meta.url), 'utf8')))}`);

// ---------- the studio around it ----------
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const STATUS = {
  cli: true, bin: 'codex', version: 'codex-cli 0.0.0-fake', loggedIn: true, login: 'chatgpt', problem: null, source: 'models_cache.json',
  models: [{ id: 'gpt-a', name: 'GPT-A', efforts: ['low', 'high', 'ultra'], defaultEffort: 'low' }, { id: 'gpt-b', name: 'GPT-B', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
  defaults: { model: 'gpt-a', effort: 'high' }, sandboxes: ['read-only', 'workspace-write'], defaultSandbox: 'read-only',
};
const DONE = { id: 'cs_cdx', backend: 'codex', model: 'gpt-a', effort: 'high', sandbox: 'read-only', tools: 'studio', status: 'idle', title: 'Codex · Harbor', codexThreadId: '01a1',
  turns: [{ role: 'user', text: 'Is this right?', at: '2026-11-13T12:00:00.000Z' }, { role: 'assistant', backend: 'codex', text: 'It is.', at: '2026-11-13T12:00:10.000Z', events: [{ kind: 'tool', id: 'item_1', name: 'Shell', summary: 'git status --short', ms: 1200 }] }] };

function studio({ status = STATUS, session = null, sessionId = session?.id || null, ui: projectUi = {}, patch = null } = {}) {
  const calls = [];
  const listeners = {};
  const state = { status };
  const ctx = {
    projectId: 'p_1',
    project: { id: 'p_1', name: 'Harbor', ui: { codexSessionId: sessionId, ...projectUi } },
    app: { on: (topic, fn) => { (listeners[topic] ||= []).push(fn); return () => {}; } },
    api: {
      codexStatus: async (fresh) => { calls.push(['status', !!fresh]); if (!state.status) throw new Error('offline'); return structuredClone(state.status); },
      consoleGet: async (id) => { calls.push(['get', id]); if (!session || session.id !== id) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(session); },
      consoleCreate: async (b) => { calls.push(['create', b]); return { id: 'cs_new', ...b, status: 'idle', turns: [] }; },
      consolePatch: async (id, b) => { calls.push(['patch', id, b]); if (patch) return patch(b); Object.assign(session, b); return structuredClone(session); },
      consoleSend: async (id, b) => { calls.push(['send', id, b]); return { runId: 'cr_1' }; },
      consoleCancel: async (id) => { calls.push(['cancel', id]); return { cancelled: true }; },
      companionPins: async () => ({ pins: [] }),
    },
    saveUi: async (partial) => { calls.push(['saveUi', partial]); ctx.project.ui = { ...ctx.project.ui, ...partial }; return ctx.project.ui; },
    setNote: (text) => calls.push(['note', text]),
  };
  const emit = (topic, d) => (listeners[topic] || []).forEach((fn) => fn(d));
  return { ctx, calls, emit, state };
}
async function mount(opts = {}) {
  const s = studio(opts);
  const container = new N('div.wbp-host');
  panel.mount(container, s.ctx);
  await flush();
  const one = (c) => byClass(container, c)[0];
  const stateText = () => one('cmp-state').textContent.replace(/\s+/g, ' ').trim();
  const selects = () => find(one('cmp-choices'), (n) => n.tag === 'select');
  const box = () => find(one('cmp-composer'), (n) => n.tag === 'textarea')[0];
  return { ...s, container, one, stateText, selects, box };
}
afterEach(() => { panel.unmount(); panel._forget(); toasts.length = 0; });

// ---------- the pure words ----------
test('the header names the brain, the model and the login as the status said them', () => {
  assert.equal(codexWords.codexBrainLine(STATUS, 'gpt-a'), 'Codex · GPT-A · your ChatGPT login');
  assert.equal(codexWords.codexBrainLine(STATUS, 'gpt-unlisted'), 'Codex · gpt-unlisted · your ChatGPT login');
  assert.equal(codexWords.codexBrainLine(STATUS, ''), 'Codex · Codex\'s default model · your ChatGPT login');
  assert.equal(codexWords.codexBrainLine({ ...STATUS, login: 'api-key' }, 'gpt-a'), 'Codex · GPT-A · an API key saved in Codex');
  assert.equal(codexWords.codexBrainLine({ ...STATUS, loggedIn: false, login: null }, 'gpt-a'), 'Codex · GPT-A · signed out');
  assert.equal(codexWords.codexBrainLine({ ...STATUS, cli: false }, 'gpt-a'), 'Codex · GPT-A · CLI not found');
  assert.equal(codexWords.codexBrainLine(null, ''), 'Codex · Codex\'s default model · checking the login…');
});

test('the choices: config.toml\'s unless the person kept their own; an effort the model lacks is not carried; always read-only', () => {
  assert.deepEqual(codexWords.codexChoices({}, STATUS), { model: 'gpt-a', effort: 'high', sandbox: 'read-only' });
  assert.deepEqual(codexWords.codexChoices({ codex: { model: 'gpt-b', effort: 'medium', sandbox: 'workspace-write' } }, STATUS), { model: 'gpt-b', effort: 'medium', sandbox: 'read-only' });
  assert.deepEqual(codexWords.codexChoices({ codex: { model: 'gpt-b', effort: 'ultra' } }, STATUS), { model: 'gpt-b', effort: '', sandbox: 'read-only' });
  assert.deepEqual(codexWords.codexChoices({ codex: { model: 'gpt-gone', effort: 'low' } }, STATUS), { model: 'gpt-a', effort: 'high', sandbox: 'read-only' });
  assert.deepEqual(codexWords.codexChoices({}, { ...STATUS, defaults: { model: null, effort: null } }), { model: '', effort: '', sandbox: 'read-only' });
  assert.deepEqual(codexWords.codexEffortOptions(STATUS, 'gpt-a').map(([e]) => e), ['', 'low', 'high', 'ultra']);
  assert.equal(codexWords.takesEffort(STATUS, 'gpt-b', 'ultra'), false);
});

test('the state line: no CLI, signed out and a refused model are their own states; the rest is the Companion\'s rule', () => {
  const now = Date.parse('2026-11-13T12:00:30.000Z');
  assert.deepEqual(codexWords.codexState({ status: { ...STATUS, cli: false }, session: null }), { word: 'No Codex', reason: 'the Codex CLI was not found · Settings › Console', tone: 'danger' });
  assert.equal(codexWords.codexState({ status: { ...STATUS, loggedIn: false }, session: DONE, now }).word, 'Signed out');
  // A run that found no login: Signed out until the CLI says it is signed in again; then a failed message to send again.
  const lost = { ...DONE, turns: [DONE.turns[0], { role: 'assistant', backend: 'codex', text: '', isError: true, signedOut: true, error: 'Codex is signed out', at: '2026-11-13T12:00:10.000Z' }] };
  assert.equal(codexWords.codexState({ status: null, session: lost, now }).word, 'Signed out');
  assert.deepEqual(codexWords.codexState({ status: STATUS, session: lost, now }), { word: 'Failed', reason: 'the last message found no login · send it again', tone: 'danger' });
  const refused = { ...DONE, turns: [DONE.turns[0], { role: 'assistant', backend: 'codex', model: 'gpt-b', text: '', isError: true, modelRefused: true, error: 'Codex refused the model gpt-b', at: '2026-11-13T12:00:10.000Z' }] };
  assert.deepEqual(codexWords.codexState({ status: STATUS, session: refused, now }), { word: 'Model refused', reason: 'Codex refused gpt-b · choose another model', tone: 'danger' });
  assert.deepEqual(codexWords.codexState({ status: STATUS, session: DONE, now }), { word: 'Done', reason: 'just now', tone: 'ok' });
  assert.equal(codexWords.codexState({ status: STATUS, session: DONE, running: true, startedAt: now - 3000, lastTool: { name: 'Shell', summary: 'git status' }, now }).reason, '00:03 · Run git status');
  assert.deepEqual(codexWords.codexState({ status: STATUS, session: null }), { word: 'Idle', reason: 'no session yet', tone: 'neutral' });
});

// ---------- the panel ----------
test('no session: the head, config.toml\'s model and effort, read-only, and Start makes a Codex session with the studio tools', async () => {
  const s = await mount();
  assert.equal(s.one('cmp-brain').textContent, 'Codex · GPT-A · your ChatGPT login');
  assert.deepEqual(s.selects().map((x) => x.value), ['gpt-a', 'high', 'read-only']);
  assert.equal(s.selects()[2].attrs['aria-label'], 'The sandbox Codex runs in');
  assert.ok(!s.selects()[2].classes.has('cdx-write'));
  assert.equal(s.stateText(), 'Idle · no session yet');
  assert.equal(s.one('cmp-composer').hidden, true);
  assert.equal(s.one('cdx-problem').hidden, true);
  const start = buttonNamed(s.container, 'Start');
  assert.equal(start.disabled, false);
  start.fire('click');
  await flush();
  const created = s.calls.find((c) => c[0] === 'create')[1];
  assert.deepEqual(created, { backend: 'codex', projectId: 'p_1', model: 'gpt-a', effort: 'high', sandbox: 'read-only', tools: 'studio', title: 'Codex · Harbor' });
  assert.deepEqual(s.calls.find((c) => c[0] === 'saveUi')[1], { codexSessionId: 'cs_new' });
  assert.equal(s.one('cmp-composer').hidden, false);
  assert.equal(s.box().placeholder, 'Ask Codex…');
});

test('a remembered session is read again: the thread, the trajectory row and Done; never Start', async () => {
  const s = await mount({ session: structuredClone(DONE) });
  assert.ok(!buttonNamed(s.container, 'Start'));
  assert.match(s.one('cmp-log').textContent, /Is this right\?[\s\S]*It is\./);
  assert.match(s.one('cmp-traj-rows').textContent, /00:01 · Run · git status --short/);
  assert.match(s.stateText(), /^Done · /);
  assert.ok(s.calls.some((c) => c[0] === 'note' && c[1] === 'Session / Codex · Harbor'));
});

test('a choice reaches the session before it shows; workspace-write is marked; a refused change leaves the choice as it was', async () => {
  const session = structuredClone(DONE);
  const s = await mount({ session });
  s.selects()[2].fire('change', { target: { value: 'workspace-write' } });
  await flush();
  assert.deepEqual(s.calls.find((c) => c[0] === 'patch').slice(1), ['cs_cdx', { sandbox: 'workspace-write' }]);
  assert.equal(s.selects()[2].value, 'workspace-write');
  assert.ok(s.selects()[2].classes.has('cdx-write'), 'the sandbox choice carries the state colour while Codex may edit');
  assert.ok(!s.calls.some((c) => c[0] === 'saveUi' && c[1].codex), 'the sandbox is the session\'s, not kept for the next one');
  // the model: kept for the project too
  s.selects()[0].fire('change', { target: { value: 'gpt-b' } });
  await flush();
  assert.deepEqual(s.calls.filter((c) => c[0] === 'patch').at(-1)[2], { model: 'gpt-b' });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'saveUi').at(-1)[1], { codex: { model: 'gpt-b', effort: 'high' } });
  assert.equal(s.one('cmp-brain').textContent, 'Codex · GPT-B · your ChatGPT login');

  const r = await mount({ session: structuredClone(DONE), patch: () => { throw new Error('sandbox must be read-only or workspace-write'); } });
  r.selects()[2].fire('change', { target: { value: 'workspace-write' } });
  await flush();
  assert.equal(r.selects()[2].value, 'read-only');
  assert.deepEqual(toasts.at(-1), ['Not set on the session: sandbox must be read-only or workspace-write', 'danger']);
});

test('a model that does not take the effort: both go in one change and the person is told', async () => {
  const session = { ...structuredClone(DONE), effort: 'ultra' };
  const s = await mount({ session });
  assert.deepEqual(s.selects().map((x) => x.value), ['gpt-a', 'ultra', 'read-only']);
  s.selects()[0].fire('change', { target: { value: 'gpt-b' } });
  await flush();
  assert.deepEqual(s.calls.find((c) => c[0] === 'patch')[2], { model: 'gpt-b', effort: null });
  assert.deepEqual(toasts[0], ['GPT-B does not take ultra effort: the effort is now Codex\'s default for it.', undefined]);
  assert.deepEqual(s.selects().map((x) => x.value), ['gpt-b', '', 'read-only']);
});

test('no CLI: one sentence with what to do, Start off, the state No Codex; Check again asks afresh', async () => {
  const problem = 'The Codex CLI was not found: install it, or set its path in Settings › Console (or ATELIER_CODEX_BIN).';
  const s = await mount({ status: { ...STATUS, cli: false, loggedIn: null, login: null, problem } });
  assert.equal(s.one('cdx-problem').hidden, false);
  assert.match(s.one('cdx-problem').textContent, /^The Codex CLI was not found: install it, or set its path in Settings › Console/);
  assert.equal(buttonNamed(s.container, 'Start').disabled, true);
  assert.equal(s.stateText(), 'No Codex · the Codex CLI was not found · Settings › Console');
  assert.equal(s.one('cmp-brain').textContent, 'Codex · GPT-A · CLI not found');
  s.state.status = STATUS;
  buttonNamed(s.one('cdx-problem'), 'Check again').fire('click');
  await flush();
  assert.deepEqual(s.calls.filter((c) => c[0] === 'status').at(-1), ['status', true]);
  assert.equal(s.one('cdx-problem').hidden, true);
  assert.equal(buttonNamed(s.container, 'Start').disabled, false);
});

test('signed out: the sentence under the thread and the state; a refused model reads as its own state with the turn\'s sentence', async () => {
  const problem = 'Codex is signed out on this machine: run `codex login` in a terminal, then send the message again.';
  const s = await mount({ status: { ...STATUS, loggedIn: false, login: null, problem }, session: structuredClone(DONE) });
  assert.match(s.one('cdx-problem').textContent, /^Codex is signed out on this machine: run `codex login` in a terminal/);
  assert.equal(s.stateText(), 'Signed out · run codex login in a terminal, then send again');
  assert.equal(s.one('cmp-brain').textContent, 'Codex · GPT-A · signed out');
  panel.unmount();

  const refused = { ...structuredClone(DONE), model: 'gpt-b', effort: null, turns: [DONE.turns[0], { role: 'assistant', backend: 'codex', model: 'gpt-b', text: '', isError: true, modelRefused: true, error: 'Codex refused the model gpt-b: choose another model in the tab and send the message again.', at: '2026-11-13T12:00:10.000Z' }] };
  const r = await mount({ session: refused });
  assert.equal(r.stateText(), 'Model refused · Codex refused gpt-b · choose another model');
  assert.match(r.one('cmp-log').textContent, /Codex refused the model gpt-b: choose another model in the tab and send the message again\./);
});

test('a message is sent to the session; the live run reads Working with its last command; the end reads from the record', async () => {
  const session = structuredClone(DONE);
  const s = await mount({ session });
  s.box().value = 'And the tests?';
  buttonNamed(s.container, 'Send').fire('click');
  await flush();
  assert.deepEqual(s.calls.find((c) => c[0] === 'send').slice(1), ['cs_cdx', { text: 'And the tests?' }]);
  assert.match(s.stateText(), /^Working · 00:0\d · thinking$/);
  assert.equal(buttonNamed(s.container, 'Stop').disabled, false);
  s.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_cdx', runId: 'cr_1', kind: 'tool', id: 'item_1', name: 'Shell', summary: 'npm test', ms: 900 } });
  s.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_cdx', runId: 'cr_1', kind: 'text', text: 'They pass.' } });
  assert.match(s.stateText(), /^Working · 00:0\d · Run npm test$/);
  assert.match(s.one('cmp-traj-rows').textContent, /00:00 · Run · npm test/);
  buttonNamed(s.container, 'Stop').fire('click');
  await flush();
  assert.ok(s.calls.some((c) => c[0] === 'cancel' && c[1] === 'cs_cdx'));
  session.turns.push({ role: 'user', text: 'And the tests?', at: new Date().toISOString() }, { role: 'assistant', backend: 'codex', text: 'They pass.', at: new Date(Date.now() + 5).toISOString(), events: [] });
  s.emit('console', { name: 'console.done', data: { sessionId: 'cs_cdx', runId: 'cr_1', turn: session.turns.at(-1) } });
  await flush();
  assert.match(s.stateText(), /^Done · just now$/);
  assert.equal(s.box().disabled, false);
});

test('a send the server refuses for a missing login puts the words back and asks the status afresh', async () => {
  const s = await mount({ session: structuredClone(DONE) });
  s.ctx.api.consoleSend = async () => { throw Object.assign(new Error('Codex is signed out on this machine: run `codex login` in a terminal, then send the message again.'), { code: 'console_codex_signed_out', status: 503 }); };
  s.box().value = 'Hello';
  buttonNamed(s.container, 'Send').fire('click');
  await flush();
  assert.equal(s.box().value, 'Hello');
  assert.match(toasts.at(-1)[0], /^Send: Codex is signed out/);
  assert.deepEqual(s.calls.filter((c) => c[0] === 'status').at(-1), ['status', true]);
});

test('New session forgets the id and starts read-only again, with the model and effort as they were', async () => {
  const session = { ...structuredClone(DONE), sandbox: 'workspace-write', model: 'gpt-b', effort: 'medium' };
  const s = await mount({ session });
  assert.deepEqual(s.selects().map((x) => x.value), ['gpt-b', 'medium', 'workspace-write']);
  buttonNamed(s.container, 'New session').fire('click');
  await flush();
  assert.deepEqual(s.calls.filter((c) => c[0] === 'saveUi').at(-1)[1], { codexSessionId: null });
  assert.deepEqual(s.selects().map((x) => x.value), ['gpt-b', 'medium', 'read-only']);
  assert.ok(buttonNamed(s.container, 'Start'));
});

test('the box keeps what was typed across a project switch and back', async () => {
  const s = await mount({ session: structuredClone(DONE) });
  s.box().value = 'half a thought';
  panel.unmount();
  const container = new N('div.wbp-host');
  panel.mount(container, s.ctx);
  await flush();
  assert.equal(find(byClass(container, 'cmp-composer')[0], (n) => n.tag === 'textarea')[0].value, 'half a thought');
});
