// The version strip along the bottom of the Workbench (docs/ARCHITECTURE.md section 4): every version a numbered
// mark in order, newest at the right, and the tasks that made versions as bars in a thin lane above them.
// Marks are spaced by order, never by clock time: the gaps between versions run from minutes to days, so time
// would leave most of the strip empty. A bar only ever stands for real versions; a running task's bar starts at
// its base and reaches the right edge with the live dot.
// stripModel() is pure (no DOM) and tested on its own; createVersionStrip() draws from it.
import { el, clear, ago } from './ui.js';
import { stateLabel } from './version-actions.js';

export const MARK_W = 28; // px per mark: a 24 px target and 4 px of air
export const STUB_W = 18; // the dashed "files on disk" stub after the current mark
export const MAX_LANES = 3;
const RUNNING = ['working', 'needs-input'];

/** The id of a version's row in the Versions drawer, so a mark can open the drawer at it. */
export const versionRowId = (vid) => `version-row-${vid}`;

/** Scroll a drawer row into view and focus it; false when the row is not there (yet). */
export function focusVersionRow(doc, vid) {
  const row = doc?.getElementById?.(versionRowId(vid));
  if (!row) return false;
  row.scrollIntoView?.({ block: 'nearest' });
  row.focus?.();
  return true;
}

/** A mark's title and accessible name: "#n label · when · state". */
export const markName = (v) => `#${v.n} ${v.label || ''}`.trim() + ` · ${ago(v.createdAt)} · ${stateLabel(v.state)}`;

/**
 * marks: one per version in order of n ({ index, id, n, current, viewing, released, preferred, name }).
 * bars: the drawn task bars ({ taskId, from, to, lane, live, name, toEdge }), at most MAX_LANES lanes.
 * more: how many bars did not fit in the lanes. stub: the dirty stub ({ after, name }) or null. lanes: lanes used.
 */
export function stripModel(versions = [], tasks = [], { currentId = null, viewingId = null, dirty = false } = {}) {
  const sorted = [...versions].sort((a, b) => a.n - b.n);
  const index = new Map(sorted.map((v, i) => [v.id, i]));
  const marks = sorted.map((v, i) => ({
    index: i, id: v.id, n: v.n, label: v.label, state: v.state, createdAt: v.createdAt,
    current: v.id === currentId, viewing: !!viewingId && v.id === viewingId,
    released: v.state === 'released', preferred: !!v.userPreferred, name: markName(v),
  }));
  const currentIdx = index.has(currentId) ? index.get(currentId) : null;
  const stub = dirty && currentIdx !== null ? { after: currentIdx, name: `the files on disk · changed since #${sorted[currentIdx].n}` } : null;

  const last = marks.length - 1;
  const spans = [];
  for (const t of tasks) {
    const named = t.result?.versionIds?.length ? t.result.versionIds : t.result?.versionId ? [t.result.versionId] : [];
    const own = new Set([...named, ...sorted.filter((v) => v.taskId === t.id).map((v) => v.id)]);
    const idx = [...own].filter((id) => index.has(id)).map((id) => index.get(id));
    const live = RUNNING.includes(t.status);
    if (live && last >= 0) {
      // The base: the last version kept before the task started, else the current one, else the newest.
      const start = Date.parse(t.startedAt || '');
      let base = null;
      if (Number.isFinite(start)) for (const m of marks) if (Date.parse(m.createdAt) <= start) base = m.index;
      if (base === null) base = currentIdx ?? last;
      spans.push({ taskId: t.id, from: Math.min(base, ...idx), to: last, live: true, toEdge: true, name: t.title || t.id });
    } else if (idx.length) {
      spans.push({ taskId: t.id, from: Math.min(...idx), to: Math.max(...idx), live: false, toEdge: false, name: t.title || t.id });
    }
  }
  // Greedy lanes: the earliest-starting spans first, each in the lowest lane free at its start.
  spans.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || a.taskId.localeCompare(b.taskId));
  const laneEnd = [];
  const bars = [];
  let more = 0;
  for (const s of spans) {
    let lane = laneEnd.findIndex((end) => end < s.from);
    if (lane === -1 && laneEnd.length < MAX_LANES) lane = laneEnd.length;
    if (lane === -1) { more++; continue; }
    laneEnd[lane] = s.toEdge ? Infinity : s.to;
    bars.push({ ...s, lane });
  }
  return { marks, bars, more, stub, lanes: laneEnd.length };
}

/** The x of a mark's left edge: marks after the stub move right by its width. */
const markX = (i, stub) => i * MARK_W + (stub && i > stub.after ? STUB_W : 0);

/**
 * The strip's DOM. update(bundle, { viewingId }) redraws from stripModel and keeps the scroll position and the
 * focus; a project switch brings the newest marks into view. A mark opens the drawer at its row
 * (app.toggleVersions(true, { versionId })), a bar the Task tab at its task (app.showPanel('task', { taskId })).
 */
export function createVersionStrip(app) {
  const lanesBox = el('div.vstrip-lanes', { role: 'group', 'aria-label': 'Tasks over their versions' });
  const marksBox = el('div.vstrip-marks', { role: 'group', 'aria-label': 'Versions in order, newest at the right' });
  const track = el('div.vstrip-track', lanesBox, marksBox);
  const scroller = el('div.vstrip-scroll', track);
  const moreNote = el('span.vstrip-more', { hidden: true });
  const node = el('div.vstrip', scroller, moreNote);
  let projectId = null;
  let activeVid = null; // the mark that holds the strip's one tab stop
  let activeTid = null; // the bar that holds the lane's one tab stop
  let model = null;
  let drag = null; // { x, left, moved }
  let dragged = false;

  // Wheel: the strip only scrolls sideways, so a vertical wheel moves it sideways.
  scroller.addEventListener('wheel', (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });
  // Drag: a press that moves more than 4 px scrolls, and the click that ends it opens nothing.
  scroller.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === undefined) { drag = { x: e.clientX, left: scroller.scrollLeft, moved: false, id: e.pointerId }; dragged = false; } });
  scroller.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; scroller.setPointerCapture?.(drag.id); scroller.classList.add('dragging'); }
    if (drag.moved) scroller.scrollLeft = drag.left - dx;
  });
  const endDrag = () => { if (drag?.moved) dragged = true; drag = null; scroller.classList.remove('dragging'); };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);
  scroller.addEventListener('click', (e) => { if (dragged) { dragged = false; e.stopPropagation?.(); e.preventDefault(); } }, true);

  function openVersion(vid) {
    activeVid = vid;
    app.toggleVersions(true, { versionId: vid });
  }
  function openTask(tid) {
    activeTid = tid;
    app.showPanel('task', { taskId: tid });
  }

  /** Arrow keys walk a roving group; Home and End go to its ends. */
  function rove(e, list, key, set) {
    const i = list.findIndex((x) => x[key] === e.target?.dataset?.[key === 'id' ? 'vid' : 'tid']);
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined || i === -1) return;
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, to))];
    set(next[key]);
    paint();
    const sel = key === 'id' ? `[data-vid="${next.id}"]` : `[data-tid="${next.taskId}"]`;
    const target = node.querySelector(sel);
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function markNode(m) {
    const cls = ['', m.current && 'current', m.viewing && 'viewing', m.released && 'released', m.preferred && 'preferred'].filter((x) => x !== false).join('.');
    return el(`button.vmark${cls}`, {
      type: 'button', title: m.name, 'aria-label': m.name, 'aria-current': m.current ? 'true' : undefined,
      tabIndex: m.id === activeVid ? 0 : -1, dataset: { vid: m.id },
      style: { left: `${markX(m.index, model.stub)}px` },
      onclick: () => openVersion(m.id),
      onkeydown: (e) => rove(e, model.marks, 'id', (id) => { activeVid = id; }),
      onfocus: () => { activeVid = m.id; },
    }, String(m.n));
  }

  function barNode(b, width) {
    const left = markX(b.from, model.stub) + 2;
    const right = b.toEdge ? width : markX(b.to, model.stub) + MARK_W - 2;
    return el(`button.vbar${b.live ? '.live' : ''}`, {
      type: 'button', title: b.name, 'aria-label': b.live ? `${b.name} · running` : b.name,
      tabIndex: b.taskId === activeTid ? 0 : -1, dataset: { tid: b.taskId },
      style: { left: `${left}px`, width: `${Math.max(8, right - left)}px`, top: `${b.lane * 7}px` },
      onclick: () => openTask(b.taskId),
      onkeydown: (e) => rove(e, model.bars, 'taskId', (id) => { activeTid = id; }),
      onfocus: () => { activeTid = b.taskId; },
    }, b.live ? el('span.live-dot', { 'aria-hidden': 'true' }) : null);
  }

  function paint() {
    if (!model) return;
    const width = model.marks.length * MARK_W + (model.stub ? STUB_W : 0);
    track.style.width = `${width}px`;
    node.classList.toggle('has-lanes', model.lanes > 0);
    lanesBox.hidden = model.lanes === 0;
    lanesBox.style.height = `${model.lanes * 7}px`;
    clear(lanesBox, model.bars.map((b) => barNode(b, width)));
    clear(marksBox, model.marks.map(markNode),
      model.stub ? el('span.vstub', { title: model.stub.name, role: 'img', 'aria-label': model.stub.name, style: { left: `${markX(model.stub.after, null) + MARK_W}px` } }) : null);
    moreNote.hidden = !model.more;
    clear(moreNote, model.more ? `+${model.more} more` : '');
    moreNote.title = model.more ? `${model.more} more task${model.more === 1 ? '' : 's'} over these versions; the Task tab lists them all` : '';
  }

  return {
    node,
    /** Redraw from the bundle; keeps the scroll and the focus, and pins the newest in view on a new project. */
    update(bundle, { viewingId = null } = {}) {
      if (!bundle) { model = null; projectId = null; clear(lanesBox); clear(marksBox); moreNote.hidden = true; return; }
      const focused = node.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement : null;
      const focusKey = focused?.dataset?.vid ? `[data-vid="${focused.dataset.vid}"]` : focused?.dataset?.tid ? `[data-tid="${focused.dataset.tid}"]` : null;
      const newProject = bundle.project?.id !== projectId;
      const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
      const left = scroller.scrollLeft;
      projectId = bundle.project?.id;
      model = stripModel(bundle.versions || [], bundle.tasks || [], { currentId: bundle.changes?.sinceVersionId || null, viewingId, dirty: !!bundle.changes?.dirty });
      if (newProject || !model.marks.some((m) => m.id === activeVid)) activeVid = (model.marks.find((m) => m.current) || model.marks.at(-1))?.id || null;
      if (newProject || !model.bars.some((b) => b.taskId === activeTid)) activeTid = model.bars[0]?.taskId || null;
      paint();
      // A new project shows its newest versions; a redraw keeps the place, or stays at the end if it was there.
      scroller.scrollLeft = newProject || atEnd ? scroller.scrollWidth : left;
      if (focusKey) node.querySelector(focusKey)?.focus();
    },
    model: () => model,
  };
}
