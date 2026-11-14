// The real workbenches/companion/panel.js and client/components/companion-words.js on a stub DOM, as
// tests/phone-panel.test.mjs does: the split, the state words, the pins and the chip and block they add to a message,
// the placeholder, Make it a task's message, Start and the remembered session, and the dock height clamp.
// The layout tests stub the transcript renderer; the tests at the end load the real client/components/transcript.js
// (renderTurn, toolRows, and the panel drawing a session through it), because the stub alone let #81's throw through.
// Layout, the grip and a real session are scripts/ui-check/verify-companion.cjs's to check.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import * as words from '../client/components/companion-words.js';

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
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) {
    const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...e };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  append(...more) { this.kids.push(...flatten(more).map((c) => (c instanceof N ? c : String(c)))); }
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
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'class') node.classes.add(v);
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
const toasts = [];
const ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c))); return node; },
  button: (text, { onclick, disabled, title, type = 'button', variant, small, icon, ...rest } = {}) => el('button', { type, onclick, disabled, title, ...rest, dataset: { variant: variant || '' } }, text || title),
  select: (options, value, props = {}) => el('select', { ...props, value }, options.map(([v, l]) => el('option', { value: v }, l))),
  textarea: (props = {}) => el('textarea', props),
  stateChip: (text, tone, title) => el(`span.chip.tone-${tone}`, { title }, text),
  empty: (sentence, more, action) => el('div.empty', el('p', sentence), more ? el('p', more) : null, action || null),
  toast: (message, opts) => { toasts.push([message, opts?.tone]); },
};
// The transcript renderer, stubbed for the layout tests: a turn is its role and text; the trajectory's rows carry the
// label the panel gives; a turn with `boom` throws as a broken renderer would. The real module is loaded further down
// (realTranscript, realPanel): the stub alone is how #81's callLabel throw escaped.
const transcript = {
  renderTurn: (t) => { if (t.boom) throw new Error(t.boom); return el(`div.turn.${t.role}`, t.text); },
  orderedItems: (items) => items.filter((x) => x.kind === 'text').map((x) => el('p', x.text)),
  liveTurn: () => { const body = el('div'); return { node: el('div.turn.live', body), body }; },
  toolRows: (events, label) => {
    const calls = events.filter((e) => e.kind === 'tool');
    return calls.length ? el('div.turn-events.traj', calls.map((e) => el('div', label(e)))) : null;
  },
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

globalThis.document = { activeElement: null };
// The panel draws its thread, trajectory, state line and pins through client/components/session-parts.js (shared with
// the Codex tab): the real file, with its ui.js, transcript.js and companion-words.js imports swapped the same way.
const partsSource = (await fsp.readFile(new URL('../client/components/session-parts.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/transcript\.js';/, 'const {$1} = globalThis.__transcript;')
  .replace(/import \{([^}]*)\} from '\.\/companion-words\.js';/, 'const {$1} = globalThis.__words;');
const source = (await fsp.readFile(new URL('../workbenches/companion/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{[^}]*\} from '\/components\/ui\.js';/, 'const { el, clear, button, select, textarea, stateChip, empty, toast } = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\/components\/session-parts\.js';/, 'const {$1} = globalThis.__parts;')
  .replace(/import \{([^}]*)\} from '\/components\/companion-words\.js';/, 'const {$1} = globalThis.__words;');
globalThis.__ui = ui;
globalThis.__transcript = transcript;
globalThis.__words = words;
globalThis.__parts = await import(`data:text/javascript,${encodeURIComponent(partsSource)}`);
const panel = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const _state = () => panel._state();

// The real client/components/transcript.js on the same stub DOM: only its ui.js and markdown.js imports are swapped
// (markdown builds through document); transcript-match.js is the real file.
globalThis.__md = { markdown: (text, cls) => el(`div.${String(cls || 'md').split(' ').join('.')}`, text) };
const transcriptSource = (await fsp.readFile(new URL('../client/components/transcript.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/markdown\.js';/, 'const {$1} = globalThis.__md;')
  .replace("'./transcript-match.js'", JSON.stringify(new URL('../client/components/transcript-match.js', import.meta.url).href));
const realTranscript = await import(`data:text/javascript,${encodeURIComponent(transcriptSource)}`);
globalThis.__realTranscript = realTranscript;
globalThis.__realParts = await import(`data:text/javascript,${encodeURIComponent(partsSource.replace('globalThis.__transcript;', 'globalThis.__realTranscript;'))}`);
const realPanel = await import(`data:text/javascript,${encodeURIComponent(source.replace('globalThis.__parts;', 'globalThis.__realParts;'))}`);

// ---------- the studio around it ----------
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const PINS = [
  { id: 'pin_a', source: 'phone', element: 'span.mini-case-label', text: 'Case one', selector: '.mini-case-label', point: { device: { x: 540, y: 1200 }, css: { x: 205.71, y: 433.14 } }, files: ['index.html:73', 'app.js:12', 'style.css:9', 'more.js:1'], page: 'https://localhost/', note: '' },
  { id: 'pin_b', source: 'phone', element: 'ul#case-grid', text: '', selector: '#case-grid', point: null, files: [], page: '', note: '' },
];
const DONE = { id: 'cs_one', backend: 'claude-code', model: 'claude-opus-5-5', permissionMode: 'acceptEdits', tools: 'studio', context: 'companion', status: 'idle', title: 'Companion · Harbor',
  turns: [{ role: 'user', text: 'What is this?', at: '2026-11-06T12:00:00.000Z' }, { role: 'assistant', text: 'A label.', at: '2026-11-06T12:00:10.000Z', events: [{ kind: 'tool', id: 'tu_1', name: 'Read', summary: 'src/index.html', ms: 1200 }] }] };

function studio({ session = null, sessionId = session?.id || null, pins = [] } = {}) {
  const calls = [];
  const listeners = {};
  const ctx = {
    projectId: 'p_1',
    project: { id: 'p_1', name: 'Harbor', ui: { companionSessionId: sessionId } },
    app: { on: (topic, fn) => { (listeners[topic] ||= []).push(fn); return () => {}; } },
    api: {
      consoleGet: async (id) => { calls.push(['get', id]); if (!session || session.id !== id) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(session); },
      consoleCreate: async (b) => { calls.push(['create', b]); return { id: 'cs_new', ...b, status: 'idle', turns: [] }; },
      consoleSend: async (id, b) => { calls.push(['send', id, b]); return { runId: 'cr_1' }; },
      consoleCancel: async (id) => { calls.push(['cancel', id]); return { cancelled: true }; },
      companionPins: async () => ({ pins }),
      removeCompanionPin: async (pid, id) => { calls.push(['remove', id]); pins = pins.filter((p) => p.id !== id); return { removed: id }; },
    },
    saveUi: async (partial) => { calls.push(['saveUi', partial]); ctx.project.ui = { ...ctx.project.ui, ...partial }; return ctx.project.ui; },
    setCount: (n) => calls.push(['count', n]),
  };
  const emit = (topic, d) => (listeners[topic] || []).forEach((fn) => fn(d));
  return { ctx, calls, emit };
}
async function mount(opts = {}, which = panel) {
  const s = studio(opts);
  const container = new N('div.wbp-host');
  which.mount(container, s.ctx);
  await flush();
  // The stub joins children with a space; the real DOM has none, so the separator span is what reads " · ".
  const stateText = () => byClass(container, 'cmp-state')[0].textContent.replace(/\s+/g, ' ').trim();
  const composer = () => byClass(container, 'cmp-composer')[0];
  const box = () => find(composer(), (n) => n.tag === 'textarea')[0];
  return { ...s, container, stateText, composer, box };
}
afterEach(() => { panel.unmount(); realPanel.unmount(); panel._forget(); realPanel._forget(); toasts.length = 0; });

// ---------- the pure words ----------
test('the dock height clamps between 180 px and the stage less 120 px', () => {
  assert.equal(words.clampDockHeight(100, 900), 180);
  assert.equal(words.clampDockHeight(500, 900), 500);
  assert.equal(words.clampDockHeight(2000, 900), 780);
  assert.equal(words.clampDockHeight(400, 250), 180, 'a stage too small for both keeps the minimum');
  assert.equal(words.clampDockHeight('abc', 900), null);
  assert.equal(words.clampDockHeight(333.6, 900), 334);
});

test('watchCount: the pins count reaches the tab before the panel mounts, follows a pins event, and stops', async () => {
  let pins = [{ id: 'pin_a' }, { id: 'pin_b' }];
  const counts = [];
  const listeners = {};
  const ctx = {
    projectId: 'p_1', setCount: (n) => counts.push(n),
    api: { companionPins: async (id) => { assert.equal(id, 'p_1'); return { pins }; } },
    app: { on: (topic, fn) => { (listeners[topic] ||= []).push(fn); return () => { listeners[topic] = listeners[topic].filter((f) => f !== fn); }; } },
  };
  const stop = panel.watchCount(ctx);
  await flush();
  assert.deepEqual(counts, [2]);
  pins = [{ id: 'pin_a' }];
  listeners.pins[0]({ projectId: 'p_2' });
  await flush();
  assert.deepEqual(counts, [2], 'another project\'s pins change nothing');
  listeners.pins[0]({ projectId: 'p_1' });
  await flush();
  assert.deepEqual(counts, [2, 1]);
  stop();
  assert.deepEqual(listeners.pins, [], 'unsubscribed');
  listeners.sse?.forEach?.(() => {});
  assert.equal(panel._state?.() ?? null, null, 'nothing mounted by watching');
});

test('the choices and the attachments: kept per project with defaults, the files block names paths for the Read tool', () => {
  assert.deepEqual(words.companionChoices({}), { model: 'claude-opus-5-5', effort: '', permissionMode: 'auto', chrome: true }, 'Auto and Chrome by default (the person, 2026-11-07 and 2026-11-13)');
  assert.deepEqual(words.companionChoices({ companion: { model: 'claude-haiku-5-5', effort: 'max', permissionMode: 'plan', chrome: false } }), { model: 'claude-haiku-5-5', effort: 'max', permissionMode: 'plan', chrome: false });
  assert.deepEqual(words.companionChoices({ companion: { model: 'gpt-9', effort: 'huge', permissionMode: 'yolo' } }), { model: 'claude-opus-5-5', effort: '', permissionMode: 'auto', chrome: true }, 'unknown values fall back');
  const signedOut = { turns: [{ role: 'user', text: 'hi', at: '2026-11-07T17:10:46.056Z' }, { role: 'assistant', text: 'Failed to authenticate: OAuth session expired and could not be refreshed', at: '2026-11-07T17:10:47.584Z', isError: true, signedOut: true }] };
  assert.deepEqual(words.companionState({ session: signedOut }), { word: 'Signed out', reason: 'Claude Code has no working sign-in on this machine · Settings', tone: 'danger' });
  assert.equal(words.modeWords('bypassPermissions'), 'Runs anything');
  assert.equal(words.attachmentBlock([]), '');
  assert.equal(words.messageWithAttachments('Look at this', [{ path: '.studio/attachments/20261107-081500-shot.png', name: 'shot.png', bytes: 20480, type: 'image/png' }, { path: '.studio/attachments/20261107-081501-notes.md', name: 'notes.md', bytes: 300, type: null }]),
    'Look at this\n\n---\nAttached files (from the studio, inside this project):\n- .studio/attachments/20261107-081500-shot.png (image/png, 20 KB)\n- .studio/attachments/20261107-081501-notes.md (1 KB)\nRead them with the Read tool before answering.');
});

test('a tool reads as a verb and its file: the trajectory line and the working reason', () => {
  assert.equal(words.trajectoryLabel({ name: 'Grep', summary: 'spacing', ms: 19000 }), '00:19 · Search · “spacing”', 'a pattern is quoted, so it does not read as a file');
  assert.equal(words.trajectoryLabel({ name: 'Glob', summary: '**/*.css' }), 'Find files · “**/*.css”');
  assert.equal(words.companionState({ session: { turns: [] }, running: true, lastTool: { name: 'Grep', summary: 'spacing' } }).reason, 'Search “spacing”');
  assert.equal(words.toolVerb('Edit'), 'Edit');
  assert.equal(words.toolVerb('mcp__atelier__atelier_phone_screenshot'), 'Phone screenshot');
  assert.equal(words.toolVerb('mcp__atelier__atelier_phone_inspect'), 'Inspect');
  assert.equal(words.toolVerb('mcp__atelier__atelier_studio_show'), 'Show');
  assert.equal(words.toolVerb('mcp__atelier__atelier_create_task'), 'Task created');
  assert.equal(words.toolVerb('mcp__other__fetch_page'), 'Fetch page');
  assert.equal(words.trajectoryLabel({ name: 'Edit', summary: 'C:\\harbor\\src\\welcome.mjs', ms: 19000 }), '00:19 · Edit · welcome.mjs');
  assert.equal(words.trajectoryLabel({ name: 'mcp__atelier__atelier_phone_inspect', summary: '{"x":540,"y":1200}' }), 'Inspect · x 540, y 1200');
  assert.equal(words.trajectoryLabel({ name: 'Bash', summary: 'npm test', ms: 3_725_000 }), '1:02:05 · Run · npm test');
});

test('the state line: one word and its reason, from the record and the run', () => {
  const now = Date.parse('2026-11-06T12:02:10.000Z');
  assert.deepEqual(words.companionState({ session: null }), { word: 'Idle', reason: 'no session yet', tone: 'neutral' });
  assert.deepEqual(words.companionState({ session: { turns: [] }, now }), { word: 'Idle', reason: 'no message yet', tone: 'neutral' });
  assert.deepEqual(words.companionState({ session: DONE, running: true, startedAt: now - 48000, lastTool: { name: 'Edit', summary: 'src/welcome.mjs' }, now }), { word: 'Working', reason: '00:48 · Edit welcome.mjs', tone: 'busy' });
  assert.equal(words.companionState({ session: DONE, running: true, startedAt: now - 2000, now }).reason, '00:02 · thinking');
  assert.deepEqual(words.companionState({ session: DONE, now }), { word: 'Done', reason: '2 min ago', tone: 'ok' });
  const asking = { turns: [DONE.turns[0], { ...DONE.turns[1], text: 'It is the label.\n\nShould I make it a task?' }] };
  assert.deepEqual(words.companionState({ session: asking, now }), { word: 'Needs you', reason: 'a question is waiting', tone: 'warn' });
  assert.equal(words.companionState({ session: { turns: [DONE.turns[0], { ...DONE.turns[1], text: '', isError: true, error: 'claude exited with 1' }] }, now }).word, 'Failed');
  assert.equal(words.asksQuestion('Which one? I can do either.'), false, 'a question in the middle is not the last word');
  assert.equal(words.asksQuestion('Shall I go on?**'), true);
});

test('pins: the card title, the chip, the block a message carries, the placeholder and the readout as a pin', () => {
  assert.equal(words.pinTitle(PINS[0], 1), 'Pin 1 · span.mini-case-label · index.html:73');
  assert.equal(words.pinTitle(PINS[1], 2), 'Pin 2 · ul#case-grid');
  assert.equal(words.pinChip('Harbor', [PINS[0]]), 'Harbor / Phone / span.mini-case-label');
  assert.equal(words.pinChip('Harbor', PINS), 'Harbor / Phone / 2 pins');
  assert.equal(words.pinChip('Harbor', []), null);
  const block = words.pinBlock([PINS[0]]);
  assert.equal(block, [
    '', '---', 'Selected pin (from the studio):',
    'Pin 1 · phone · https://localhost/',
    '- Point: device (540, 1200), page CSS (205.71, 433.14)',
    '- Element: span.mini-case-label (selector .mini-case-label)',
    '- Text: "Case one"',
    '- Files: index.html:73, app.js:12, style.css:9',
    '(the companion can call atelier_phone_screenshot for the picture.)',
  ].join('\n'));
  assert.equal(words.messageWithPins('Make it larger', []), 'Make it larger');
  assert.equal(words.composerPlaceholder(true), 'Refine the selected part…');
  assert.equal(words.composerPlaceholder(false), 'Ask about this page…');
  assert.deepEqual(words.pinFromReadout({ element: { tag: 'span', classes: ['mini-case-label'], text: 'Case one', selector: '.mini-case-label' }, point: { device: { x: 1, y: 2 }, css: { x: 0.5, y: 1 }, dpr: 2 }, candidates: [{ file: 'index.html', line: 73 }], page: { url: 'https://localhost/' } }),
    { source: 'phone', element: 'span.mini-case-label', text: 'Case one', selector: '.mini-case-label', point: { device: { x: 1, y: 2 }, css: { x: 0.5, y: 1 } }, files: ['index.html:73'], page: 'https://localhost/' });
  assert.equal(words.isStacked(759), true);
  assert.equal(words.isStacked(760), false);
  assert.equal(words.brainLine('claude-opus-5-5'), 'Claude Code · Opus 5.5 · your login');
  assert.equal(words.brainLine('claude-fable-5-1'), 'Claude Code · Fable 5.1 · your login');
  assert.equal(words.brainLine('claude-fable-5-2'), 'Claude Code · Fable 5.2 · your login');
});

// ---------- the panel ----------
test('no session: Idle with its reason, a Start button and the model picker; Start creates the session and remembers it', async () => {
  const p = await mount();
  assert.match(p.stateText(), /^Idle · no session yet$/);
  assert.equal(byClass(p.container, 'cmp-brain')[0].textContent, 'Claude Code · Opus 5.5 · your login');
  const picker = find(p.container, (n) => n.tag === 'select')[0];
  assert.deepEqual(find(picker, (n) => n.tag === 'option').map((o) => o.value), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  picker.fire('change', { target: { value: 'claude-fable-5-1' } });
  assert.equal(byClass(p.container, 'cmp-brain')[0].textContent, 'Claude Code · Fable 5.1 · your login');
  assert.equal(p.composer().hidden, true, 'no composer before a session');
  buttonNamed(p.container, 'Start').fire('click');
  await flush();
  assert.deepEqual(p.calls.find((c) => c[0] === 'create')[1], {
    backend: 'claude-code', projectId: 'p_1', model: 'claude-fable-5-1', permissionMode: 'auto', effort: null, chrome: true, tools: 'studio', context: 'companion', title: 'Companion · Harbor',
  });
  assert.deepEqual(p.calls.filter((c) => c[0] === 'saveUi').map((c) => c[1]), [{ companion: { model: 'claude-fable-5-1', effort: '', permissionMode: 'auto', chrome: true } }, { companionSessionId: 'cs_new' }], 'the picked model is kept per project, then the session id');
  assert.equal(p.composer().hidden, false);
  assert.match(p.stateText(), /^Idle · no message yet$/);
});

test('a remembered session is read again: the thread on the left, the trajectory on the right, Done with when', async () => {
  const p = await mount({ session: DONE });
  assert.deepEqual(p.calls[0], ['get', 'cs_one']);
  const split = byClass(p.container, 'cmp-split')[0];
  assert.deepEqual(split.kids.map((k) => [...k.classes][0]), ['cmp-thread', 'cmp-traj']);
  assert.deepEqual(byClass(p.container, 'turn').map((t) => t.kids[0]), ['What is this?', 'A label.']);
  assert.match(p.stateText(), /^Done · \S/);
  assert.deepEqual(find(byClass(p.container, 'cmp-traj-rows')[0], (n) => n.tag === 'div' && typeof n.kids[0] === 'string').map((n) => n.kids[0]), ['00:01 · Read · index.html']);
  assert.ok(buttonNamed(p.container, 'New session'), 'starting over is offered');
});

test('a stored id the console no longer has is forgotten, and Start comes back', async () => {
  const p = await mount({ sessionId: 'cs_gone' });
  assert.deepEqual(p.calls.find((c) => c[0] === 'saveUi')[1], { companionSessionId: null });
  assert.ok(buttonNamed(p.container, 'Start'));
});

test('pins: numbered cards under the thread; a selected pin is a chip above the composer, rides the next message as a block, and is then let go', async () => {
  const p = await mount({ session: DONE, pins: structuredClone(PINS) });
  assert.deepEqual(p.calls.filter((c) => c[0] === 'count').at(-1), ['count', 2], 'the tab counts the pins');
  const cards = byClass(p.container, 'pin-card');
  assert.deepEqual(cards.map((c) => byClass(c, 'pin-title')[0].kids[0]), ['Pin 1 · span.mini-case-label · index.html:73', 'Pin 2 · ul#case-grid']);
  assert.equal(p.box().placeholder, 'Ask about this page…');
  assert.equal(byClass(p.container, 'attach').length, 0);
  cards[0].fire('click');
  assert.equal(byClass(p.container, 'pin-card')[0].attrs['aria-pressed'], 'true');
  assert.equal(byClass(p.container, 'attach')[0].kids[0], 'Harbor / Phone / span.mini-case-label');
  assert.equal(p.box().placeholder, 'Refine the selected part…');
  p.box().value = 'Make it larger';
  p.box().fire('keydown', { key: 'Enter' });
  await flush();
  const sent = p.calls.find((c) => c[0] === 'send');
  assert.equal(sent[1], 'cs_one');
  assert.equal(sent[2].text, `Make it larger\n${words.pinBlock([PINS[0]])}`);
  assert.match(sent[2].text, /Pin 1 · phone[\s\S]*- Files: index\.html:73, app\.js:12, style\.css:9\n\(the companion can call atelier_phone_screenshot for the picture\.\)$/);
  assert.equal(byClass(p.container, 'attach').length, 0, 'the next message carries what is selected then');
  assert.equal(p.box().placeholder, 'Ask about this page…');
  // Remove asks the route and the list follows.
  find(byClass(p.container, 'cmp-pin')[1], (n) => n.tag === 'button' && n.kids[0] === 'Remove')[0].fire('click');
  await flush();
  assert.deepEqual(p.calls.find((c) => c[0] === 'remove'), ['remove', 'pin_b']);
  assert.equal(byClass(p.container, 'pin-card').length, 1);
});

test('Make it a task sends the canned message and keeps what was being typed', async () => {
  const p = await mount({ session: DONE });
  p.box().value = 'half a thought';
  buttonNamed(p.container, 'Make it a task').fire('click');
  await flush();
  assert.equal(p.calls.find((c) => c[0] === 'send')[2].text, 'Turn this thread into a studio task with atelier_create_task: a title, the request with the pins\' files named, the numbers of the pins it is about as pins, three acceptance lines, mode handle; then tell me the task id.');
  assert.equal(p.box().value, 'half a thought');
});

test('a live run: Working with the clock and the last call, tool rows in the trajectory, then Needs you when the answer asks', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-11-06T12:05:00.000Z') });
  const p = await mount({ session: DONE });
  p.emit('console', { name: 'console.started', data: { sessionId: 'cs_one', runId: 'cr_2' } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_other', kind: 'tool', id: 'x', name: 'Write', summary: 'elsewhere.js', ms: 1 } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_one', kind: 'tool', id: 'tu_9', name: 'Edit', summary: 'src/welcome.mjs', ms: 19000 } });
  t.mock.timers.tick(48000);
  assert.match(p.stateText(), /^Working · 00:48 · Edit welcome\.mjs$/);
  const sep = byClass(p.container, 'cmp-sep')[0];
  assert.equal(sep.kids[0], ' · ', 'the word and the clock are apart in the text itself, not only by the gap');
  const rows = () => find(byClass(p.container, 'cmp-traj-rows')[0], (n) => n.tag === 'div' && typeof n.kids[0] === 'string').map((n) => n.kids[0]);
  assert.deepEqual(rows(), ['00:19 · Edit · welcome.mjs']);
  assert.equal(p.box().disabled, true, 'one message at a time');
  const asked = { ...DONE, turns: [...DONE.turns, { role: 'user', text: 'Fix it', at: new Date().toISOString() }, { role: 'assistant', text: 'Done the edit.\n\nShall I keep a version?', at: new Date().toISOString(), events: [] }] };
  p.ctx.api.consoleGet = async () => structuredClone(asked);
  p.emit('console', { name: 'console.done', data: { sessionId: 'cs_one', runId: 'cr_2' } });
  await flush();
  assert.match(p.stateText(), /^Needs you · a question is waiting$/);
});

// ---------- the real transcript module (t_mpgiatgi68) ----------
const textAll = (n) => (typeof n === 'string' ? n : n.kids.map(textAll).join(' ')).replace(/\s+/g, ' ').trim();
const leafTexts = (root) => find(root, (n) => n.kids.length === 1 && typeof n.kids[0] === 'string').map((n) => n.kids[0]);
const READ = [{ kind: 'tool', id: 'tu_1', name: 'Read', summary: 'src/index.html', ms: 1200 }, { kind: 'tool-result', id: 'tu_1', name: 'Read', ok: true, summary: '12 lines', ms: 1300 }];

test('the real renderTurn draws a finished turn whose tool events carry ms (the #81 throw: flatMap gave rowNodes the index)', () => {
  const node = realTranscript.renderTurn({ role: 'assistant', text: 'A label.', at: 'x', events: READ, durationMs: 21000 }, { backend: 'claude-code' });
  const texts = leafTexts(node);
  assert.ok(texts.includes('Read · src/index.html'), texts.join(' | '));
  assert.ok(texts.includes('12 lines'), 'the result line sits under its call');
  assert.ok(texts.includes('A label.'));
});

test('the real toolRows: the panel\'s verb function labels each call; no function and null fall back to name · summary', () => {
  assert.deepEqual(leafTexts(realTranscript.toolRows(READ, words.trajectoryLabel)), ['00:01 · Read · index.html', '12 lines']);
  assert.deepEqual(leafTexts(realTranscript.toolRows(READ)), ['Read · src/index.html', '12 lines']);
  assert.deepEqual(leafTexts(realTranscript.toolRows(READ, null)), ['Read · src/index.html', '12 lines']);
  assert.equal(realTranscript.toolRows([{ kind: 'text', text: 'hi' }], words.trajectoryLabel), null);
});

test('the panel through the real transcript: a session with two turns is drawn, and a run ends on Done with no "answering" left', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-11-06T12:05:00.000Z') });
  const session = { ...DONE, turns: [DONE.turns[0], { ...DONE.turns[1], events: READ }] };
  const p = await mount({ session }, realPanel);
  const log = byClass(p.container, 'cmp-log')[0];
  assert.equal(byClass(log, 'cmp-start').length, 0, 'a stored, readable session never shows Start');
  assert.equal(byClass(log, 'turn').length, 2);
  assert.match(textAll(log), /What is this\?.*Read · src\/index\.html.*A label\./);
  assert.match(p.stateText(), /^Done · /);
  assert.deepEqual(leafTexts(byClass(p.container, 'cmp-traj-rows')[0]), ['00:01 · Read · index.html', '12 lines']);
  // A run: the live turn says answering, then the record's new turn replaces it.
  p.emit('console', { name: 'console.started', data: { sessionId: 'cs_one', runId: 'cr_2' } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_one', kind: 'tool', id: 'tu_2', name: 'Read', summary: 'copy.mjs', ms: 2000 } });
  t.mock.timers.tick(23000);
  assert.match(p.stateText(), /^Working · 00:23 · Read copy\.mjs$/);
  assert.match(textAll(log), /answering/);
  const after = { ...session, turns: [...session.turns, { role: 'user', text: 'And this?', at: new Date().toISOString() }, { role: 'assistant', text: 'A copy helper.', at: new Date().toISOString(), events: [{ kind: 'tool', id: 'tu_2', name: 'Read', summary: 'copy.mjs', ms: 2000 }] }] };
  p.ctx.api.consoleGet = async () => structuredClone(after);
  p.emit('console', { name: 'console.done', data: { sessionId: 'cs_one', runId: 'cr_2' } });
  await flush();
  assert.match(p.stateText(), /^Done · just now$/);
  assert.doesNotMatch(textAll(log), /answering/);
  assert.match(textAll(log), /A copy helper\./);
  assert.equal(byClass(log, 'cmp-draw-error').length, 0);
});

test('a fresh load with a stored id shows the session being read, never Start, and Start cannot make a second session', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = studio({ session: DONE });
  const get = s.ctx.api.consoleGet;
  s.ctx.api.consoleGet = async (id) => { await gate; return get(id); };
  const container = new N('div.wbp-host');
  realPanel.mount(container, s.ctx);
  await flush();
  assert.equal(buttonNamed(container, 'Start'), undefined, 'no Start while the stored session is being read');
  assert.match(textAll(byClass(container, 'cmp-log')[0]), /Reading the companion session/);
  release();
  await flush();
  assert.match(textAll(byClass(container, 'cmp-log')[0]), /A label\./);
  assert.equal(s.calls.filter((c) => c[0] === 'create').length, 0);
});

test('a render that throws shows one danger note with Retry, logs once, and the state line still follows the record', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const broken = { ...DONE, turns: [DONE.turns[0], { ...DONE.turns[1], boom: 'callLabel is not a function' }] };
  const p = await mount({ session: broken });
  const log = () => byClass(p.container, 'cmp-log')[0];
  const note = () => byClass(log(), 'cmp-draw-error')[0];
  assert.ok(note(), 'the thread holds the note instead of what was drawn before');
  assert.equal(note().attrs.role, 'alert');
  assert.match(textAll(note()), /^The companion view could not be drawn: callLabel is not a function\. Retry$/);
  assert.match(p.stateText(), /^Done · /, 'the state comes from the record, not from the last good draw');
  panel._setStacked(true); panel._setStacked(false); // more draws of the same failure
  p.emit('sse', { state: 'open' });
  await flush();
  assert.equal(logged.mock.callCount(), 1, 'one console.error for one failure');
  // Retry reads the record again; a record that draws takes the note away.
  p.ctx.api.consoleGet = async () => structuredClone(DONE);
  buttonNamed(note(), 'Retry').fire('click');
  await flush();
  assert.equal(byClass(log(), 'cmp-draw-error').length, 0);
  assert.deepEqual(byClass(p.container, 'turn').map((x) => x.kids[0]), ['What is this?', 'A label.']);
});

test('under 760 px the trajectory stacks, folded to its state line until pressed', async () => {
  const p = await mount({ session: DONE });
  panel._setStacked(true);
  assert.ok(byClass(p.container, 'cmp-split')[0].classes.has('stacked'));
  assert.equal(byClass(p.container, 'cmp-traj-rows')[0].hidden, true);
  const toggle = byClass(p.container, 'cmp-state-btn')[0];
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  toggle.fire('click');
  assert.equal(byClass(p.container, 'cmp-traj-rows')[0].hidden, false);
  assert.equal(byClass(p.container, 'cmp-state-btn')[0].attrs['aria-expanded'], 'true');
  panel._setStacked(false);
  assert.equal(byClass(p.container, 'cmp-state-btn').length, 0);
  assert.equal(byClass(p.container, 'cmp-traj-rows')[0].hidden, false);
});

test('the app bar: a companion whose answer asks reads Needs you, after a task that needs input and before a running session', async () => {
  const { globalTaskState, chipWords } = await import('../client/components/status-words.js');
  assert.deepEqual(globalTaskState([], 0, 1), { state: 'needs-you', count: 1, sessions: 0 });
  assert.deepEqual(globalTaskState([], 2, 1).state, 'needs-you');
  assert.deepEqual(globalTaskState([{ status: 'needs-input' }], 0, 1).state, 'needs-input');
  assert.deepEqual(globalTaskState([], 1, 0).state, 'working', 'a running companion session counts as working like a Chat session');
  assert.deepEqual(chipWords('needs-you', 1, null, 'Harbor', (x) => x), { visible: 'Harbor: needs you', said: 'Status in Harbor: the companion asks you a question' });
  assert.equal(words.sessionAsks({ status: 'idle', asks: true }), true);
  assert.equal(words.sessionAsks({ status: 'running', asks: true }), false);
});

// ---------- the Learning view mounts this same panel (t_3b4zpsazku, decision row 138) ----------
test('leaving the dock for the Learning view and back keeps the box, the selected pins, the attachments and a running answer', async () => {
  const p = await mount({ session: DONE, pins: PINS });
  p.box().value = 'my half-typed question';
  find(p.container, (n) => n.tag === 'button' && n.dataset.pin === 'pin_a')[0].fire('click');
  _state().attachments = [{ path: '.studio/attachments/x.png', name: 'x.png', bytes: 3 }];
  p.emit('console', { name: 'console.started', data: { sessionId: 'cs_one', runId: 'cr_3' } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_one', kind: 'text', text: 'Half an ' } });
  panel.unmount(); // the route leaves the Workbench: its dock unmounts the panel
  // While no panel is on screen the kept run still takes its chunks; another session's do not count.
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_one', kind: 'text', text: 'answer' } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_one', kind: 'tool', id: 'tu_7', name: 'Read', summary: 'src/login.js', ms: 900 } });
  p.emit('console', { name: 'console.chunk', data: { sessionId: 'cs_other', kind: 'tool', id: 'tu_x', name: 'Write', summary: 'elsewhere.js', ms: 5 } });
  assert.equal(panel._kept('p_1').draft, 'my half-typed question');
  const again = await mount({ session: { ...DONE, status: 'running', turns: [...DONE.turns, { role: 'user', text: 'Teach me the login', at: new Date().toISOString() }] }, pins: PINS });
  assert.equal(again.box().value, 'my half-typed question', 'the same box');
  assert.equal(find(again.container, (n) => n.tag === 'button' && n.dataset.pin === 'pin_a')[0].attrs['aria-pressed'], 'true');
  assert.deepEqual(_state().attachments.map((a) => a.name), ['x.png']);
  assert.ok(find(again.container, (n) => n.tag === 'p' && n.kids[0] === 'Half an answer').length, 'the live answer carries on with what it had');
  const rows = find(byClass(again.container, 'cmp-traj-rows')[0], (n) => n.tag === 'div' && typeof n.kids[0] === 'string').map((n) => n.kids[0]);
  assert.deepEqual(rows, ['00:00 · Read · login.js']);
  assert.equal(panel._kept('p_1'), null, 'taken by the mount');
  assert.ok(!again.calls.some(([k]) => k === 'create'), 'nothing restarts: the stored session is read, never a new one');
});

test('insertDraft puts the quoted line after what is typed and focuses the box without sending; it says why when it cannot', async () => {
  assert.deepEqual(panel.insertDraft('x'), { ok: false, focused: false, reason: 'not_mounted' });
  const none = await mount({});
  assert.deepEqual(panel.insertDraft('x'), { ok: false, focused: false, reason: 'no_session' });
  panel.unmount();
  const p = await mount({ session: DONE });
  const line = 'About "the session cookie" in the lesson "Login and data storage": ';
  assert.deepEqual(panel.insertDraft(line), { ok: true, focused: true, reason: null });
  assert.equal(p.box().value, line);
  assert.equal(document.activeElement, p.box());
  p.box().value = 'First my own words  ';
  panel.insertDraft(line);
  assert.equal(p.box().value, `First my own words\n${line}`, 'after the words typed, on its own line');
  assert.ok(!p.calls.some(([k]) => k === 'send'), 'never sent');
  p.emit('console', { name: 'console.started', data: { sessionId: 'cs_one', runId: 'cr_4' } });
  assert.deepEqual(panel.insertDraft('more'), { ok: true, focused: false, reason: 'running' }, 'the box waits disabled during an answer; the line stays in it');
  assert.match(p.box().value, /more$/);
  void none;
});
