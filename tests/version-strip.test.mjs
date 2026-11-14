// The version strip (client/components/version-strip.js): stripModel on its own, then the real DOM part on a stub
// DOM in the manner of the other panel tests. No browser is involved; scripts/ui-check/verify-version-strip.cjs looks
// at the real strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

// ---------- a stub DOM ----------
const flatten = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const doc = { activeElement: null };
globalThis.document = doc;
class N {
  constructor(spec) {
    const [tag, ...classes] = spec.split('.');
    Object.assign(this, { spec, tag: tag || 'div', attrs: {}, kids: [], listeners: {}, dataset: {}, style: {}, hidden: false, title: '', scrollLeft: 0, clientWidth: 200, scrollWidth: 200 });
    this.classes = new Set(classes);
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, e = {}) { const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...e }; for (const fn of this.listeners[type] || []) fn(ev); return ev; }
  all() { return [this, ...this.kids.filter((k) => k instanceof N).flatMap((k) => k.all())]; }
  contains(n) { return this.all().includes(n); }
  querySelector(sel) {
    const m = /^\[data-(vid|tid)="(.+)"\]$/.exec(sel);
    return m ? this.all().find((n) => n.dataset[m[1]] === m[2]) || null : null;
  }
  focus() { doc.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
}
function el(spec, props, ...children) {
  if (props === null || props === undefined || props instanceof N || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = null; }
  const node = new N(spec);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('aria') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.kids = flatten(children).map((c) => (c instanceof N ? c : String(c)));
  return node;
}
globalThis.__ui = { el, clear: (n, ...kids) => { n.kids = flatten(kids).map((c) => (c instanceof N ? c : String(c))); return n; }, ago: () => '2 h ago' };
globalThis.__va = { stateLabel: (id) => (id === 'selected' ? 'kept' : id) };
const source = (await fsp.readFile(new URL('../client/components/version-strip.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/version-actions\.js';/, 'const {$1} = globalThis.__va;');
const { stripModel, createVersionStrip, focusVersionRow, versionRowId, MARK_W, STUB_W } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const text = (n) => (n instanceof N ? (n.hidden ? '' : n.kids.map(text).join('')) : String(n ?? ''));
const bySpec = (root, prefix) => root.all().filter((n) => n.spec === prefix || n.spec.startsWith(`${prefix}.`));

// ---------- four versions, two tasks with versions or running, one with none ----------
const at = (h) => `2026-11-06T${String(h).padStart(2, '0')}:00:00.000Z`;
const VERSIONS = [
  { id: 'v3', n: 3, label: 'Third', state: 'experiment', createdAt: at(3), taskId: 't_a' },
  { id: 'v1', n: 1, label: 'First', state: 'selected', createdAt: at(1), userPreferred: true },
  { id: 'v4', n: 4, label: 'Fourth', state: 'released', createdAt: at(5) },
  { id: 'v2', n: 2, label: 'Second', state: 'experiment', createdAt: at(2) },
];
const TASKS = [
  { id: 't_a', title: 'Give the header room', status: 'review', result: { versionIds: ['v2'] } },
  { id: 't_b', title: 'Tune the jump', status: 'working', startedAt: at(4) },
  { id: 't_c', title: 'Not started', status: 'ready' },
];
const OPTS = { currentId: 'v3', viewingId: 'v2', dirty: true };

test('stripModel: marks in order with their flags and names; the dirty stub after the current mark', () => {
  const m = stripModel(VERSIONS, TASKS, OPTS);
  assert.deepEqual(m.marks.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(m.marks.map((x) => x.index), [0, 1, 2, 3]);
  assert.deepEqual(m.marks.filter((x) => x.current).map((x) => x.n), [3]);
  assert.deepEqual(m.marks.filter((x) => x.viewing).map((x) => x.n), [2]);
  assert.deepEqual(m.marks.filter((x) => x.released).map((x) => x.n), [4]);
  assert.deepEqual(m.marks.filter((x) => x.preferred).map((x) => x.n), [1]);
  assert.equal(m.marks[0].name, '#1 First · 2 h ago · kept');
  assert.deepEqual(m.stub, { after: 2, name: 'the files on disk · changed since #3' });
  assert.equal(stripModel(VERSIONS, TASKS, { ...OPTS, dirty: false }).stub, null);
  assert.equal(stripModel(VERSIONS, TASKS, { dirty: true }).stub, null, 'no current version: nothing to be changed since');
  assert.equal(stripModel(VERSIONS, TASKS, { currentId: 'v3' }).marks.some((x) => x.viewing), false, 'the head preview rings nothing');
});

test('stripModel: bars span their versions, a running task reaches the end live, a task with no version has none', () => {
  const m = stripModel(VERSIONS, TASKS, OPTS);
  const a = m.bars.find((b) => b.taskId === 't_a');
  assert.deepEqual([a.from, a.to, a.live, a.name], [1, 2, false, 'Give the header room'], 'result.versionIds and the versions\' taskId together: #2 to #3');
  const b = m.bars.find((x) => x.taskId === 't_b');
  assert.deepEqual([b.from, b.to, b.live, b.toEdge], [2, 3, true, true], 'from #3, the last version before its start, to the end');
  assert.equal(m.bars.some((x) => x.taskId === 't_c'), false);
  assert.deepEqual([a.lane, b.lane], [0, 1], 'the two share #3, so they stack');
  assert.equal(m.lanes, 2);
  assert.equal(m.more, 0);
  // A running task with no start time starts at the current version; a task waiting on a question runs too.
  const asks = stripModel(VERSIONS, [{ id: 't_q', title: 'Q', status: 'needs-input' }], { currentId: 'v2' }).bars[0];
  assert.deepEqual([asks.from, asks.to, asks.live], [1, 3, true]);
  // Done and cancelled tasks with no version are not drawn; a version that is gone is not a span.
  assert.deepEqual(stripModel(VERSIONS, [{ id: 't_x', title: 'X', status: 'done', result: { versionIds: ['v_gone'] } }], {}).bars, []);
  assert.deepEqual(stripModel([], TASKS, {}).bars, [], 'no versions, no bars, even for a running task');
});

test('stripModel: at most three lanes, the rest is +n more', () => {
  const tasks = [
    { id: 't_1', title: 'one', status: 'done', result: { versionIds: ['v1', 'v4'] } },
    { id: 't_2', title: 'two', status: 'done', result: { versionIds: ['v2', 'v3'] } },
    { id: 't_3', title: 'three', status: 'done', result: { versionIds: ['v2', 'v3'] } },
    { id: 't_4', title: 'four', status: 'done', result: { versionIds: ['v3'] } },
    { id: 't_5', title: 'five', status: 'done', result: { versionId: 'v3' } },
    { id: 't_6', title: 'six', status: 'done', result: { versionIds: ['v1'] } },
  ];
  const m = stripModel(VERSIONS, tasks, {});
  assert.equal(m.lanes, 3);
  assert.deepEqual(m.bars.map((b) => [b.taskId, b.lane]), [['t_1', 0], ['t_6', 1], ['t_2', 1], ['t_3', 2]]);
  assert.equal(m.more, 2, 't_4 and t_5 find no lane');
});

// ---------- the DOM ----------
function studio() {
  const calls = [];
  const row = el('tr', { id: versionRowId('v1') });
  const rows = { [versionRowId('v1')]: row };
  const page = { getElementById: (id) => rows[id] || null };
  const app = {
    toggleVersions: (open, opts) => { calls.push(['toggleVersions', open, opts]); return Promise.resolve().then(() => focusVersionRow(page, opts?.versionId)); },
    showPanel: (tab, opts) => calls.push(['showPanel', tab, opts]),
  };
  const strip = createVersionStrip(app);
  const bundle = { project: { id: 'p' }, versions: VERSIONS, tasks: TASKS, changes: { sinceVersionId: 'v3', dirty: true } };
  strip.update(bundle, { viewingId: 'v2' });
  return { strip, app, calls, row, bundle };
}
const marks = (strip) => bySpec(strip.node, 'button.vmark');

test('the DOM: numbered marks in order with their classes, names, positions and the stub', () => {
  const { strip } = studio();
  const ms = marks(strip);
  assert.deepEqual(ms.map(text), ['1', '2', '3', '4']);
  assert.deepEqual(ms.map((n) => n.style.left), [0, 1, 2, 3].map((i) => `${i * MARK_W + (i > 2 ? STUB_W : 0)}px`), 'the stub after #3 pushes #4 right');
  assert.ok(ms[2].classes.has('current') && ms[1].classes.has('viewing') && ms[3].classes.has('released') && ms[0].classes.has('preferred'));
  assert.equal(ms[2].getAttribute('aria-current'), 'true');
  assert.equal(ms[0].getAttribute('aria-label'), ms[0].title);
  assert.deepEqual(ms.map((n) => n.tabIndex), [-1, -1, 0, -1], 'one tab stop: the current mark');
  const stub = bySpec(strip.node, 'span.vstub')[0];
  assert.equal(stub.title, 'the files on disk · changed since #3');
  const bars = bySpec(strip.node, 'button.vbar');
  assert.deepEqual(bars.map((b) => b.title), ['Give the header room', 'Tune the jump']);
  assert.equal(bySpec(bars[1], 'span.live-dot').length, 1, 'the running bar has the live dot');
  assert.equal(bars[1].style.width, `${4 * MARK_W + STUB_W - (2 * MARK_W + 2)}px`, 'to the right edge');
  assert.ok(strip.node.classes.has('has-lanes'));
});

test('a tap on a mark opens the drawer at its row; a tap on a bar opens the Task tab at its task', async () => {
  const { strip, calls, row } = studio();
  marks(strip)[0].fire('click');
  assert.deepEqual(calls[0], ['toggleVersions', true, { versionId: 'v1' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.activeElement, row, 'row #1 has the focus');
  assert.ok(row.scrolled, 'and was scrolled into view');
  bySpec(strip.node, 'button.vbar')[0].fire('click');
  assert.deepEqual(calls[1], ['showPanel', 'task', { taskId: 't_a' }]);
  // A press that dragged the strip opens nothing.
  const scroller = bySpec(strip.node, 'div.vstrip-scroll')[0];
  scroller.scrollLeft = 0;
  scroller.fire('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  scroller.fire('pointermove', { clientX: 60 });
  scroller.fire('pointerup');
  assert.equal(scroller.scrollLeft, 40, 'dragged 40 px to the left scrolls 40 px on');
  let stopped = false;
  scroller.fire('click', { target: marks(strip)[1], stopPropagation: () => { stopped = true; } });
  assert.ok(stopped, 'the click that ends a drag stops before the mark');
  stopped = false;
  scroller.fire('click', { target: marks(strip)[1], stopPropagation: () => { stopped = true; } });
  assert.ok(!stopped, 'the next click goes through');
  assert.equal(calls.length, 2);
});

// ---------- Working now (client/components/run-words.js, working-now.js) ----------
const NOW = Date.parse('2026-11-07T10:00:00.000Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const RUNS = [
  { id: 'term_1', kind: 'terminal', projectId: 'p', name: 'pwsh', state: 'Working', reason: null, startedAt: min(20), endedAt: null, latest: 'open 20 min', latestAt: min(0), waitsFor: null },
  { id: 'cr_1', kind: 'session', projectId: 'p', name: 'Give the header room', state: 'Working', reason: null, startedAt: min(90), endedAt: null, latest: 'Read copy.mjs', latestAt: min(2), waitsFor: null },
  { id: 'b_1', kind: 'build', projectId: 'p', name: 'Build and install', state: 'Failed', reason: 'Step 2 (gradlew) exited with 1', startedAt: min(40), endedAt: min(30), latest: '2 of 3 · gradlew', latestAt: min(35), waitsFor: null },
  { id: 'cr_0', kind: 'session', projectId: 'p', name: 'Old question', state: 'Waiting for you', reason: 'Shall I?', startedAt: min(130), endedAt: min(120), latest: null, latestAt: null, waitsFor: 'you' },
];
const rw = await import('../client/components/run-words.js');

test('workingNowModel: collapsed it counts and names the running runs; open, it adds what ended in the hour, on the axis', () => {
  const closed = rw.workingNowModel(RUNS, { now: NOW });
  assert.equal(closed.count, 2);
  assert.deepEqual(closed.running.map((r) => r.name), ['Give the header room', 'pwsh'], 'oldest first');
  assert.deepEqual(closed.rows.map((r) => r.id), ['cr_1', 'term_1'], 'collapsed: the running rows only, oldest first');
  const open = rw.workingNowModel(RUNS, { now: NOW, open: true });
  assert.deepEqual(open.rows.map((r) => r.id), ['cr_1', 'b_1', 'term_1'], 'open: the build that failed 30 min ago too; the run that ended 2 h ago is gone');
  const [session, build, shell] = open.rows;
  assert.deepEqual([session.left, session.width, session.live, session.clipped], [0, 1, true, true], 'started before the hour: from the left edge to now');
  assert.equal(shell.clipped, false);
  assert.ok(Math.abs(shell.left - 40 / 60) < 1e-9 && Math.abs(shell.width - 20 / 60) < 1e-9, 'the shell: 20 min up to now');
  assert.ok(Math.abs(build.left - 20 / 60) < 1e-9 && Math.abs(build.width - 10 / 60) < 1e-9, 'the build: its 10 min, 30 min ago');
  assert.deepEqual([build.live, build.stateWords, build.latest], [false, 'Failed · Step 2 (gradlew) exited with 1', '2 of 3 · gradlew · 35 min ago']);
  assert.equal(session.latest, 'Read copy.mjs · 2 min ago');
  assert.deepEqual(open.ticks.map((t) => t.label), ['60 min ago', '45 min ago', '30 min ago', '15 min ago', 'now']);
  assert.deepEqual([open.ticks[0].at, open.ticks[4].at], [0, 1]);
  // Closing the rows lets what ended go: reopened later, only what ended after the close is listed.
  assert.deepEqual(rw.workingNowModel(RUNS, { now: NOW, open: true, dismissedAt: Date.parse(min(1)) }).rows.map((r) => r.id), ['cr_1', 'term_1']);
  // A run of a few seconds still shows as a sliver.
  const short = rw.workingNowModel([{ ...RUNS[0], startedAt: new Date(NOW - 1000).toISOString() }], { now: NOW }).rows[0];
  assert.equal(short.width, rw.MIN_BAR);
});

test('workingNowModel: absent when nothing runs, even with a run that ended in the hour, until the rows are open', () => {
  const ended = RUNS.filter((r) => r.endedAt);
  assert.equal(rw.workingNowModel([], { now: NOW }), null);
  assert.equal(rw.workingNowModel(ended, { now: NOW }), null, 'collapsed, nothing running: no row');
  assert.equal(rw.workingNowModel(ended, { now: NOW, open: true }).count, 0, 'open, the failed build stays in the list');
  assert.equal(rw.workingNowModel(ended, { now: NOW, open: true }).ended, 1, 'and is counted as ended');
  assert.equal(rw.workingNowModel(RUNS, { now: NOW }).ended, 0, 'collapsed: no ended row is listed');
  assert.equal(rw.workingNowModel([RUNS[3]], { now: NOW, open: true }), null, 'ended over an hour ago: gone');
  assert.equal(rw.runStateWords({ state: 'Working', waitsFor: 'the emulator' }), 'Waiting for the emulator');
  assert.equal(rw.runStateWords({ state: 'Waiting for you', reason: 'Shall I?', waitsFor: 'you' }), 'Waiting for you · Shall I?');
  assert.equal(rw.latestWords({ startedAt: new Date(NOW - 5000).toISOString() }, NOW), 'started just now');
});

const wnSource = (await fsp.readFile(new URL('../client/components/working-now.js', import.meta.url), 'utf8'))
  .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
  .replace(/import \{([^}]*)\} from '\.\/run-words\.js';/, 'const {$1} = globalThis.__rw;');
globalThis.__rw = rw;
const { createWorkingNow } = await import(`data:text/javascript,${encodeURIComponent(wnSource)}`);

test('the Working now DOM: a section that says nothing runs, then numbered rows with bars, states and latest actions', () => {
  let clock = NOW;
  const timers = [];
  const wn = createWorkingNow({ now: () => clock, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; } });
  wn.update([], 'p', { name: 'Harbor', note: 'No run since the studio started' });
  assert.equal(wn.node.hidden, false, 'the section itself never hides; the Workbench hides it unless runsShown (workbench-runs.test.mjs)');
  assert.ok(wn.node.classes.has('empty'));
  assert.equal(text(bySpec(wn.node, 'span.wn-title')[0]), 'Harbor / no run');
  assert.equal(text(bySpec(wn.node, 'span.wn-count')[0]), 'nothing running');
  assert.equal(text(bySpec(wn.node, 'p.wn-foot')[0]), 'No run since the studio started');
  assert.equal(timers.length, 0, 'no clock with nothing to move');
  wn.update([...RUNS, { ...RUNS[0], id: 'term_x', projectId: 'other' }], 'p', { name: 'Harbor' });
  assert.equal(wn.node.classes.has('empty'), false);
  assert.equal(text(bySpec(wn.node, 'span.wn-title')[0]), 'Harbor / current run');
  assert.equal(text(bySpec(wn.node, 'span.wn-count')[0]), '2 working, 1 ended this hour');
  const rows = bySpec(wn.node, 'li.wn-row');
  assert.deepEqual(rows.map((r) => r.dataset.run), ['cr_1', 'b_1', 'term_1'], 'oldest first, this project only, the ended build among them');
  assert.deepEqual(rows.map((r) => text(bySpec(r, 'span.wn-num')[0])), ['01', '02', '03']);
  assert.equal(text(bySpec(rows[0], 'span.wn-name')[0]), 'Give the header room');
  assert.equal(bySpec(rows[0], 'span.wn-dot').length, 1, 'a live dot on a working run');
  assert.equal(bySpec(rows[1], 'span.wn-dot').length, 0);
  assert.deepEqual([text(bySpec(rows[1], 'span.wn-state')[0]), text(bySpec(rows[1], 'span.wn-act')[0])], ['Failed · Step 2 (gradlew) exited with 1', '2 of 3 · gradlew · 35 min ago'], 'the state over the latest action');
  const bar = bySpec(rows[2], 'span.wn-bar')[0];
  assert.deepEqual([bar.style.left, bar.style.width], ['66.67%', '33.33%']);
  assert.ok(bar.classes.has('live'), 'a running bar is the live one');
  assert.equal(bySpec(bySpec(rows[1], 'span.wn-bar')[0], 'span.live-dot').length, 0);
  assert.equal(bySpec(wn.node, 'span.wn-tick').length, 5, 'the axis is the only clock');
  assert.equal(timers.length, 1, 'a clock moves the bars while a row is on screen');
  assert.equal(text(bySpec(wn.node, 'p.wn-foot')[0]), 'Give the header room, pwsh are working; the bars cover the last hour.');
  // Only ended runs: listed for the hour, counted as ended, nothing working.
  clock += 1000;
  wn.update(RUNS.filter((r) => r.endedAt), 'p', { name: 'Harbor' });
  assert.equal(text(bySpec(wn.node, 'span.wn-count')[0]), 'nothing working, 1 ended this hour');
  assert.equal(bySpec(wn.node, 'li.wn-row').length, 1);
  assert.equal(text(bySpec(wn.node, 'p.wn-foot')[0]), 'Nothing works now; what ended in the last hour stays listed.');
  // Another project: its own rows under its own name.
  wn.update(RUNS.map((r) => ({ ...r, projectId: 'q' })), 'q', { name: 'Room' });
  assert.equal(text(bySpec(wn.node, 'span.wn-title')[0]), 'Room / current run');
  assert.equal(bySpec(wn.node, 'li.wn-row').length, 3);
  wn.destroy();
  assert.equal(timers.length, 0, 'destroy stops the clock');
});

test('the rail dot names the working runs of its project only; the chip names the run that ended', async () => {
  assert.deepEqual(rw.railDot(RUNS, 'p'), { title: 'Working now: pwsh, Give the header room' });
  assert.equal(rw.railDot(RUNS.filter((r) => r.endedAt), 'p'), null, 'ended runs give no dot');
  assert.equal(rw.railDot(RUNS, 'other'), null);
  const railSource = (await fsp.readFile(new URL('../client/components/rail.js', import.meta.url), 'utf8'))
    .replace(/import \{([^}]*)\} from '\.\/ui\.js';/, 'const {$1} = globalThis.__ui;')
    .replace(/import \{([^}]*)\} from '\.\/run-words\.js';/, 'const {$1} = globalThis.__rw;');
  const { railTitle } = await import(`data:text/javascript,${encodeURIComponent(railSource)}`);
  const withDot = railTitle({ id: 'p', name: 'Harbor' }, RUNS);
  const dot = bySpec(withDot, 'span.rail-dot')[0];
  assert.equal(dot.title, 'Working now: pwsh, Give the header room');
  assert.equal(withDot.kids[0], dot, 'the dot comes before the name, so an ellipsis never hides it');
  assert.equal(text(withDot), 'Harbor');
  assert.equal(bySpec(railTitle({ id: 'q', name: 'Room One' }, RUNS), 'span.rail-dot').length, 0);
  // The chip: only an end the server reported, and in chipWords' words.
  assert.equal(rw.endedRun({ projectId: 'p', run: RUNS[0] }), null, 'a working run is no end');
  assert.equal(rw.endedRun({ projectId: 'p' }), null);
  const closedShell = { ...RUNS[0], state: 'Stopped', reason: 'closed', endedAt: min(0) };
  assert.equal(rw.endedRun({ projectId: 'p', run: closedShell }), closedShell);
  const { chipWords } = await import('../client/components/status-words.js');
  assert.deepEqual(chipWords('run-ended', 0, null, 'Harbor', undefined, closedShell), { visible: 'Harbor: pwsh Stopped', said: 'Status in Harbor: pwsh Stopped · closed' });
  assert.equal(chipWords('run-ended', 0, null, 'Harbor', undefined, { ...RUNS[3] }).visible, 'Harbor: Old question Waiting for you');
  assert.equal(chipWords('review', 2, null, 'Harbor').visible, 'Harbor: ready to try', 'the other states keep their sentences');
  assert.deepEqual([rw.runChipTab({ kind: 'build' }), rw.runChipTab({ kind: 'device' }), rw.runChipTab({ kind: 'terminal' }), rw.runChipTab({ kind: 'session' })], ['phone', 'phone', 'task', 'task']);
});

test('arrow keys move between marks; a redraw keeps the focus and the place', () => {
  const { strip, bundle } = studio();
  const cur = marks(strip)[2];
  cur.focus();
  cur.fire('keydown', { key: 'ArrowRight', target: cur });
  assert.equal(doc.activeElement.dataset.vid, 'v4');
  doc.activeElement.fire('keydown', { key: 'Home', target: doc.activeElement });
  assert.equal(doc.activeElement.dataset.vid, 'v1');
  assert.deepEqual(marks(strip).map((n) => n.tabIndex), [0, -1, -1, -1], 'the tab stop follows');
  const scroller = bySpec(strip.node, 'div.vstrip-scroll')[0];
  Object.assign(scroller, { scrollLeft: 30, clientWidth: 100, scrollWidth: 300 });
  strip.update({ ...bundle, changes: { sinceVersionId: 'v3', dirty: false } }, { viewingId: null });
  assert.equal(doc.activeElement.dataset.vid, 'v1', 'the new #1 holds the focus');
  assert.notEqual(doc.activeElement, marks(strip).find((n) => n.dataset.vid === 'v2'));
  assert.equal(scroller.scrollLeft, 30, 'the place is kept');
  assert.equal(bySpec(strip.node, 'span.vstub').length, 0, 'a clean tree has no stub');
  strip.update({ ...bundle, project: { id: 'other' } });
  assert.equal(scroller.scrollLeft, 300, 'a new project shows its newest marks');
});
