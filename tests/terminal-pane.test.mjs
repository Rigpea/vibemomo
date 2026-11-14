// Terminal panes on a stub DOM (client/components/terminal.js, workbenches/terminal/panel.js), with a stub app.api,
// a stub EventSource and a stub xterm. Risks covered: two panes open at once share nothing but the shell (separate
// state, both streams, both type, each says the other is open); the dock's pane lists only its project's shells and
// counts the running ones; Open terminal opens in the project; a closed shell leaves the list; destroy closes the
// stream; the Claude Code view's wrapper keeps one pane; a vendor failure in the dock is one line with Retry.
// The server side is tests/terminal.test.mjs; a real shell in the dock is scripts/ui-check/verify-terminal.cjs's.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

// ---------- stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, hidden: false, disabled: false, value: '', title: '' });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
    this._text = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  fire(type, e = {}) { const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...e }; for (const fn of this.listeners[type] || []) fn(ev); return ev; }
  replaceChildren(...k) { this._text = null; this.kids = flatten(k); }
  focus() { globalThis.document.activeElement = this; }
  get textContent() { return this._text ?? this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.kids = []; }
}
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
globalThis.__ui = {
  el,
  clear: (node, ...children) => { node._text = null; node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c))); return node; },
  button: (text, { onclick, disabled, title, type = 'button', variant, small, icon, ...rest } = {}) => el('button', { type, onclick, disabled, title, ...rest }, text),
  select: (options, value, props = {}) => el('select', { ...props, value }),
  stateChip: (text) => el('span.chip', text),
  toast: (m) => toasts.push(m),
  toastError: (err, what) => toasts.push(`${what}: ${err.message}`),
  dialog: () => {},
  field: (label, ctl) => el('div.field', label, ctl),
  input: (props) => el('input', props),
  empty: (sentence, more, action) => el('div.empty', sentence, more, action),
  loading: (t = 'Loading…') => el('div.loading', t),
  errorBox: (err, retry) => el('div.empty.error', `Could not load this: ${err.message}`, retry ? el('button', { onclick: retry }, 'Retry') : null),
  shortLabel: (s) => String(s),
};
const all = (n) => (n instanceof N ? [n, ...n.kids.flatMap(all)] : []);
const find = (root, pred) => all(root).filter(pred);
const byClass = (root, c) => find(root, (n) => n.classes.has(c));
const buttonNamed = (root, text) => find(root, (n) => n.tag === 'button' && n.kids[0] === text)[0];

// ---------- stub browser ----------
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const headAdds = [];
globalThis.document = {
  activeElement: null,
  querySelector: () => null,
  head: { append(node) { headAdds.push(node); if (node.tag === 'script') setImmediate(() => node.fire(globalThis.__scriptFails ? 'error' : 'load')); } },
  documentElement: { dataset: {} },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.requestAnimationFrame = (f) => setImmediate(f);
class XT {
  constructor(opts) { this.options = { ...opts }; this.cols = 80; this.rows = 24; this.out = ''; this.disposed = false; }
  loadAddon() {} open() {} focus() {} reset() { this.out = ''; }
  write(d, cb) { this.out += d; cb?.(); }
  onData(f) { this.dataFn = f; } onResize(f) { this.resizeFn = f; }
  dispose() { this.disposed = true; }
}
const xtermStubs = { Terminal: XT, FitAddon: { FitAddon: class { fit() {} } } };
globalThis.window = { ...xtermStubs };
class ES {
  static CLOSED = 2;
  static all = [];
  constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; this.closed = false; ES.all.push(this); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  emit(type, data) { if (type === 'message') this.onmessage?.({ data: JSON.stringify(data) }); else for (const f of this.listeners[type] || []) f({ data: JSON.stringify(data) }); }
  close() { this.closed = true; this.readyState = 2; }
}
globalThis.EventSource = ES;
const net = [];
globalThis.fetch = async (url, opts = {}) => { net.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined }); return { ok: true, status: 200, json: async () => ({}) }; };

// ---------- the modules, with their imports pointed at the stubs ----------
const termSrc = (await fsp.readFile(new URL('../client/components/terminal.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/terminal-launch\.js';/, 'const {$1} = globalThis.__launch;');
const launchSrc = (await fsp.readFile(new URL('../client/components/terminal-launch.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;');
globalThis.__launch = await import(`data:text/javascript,${encodeURIComponent(launchSrc)}`);
const load = (tag) => import(`data:text/javascript,${encodeURIComponent(`${termSrc}\n// ${tag}`)}`);
const term = await load('main');
globalThis.__terminal = term;
const panelSrc = (await fsp.readFile(new URL('../workbenches/terminal/panel.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\/components\/terminal\.js';/, 'const {$1} = globalThis.__terminal;');
const panel = await import(`data:text/javascript,${encodeURIComponent(panelSrc)}`);

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

// ---------- a stub app with a server list ----------
function stubApp(list) {
  const listeners = {};
  const calls = [];
  const server = { list: list.map((t) => ({ ...t })) };
  const app = {
    calls, server, listeners,
    state: { projects: [{ id: 'p_1', name: 'Room One', kind: 'game' }, { id: 'p_2', name: 'Harbor', kind: 'web-app' }, { id: 'p_s', name: 'Atelier', kind: 'studio' }], bundle: { project: { id: 'p_1' }, tasks: [] }, settings: {}, studio: { dir: 'C:\\atelier' } },
    projectId: () => 'p_1',
    on(name, fn) { (listeners[name] ||= new Set()).add(fn); return () => listeners[name].delete(fn); },
    api: {
      terminals: async () => { calls.push(['list']); return server.list.map((t) => ({ ...t })); },
      terminalOpen: async (b) => {
        calls.push(['open', b]);
        const t = { id: `term_${server.list.length + 1}`, projectId: b.projectId, cwd: `C:\\Projects\\${b.projectId}`, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', pid: 4000 + server.list.length, createdAt: `2026-11-07T02:0${server.list.length}:00Z`, exited: false };
        server.list.push(t);
        return { ...t };
      },
      terminalClose: async (id) => { calls.push(['close', id]); server.list = server.list.filter((t) => t.id !== id); return { ok: true }; },
    },
  };
  return app;
}
const listenerCount = (app) => Object.values(app.listeners).reduce((n, s) => n + s.size, 0);
const T = (id, projectId, at, more = {}) => ({ id, projectId, cwd: projectId ? `C:\\Projects\\${projectId}` : 'C:\\atelier', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', pid: 100 + Number(id.slice(-1)), createdAt: `2026-11-07T01:0${at}:00Z`, exited: false, ...more });
const tabNames = (host) => byClass(host, 'term-tab-main').map((b) => b.kids[0].kids[0]);

beforeEach(() => { store.clear(); ES.all.length = 0; net.length = 0; toasts.length = 0; globalThis.__scriptFails = false; Object.assign(globalThis.window, xtermStubs); });

test('two panes at once keep their own state; on one shell both stream, both type, and each names the other', async () => {
  const app = stubApp([T('term_1', null, 1), T('term_2', 'p_1', 2), T('term_3', 'p_2', 3)]);
  const viewHost = el('div'); const dockHost = el('div');
  const view = term.createTerminalPane(viewHost, app, { scope: 'all', place: 'view' });
  const dock = term.createTerminalPane(dockHost, app, { scope: 'project', fixedScope: true, projectId: 'p_1', place: 'dock' });
  await flush();
  assert.notEqual(view._state(), dock._state());
  assert.deepEqual(tabNames(viewHost), ['1 · Studio', '2 · Room One', '3 · Harbor']);
  assert.deepEqual(tabNames(dockHost), ['1 · Room One'], 'the dock lists its project only');
  assert.equal(view._state().attachedId, 'term_1');
  assert.equal(dock._state().attachedId, 'term_2');
  assert.doesNotMatch(byClass(dockHost, 'term-facts')[0].textContent, /also open/);

  // The view switches to the dock's shell: two streams on it, and each facts line names the other pane.
  find(viewHost, (n) => n.dataset.termId === 'term_2')[0].fire('click');
  const streams = ES.all.filter((e) => e.url === '/api/terminal/term_2/stream' && !e.closed);
  assert.equal(streams.length, 2);
  assert.match(byClass(viewHost, 'term-facts')[0].textContent, /also open in the dock; the pane resized last sets its size/);
  assert.match(byClass(dockHost, 'term-facts')[0].textContent, /pid 102 .*also open in the Claude Code view/);
  for (const es of streams) es.emit('message', { d: 'hello' });
  assert.equal(view._state().xt.out, 'hello');
  assert.equal(dock._state().xt.out, 'hello');
  view._state().xt.dataFn('a'); dock._state().xt.dataFn('b');
  await flush();
  assert.deepEqual(net.filter((c) => c.url.endsWith('/input')).map((c) => [c.url, c.body.data]), [['/api/terminal/term_2/input', 'a'], ['/api/terminal/term_2/input', 'b']]);
  // Each attach sends its size, so the pane that attached (or resized) last is the one the shell follows.
  assert.equal(net.filter((c) => c.url === '/api/terminal/term_2/resize').length, 2);

  view.destroy();
  assert.doesNotMatch(byClass(dockHost, 'term-facts')[0].textContent, /also open/, 'the other pane forgets it once it closes');
  dock.destroy();
});

test('watchCount: the running shells of the project reach the tab before the panel mounts, follow terminal events, and stop', async () => {
  const app = stubApp([T('term_1', 'p_1', 1), T('term_2', 'p_2', 2), T('term_4', 'p_1', 4, { exited: true, exitCode: 0 })]);
  const counts = [];
  const stop = panel.watchCount({ projectId: 'p_1', app, api: app.api, setCount: (n) => counts.push(n) });
  await flush();
  assert.deepEqual(counts, [1], 'one running shell of p_1; the exited one and p_2\'s do not count');
  app.server.list.push(T('term_6', 'p_1', 6));
  for (const fn of app.listeners.terminal || []) fn({});
  await flush();
  assert.deepEqual(counts, [1, 2]);
  stop();
  for (const fn of app.listeners.terminal || []) fn({});
  await flush();
  assert.deepEqual(counts, [1, 2], 'stopped: no more reads');
  assert.equal(listenerCount(app), 0);
  assert.equal(panel._state(), null, 'nothing mounted by watching');
});

test('the dock panel lists only its project, counts the running shells, opens in the project and drops a closed one', async () => {
  const app = stubApp([T('term_1', 'p_1', 1), T('term_2', 'p_2', 2), T('term_4', 'p_1', 4, { exited: true, exitCode: 0 }), T('term_5', null, 5)]);
  const container = el('div');
  const ctx = { projectId: 'p_1', app, setCount(n) { ctx.count = n; } };
  panel.mount(container, ctx);
  await flush();
  assert.ok(container.classes.has('terminal-host'));
  assert.deepEqual(tabNames(container), ['1 · Room One', '2 · Room One']);
  assert.equal(ctx.count, 1, 'an exited shell is not an open terminal');
  assert.equal(buttonNamed(container, 'New terminal'), undefined);
  assert.equal(find(container, (n) => n.tag === 'select' && n.classes.has('term-folder')).length, 0, 'no folder choice: the project is the folder');

  buttonNamed(container, 'Open terminal').fire('click');
  await flush();
  assert.deepEqual(app.calls.find((c) => c[0] === 'open')[1], { projectId: 'p_1', cols: 80, rows: 24 });
  assert.equal(ctx.count, 2);
  assert.equal(panel._state().pane._state().attachedId, 'term_5');
  assert.match(byClass(container, 'term-facts')[0].textContent, /C:\\Projects\\p_1 · powershell · pid/);

  // The exited shell's tab closes from the tabs row; a running one's Close ends it.
  const closeOf = (id) => find(container, (n) => n.classes.has('term-tab') && n.kids[0].dataset.termId === id)[0].kids[1];
  assert.equal(closeOf('term_4').title, 'Close this tab');
  closeOf('term_4').fire('click');
  await flush();
  assert.deepEqual(app.calls.filter((c) => c[0] === 'close'), [['close', 'term_4']]);
  assert.deepEqual(tabNames(container), ['1 · Room One', '2 · Room One']);
  closeOf('term_5').fire('click');
  await flush();
  assert.ok(ES.all.find((e) => e.url === '/api/terminal/term_5/stream').closed, 'the stream stops before the shell is closed');
  assert.deepEqual(tabNames(container), ['1 · Room One']);
  assert.equal(ctx.count, 1);

  panel.unmount();
  assert.equal(container.kids.length, 0);
  assert.equal(listenerCount(app), 0);
});

test('an exited shell is said in the pane as the Claude Code view says it, and a closed project shows no count', async () => {
  const app = stubApp([T('term_1', 'p_1', 1)]);
  const container = el('div');
  const ctx = { projectId: 'p_1', app, setCount(n) { ctx.count = n; } };
  panel.mount(container, ctx);
  await flush();
  const es = ES.all.find((e) => e.url === '/api/terminal/term_1/stream');
  es.emit('exit', { code: 3 });
  assert.match(byClass(container, 'term-exited')[0].textContent, /Exited with code 3/);
  assert.ok(buttonNamed(container, 'Open terminal here'));
  assert.match(byClass(container, 'term-facts')[0].textContent, /exited; the output stays readable/);
  assert.equal(ctx.count, 0, 'zero: the dock shows no number');
  panel.unmount();
});

test('destroy closes the stream, removes the listeners and empties the host', async () => {
  const app = stubApp([T('term_1', 'p_1', 1)]);
  const host = el('div');
  const pane = term.createTerminalPane(host, app, { fixedScope: true, projectId: 'p_1', place: 'dock' });
  await flush();
  const es = ES.all.at(-1);
  assert.equal(es.closed, false);
  const xt = pane._state().xt;
  pane.destroy();
  assert.equal(es.closed, true);
  assert.equal(xt.disposed, true);
  assert.equal(host.kids.length, 0);
  assert.equal(listenerCount(app), 0);
  pane.destroy(); // twice is harmless
});

test('the Claude Code view\'s wrapper mounts one pane, keeps its scope in sessionStorage and unmounts it', async () => {
  const app = stubApp([T('term_1', null, 1), T('term_2', 'p_1', 2)]);
  const host = el('div');
  term.mountTerminalMode(host, app, {});
  await flush();
  assert.equal(term.terminalScope(), 'project');
  assert.deepEqual(tabNames(host), ['1 · Room One']);
  assert.ok(buttonNamed(host, 'New terminal'), 'the view keeps its words');
  assert.equal(find(host, (n) => n.tag === 'select' && n.classes.has('term-folder')).length, 1);
  term.setTerminalScope('studio');
  await flush();
  assert.equal(store.get('atelier.terminalScope'), 'studio');
  assert.deepEqual(tabNames(host), ['1 · Studio']);
  term.mountTerminalMode(host, app, {}); // a second mount replaces the first
  await flush();
  assert.equal(ES.all.filter((e) => !e.closed).length, 1, 'one pane, one stream');
  term.unmountTerminalMode();
  assert.equal(ES.all.filter((e) => !e.closed).length, 0);
  assert.equal(listenerCount(app), 0);
  term.unmountTerminalMode(); // nothing mounted: no throw
});

test('a vendor load failure in the dock is one plain line with Retry, and Retry loads it', async () => {
  const fresh = await load('vendor'); // its own vendor cache, not yet loaded
  delete globalThis.window.Terminal;
  delete globalThis.window.FitAddon;
  globalThis.__scriptFails = true;
  const app = stubApp([T('term_1', 'p_1', 1)]);
  const host = el('div');
  const pane = fresh.createTerminalPane(host, app, { fixedScope: true, projectId: 'p_1', place: 'dock' });
  await flush();
  const line = byClass(host, 'term-vendor')[0];
  assert.match(line.textContent, /^The terminal could not load: Could not load \/vendor\/xterm\/xterm\.js \(is npm install done\?\)/);
  assert.equal(byClass(host, 'error').length, 0, 'no error box in the dock');
  globalThis.__scriptFails = false;
  Object.assign(globalThis.window, xtermStubs);
  buttonNamed(line, 'Retry').fire('click');
  await flush();
  assert.equal(pane._state().attachedId, 'term_1');
  pane.destroy();
});

test('sharedWords and openCount say only what is there', () => {
  assert.equal(term.sharedWords([]), '');
  assert.equal(term.sharedWords(['dock']), 'also open in the dock; the pane resized last sets its size');
  assert.equal(term.sharedWords(['view', 'view']), 'also open in the Claude Code view; the pane resized last sets its size');
  assert.equal(panel.openCount([{ exited: false }, { exited: true }, {}]), 2);
  assert.equal(panel.openCount(null), 0);
  assert.equal(term.composeClaude({ model: 'claude-opus-5-5', session: 'continue', dirs: 'a, C:\\My Dir', task: 't_1' }),
    'claude --model claude-opus-5-5 --continue --add-dir a "C:\\My Dir" "Work on studio task t_1: read .studio/tasks/t_1/brief.md and follow it"', 'still exported from terminal.js');
});
