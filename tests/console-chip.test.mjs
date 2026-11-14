// The real client/views/console.js with a stubbed DOM: the chip in the session header follows the task.
// No browser is involved, so nothing here says how it looks.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

function el(spec, props, ...children) {
  if (props !== null && props !== undefined && (typeof props !== 'object' || props.isNode || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const n = { isNode: true, spec, kids: [], dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, addEventListener() {}, querySelector: () => null, contains: () => false, focus() {}, append(...more) { n.kids.push(...more.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)); } };
  for (const [k, v] of Object.entries(props || {})) n[k] = v;
  n.append(...children);
  return n;
}
const stub = () => el('span');
const clear = (n, ...kids) => { n.kids = []; n.append(...kids); return n; };
globalThis.__console = {
  el, clear, button: (label) => el('button', label), select: stub, toast() {}, toastError() {}, confirmDialog() {}, textarea: stub, empty: stub, loading: stub, errorBox: stub, ago: () => 'now',
  segmented: () => ({ node: el('div'), set() {} }), chip: (state) => el('span.chip', state), stateChip: (label) => el('span.chip', label), shortLabel: (x) => x,
  BACKENDS: {}, backendLabel: (x) => x, renderTurn: stub, orderedItems: () => [], liveTurn: () => ({ node: el('div'), body: el('div') }),
  newSessionDialog() {}, CONTEXTS: [], mountTerminalMode() {}, unmountTerminalMode() {}, terminalScope: () => 'project', setTerminalScope() {}, isAnswer: () => true,
};
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, x) => store.set(k, x), removeItem: (k) => store.delete(k) };
globalThis.document = { activeElement: null };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => {};

const source = (await fsp.readFile(new URL('../client/views/console.js', import.meta.url), 'utf8'))
  .replace("'../components/status-words.js'", JSON.stringify(new URL('../client/components/status-words.js', import.meta.url).href))
  .replace(/import \{([^}]*)\} from '\.\.?\/[^']*(ui|transcript|console-new|terminal|is-answer)\.js';/g, 'const {$1} = globalThis.__console;');
const { mount, unmount } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const walk = (n, out = []) => { if (n?.isNode) { out.push(n); n.kids.forEach((k) => walk(k, out)); } return out; };
const text = (n) => (n?.isNode ? n.kids.map(text).join('') : String(n ?? ''));

/** The Claude Code view on a session; `task` is what the server answers now, `reads` counts the asks. */
async function open(session) {
  const topics = new Map();
  const world = { task: { id: 't_1', status: 'ready', result: null }, reads: 0, failing: false, session };
  const app = {
    state: { projects: [], studio: null },
    projectId: () => 'p',
    on: (topic, fn) => { topics.set(topic, fn); return () => topics.delete(topic); },
    api: {
      consoleBackends: async () => ({ backends: [] }),
      consoleSessions: async () => ({ sessions: [] }),
      consoleGet: async () => ({ session: world.session }),
      task: async () => {
        world.reads++;
        if (world.failing) throw new Error('gone');
        return { task: world.task };
      },
    },
  };
  store.set('atelier.consoleSession', session.id);
  const host = el('div');
  mount(host, app);
  await tick();
  const chips = () => walk(walk(host).find((n) => n.spec === 'header.cc-head')).filter((n) => n.spec === 'span.chip').map(text);
  const fire = async (topic, data) => { topics.get(topic)(data); await tick(); };
  return { world, chips, fire };
}
const bound = { id: 's_1', projectId: 'p', backend: 'claude-code', status: 'idle', taskId: 't_1', turns: [] };

afterEach(() => { unmount(); store.clear(); });

test('the chip follows the task on task.changed, for this task or an event naming none', async () => {
  const { world, chips, fire } = await open(bound);
  assert.deepEqual(chips(), ['ready']);
  world.task = { ...world.task, status: 'working' };
  await fire('task.changed', { projectId: 'p', taskId: 't_1' });
  assert.deepEqual(chips(), ['working']);
  world.task = { ...world.task, status: 'review', result: { versionId: 'v' } };
  await fire('task.changed', { projectId: 'p' });
  assert.deepEqual(chips(), ['review']);
});

test('another task\'s change does not read this one', async () => {
  const { world, fire } = await open(bound);
  const before = world.reads;
  await fire('task.changed', { projectId: 'p', taskId: 't_other' });
  assert.equal(world.reads, before);
});

test('a running session says Working over the task, and hands back when its turn ends', async () => {
  const { world, chips, fire } = await open(bound);
  world.task = { ...world.task, status: 'review', result: { versionId: 'v' } };
  await fire('console', { name: 'console.started', data: { sessionId: 's_1', runId: 'r' } });
  assert.deepEqual(chips(), ['working']);
  await fire('console', { name: 'console.done', data: { sessionId: 's_1', runId: 'r' } });
  assert.deepEqual(chips(), ['review']);
});

test('a session with no task has a chip only while running; a task that cannot be read shows none', async () => {
  const plain = await open({ ...bound, taskId: undefined });
  assert.deepEqual(plain.chips(), []);
  assert.equal(plain.world.reads, 0);
  await plain.fire('console', { name: 'console.started', data: { sessionId: 's_1', runId: 'r' } });
  assert.deepEqual(plain.chips(), ['working']);
  unmount();

  const lost = await open(bound);
  assert.deepEqual(lost.chips(), ['ready']);
  lost.world.failing = true;
  await lost.fire('task.changed', { projectId: 'p', taskId: 't_1' });
  assert.deepEqual(lost.chips(), [], 'an old state would be a false one');
});
