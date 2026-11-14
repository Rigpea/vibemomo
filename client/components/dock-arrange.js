// Arranging the dock (docs/ARCHITECTURE.md section 4): the tab order the person dragged (project.ui.dockOrder) and
// the pointer drag that sets it or puts a panel beside the preview (project.ui.stageSide). Pure helpers first, then
// the drag itself; components/dock.js draws the tabs and moves the panels. No DOM is built here.

/** A drag starts only after this many px of movement, so a click on a tab stays a click (decision row 109). */
export const LIFT_PX = 6;

/**
 * The project's kinds in the person's order. kinds: panelKinds() in the default order; order: project.ui.dockOrder.
 * A kind in order the project does not have is ignored; a kind the project has that order does not name (a new
 * panel) goes to its default place: right after the nearest kind before it in the default order, else first.
 */
export function orderKinds(kinds, order) {
  if (!Array.isArray(order) || !order.length) return [...kinds];
  const placed = [];
  for (const k of order) if (kinds.includes(k) && !placed.includes(k)) placed.push(k);
  kinds.forEach((k, d) => {
    if (placed.includes(k)) return;
    let at = 0;
    for (let j = d - 1; j >= 0; j--) {
      const p = placed.indexOf(kinds[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    placed.splice(at, 0, k);
  });
  return placed;
}

/** order with kind moved to index (an index among the other kinds: 0 is first, others.length is last). */
export function moveTo(order, kind, index) {
  const rest = order.filter((k) => k !== kind);
  const i = Math.max(0, Math.min(Number.isFinite(index) ? index : rest.length, rest.length));
  rest.splice(i, 0, kind);
  return rest;
}

export const sameOrder = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/** The sentence the dock's live region says after a move: "Page moved before Companion" (or after the last). */
export function movedWords(order, kind, label = (k) => k) {
  const i = order.indexOf(kind);
  if (i < 0 || order.length < 2) return `${label(kind)} moved`;
  return i < order.length - 1 ? `${label(kind)} moved before ${label(order[i + 1])}` : `${label(kind)} moved after ${label(order[i - 1])}`;
}

/**
 * Where a tab dropped at x lands. rects: the other tabs' boxes in order ({ left, width }). The index is the number of
 * tabs whose middle lies left of x; line: the x of the drop line (the gap before that tab, or after the last).
 */
export function dropAt(rects, x) {
  let index = 0;
  for (const r of rects) if (x > r.left + r.width / 2) index++;
  const line = !rects.length ? null : index < rects.length ? rects[index].left : rects.at(-1).left + rects.at(-1).width;
  return { index, line };
}

const inside = (r, x, y) => !!r && r.width > 0 && r.height > 0 && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;

/**
 * The pointer drag of a dock tab (or of the side slot's head). Listens on doc while a press is down.
 * stage(): the preview-wrap's box (dropping inside it puts the panel beside the preview); others(kind): the other
 * tabs' boxes in order; onLift(kind); onOver({ kind, zone: 'stage' | 'tabs', index, line }); onDrop({ kind, from,
 * zone, index }); onEnd(): the drag is over (dropped or cancelled), take the drop line and target away.
 */
export function createTabDrag({ doc = globalThis.document, stage, others, onLift, onOver, onDrop, onEnd }) {
  let d = null;
  let swallow = false;
  const zoneAt = (x, y) => {
    if (inside(stage?.(), x, y)) return { zone: 'stage', index: null, line: null };
    return { zone: 'tabs', ...dropAt(others(d.kind), x) };
  };
  function move(e) {
    if (!d) return;
    if (!d.lifted) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < LIFT_PX) return;
      d.lifted = true;
      onLift?.(d.kind, d.from);
    }
    e.preventDefault?.();
    d.over = zoneAt(e.clientX, e.clientY);
    onOver?.({ kind: d.kind, from: d.from, ...d.over });
  }
  function up(e) {
    if (!d) return;
    const was = d;
    stop();
    if (!was.lifted) return; // a click: the tab's own click handler runs
    swallow = true; // the click the browser sends after this pointerup is not a tab selection
    setTimeout(() => { swallow = false; }, 0);
    const over = was.over || zoneAt(e.clientX, e.clientY);
    onEnd?.();
    onDrop?.({ kind: was.kind, from: was.from, ...over });
  }
  function cancel() {
    if (!d) return;
    const lifted = d.lifted;
    stop();
    if (lifted) onEnd?.();
  }
  function key(e) { if (e.key === 'Escape' && d?.lifted) { e.preventDefault?.(); cancel(); } }
  function stop() {
    d = null;
    doc.removeEventListener('pointermove', move);
    doc.removeEventListener('pointerup', up);
    doc.removeEventListener('pointercancel', cancel);
    doc.removeEventListener('keydown', key);
  }
  return {
    /** A press on a tab (from 'tabs') or on the slot's head (from 'side'). */
    start(e, kind, from = 'tabs') {
      if (e.button !== undefined && e.button !== 0) return;
      cancel();
      d = { kind, from, x: e.clientX, y: e.clientY, lifted: false, over: null };
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', up);
      doc.addEventListener('pointercancel', cancel);
      doc.addEventListener('keydown', key);
    },
    /** The kind being dragged once lifted (its tab draws lifted across re-renders), else null. */
    lifted: () => (d?.lifted ? d.kind : null),
    /** True once for the click that follows a drop. */
    takeClick() { const s = swallow; swallow = false; return s; },
    cancel,
  };
}
