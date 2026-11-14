// The stage's side slot (docs/ARCHITECTURE.md section 4): an aside to the right of the preview, inside
// div.preview-wrap, empty and hidden until a panel puts a node in it: the Phone panel its screen (one DOM node moved
// between the Phone tab and this slot, never two screens, decision rows 107 and 108), or the dock a whole panel the
// person dragged onto the stage (project.ui.stageSide, components/dock.js). It knows which dock kind it holds.
// Wide or not is the window's width with hysteresis: wide from 1440 px, narrow again at 1416 px or less, so a window
// on the edge does not flip; between the two the last answer stands. A ResizeObserver on the Workbench calls
// measure() (client/views/workbench.js). The slot holds one node at a time: one device at a time.
export const BESIDE_MIN = 1440;
export const BESIDE_HYSTERESIS = 24;

/** Wide for the side slot: true from BESIDE_MIN, false at BESIDE_MIN - BESIDE_HYSTERESIS or less, else as it was. */
export function wideFor(width, was = false) {
  if (!Number.isFinite(width)) return !!was;
  if (width >= BESIDE_MIN) return true;
  if (width <= BESIDE_MIN - BESIDE_HYSTERESIS) return false;
  return !!was;
}

/**
 * node: the aside (hidden while empty); host: div.preview-wrap, which gains .has-side while the slot holds a node so
 * the preview centres in what is left; width(): the window's width.
 */
export function createStageSide({ node, host, width = () => globalThis.window?.innerWidth }) {
  let wide = wideFor(width(), false);
  let forced = false; // the Workbench's device picker on Phone: the slot counts as wide at any width
  const tell = () => { for (const fn of [...subs]) { try { fn(forced || wide); } catch (err) { console.error(err); } } };
  let held = null;
  let heldKind = null; // the dock kind whose node the slot holds (the dock's tab shows a mark for it)
  let target = null; // the drop target's label while a dock tab is dragged over the stage
  const subs = new Set();
  const holdSubs = new Set();
  const show = (on) => {
    node.hidden = !on;
    host?.classList?.toggle('has-side', on);
  };
  const setHeld = (n, kind) => {
    const was = heldKind;
    held = n;
    heldKind = n ? kind || null : null;
    if (was !== heldKind) for (const fn of [...holdSubs]) { try { fn(heldKind); } catch (err) { console.error(err); } }
  };
  show(false);
  return {
    node,
    host,
    wide: () => forced || wide,
    /** Read the width again; subscribers hear only a change. */
    measure() {
      const next = wideFor(width(), wide);
      if (next === wide) return forced || wide;
      const was = forced || wide;
      wide = next;
      if ((forced || wide) !== was) tell();
      return forced || wide;
    },
    /** Wide whatever the window's width (on) or by the width again (off); subscribers hear a change. */
    force(on) {
      const was = forced || wide;
      forced = !!on;
      if ((forced || wide) !== was) tell();
    },
    /** fn(wide) on every change; returns the off. */
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** fn(kind) when the dock kind the slot holds changes (null: empty); returns the off. */
    onHold(fn) { holdSubs.add(fn); return () => holdSubs.delete(fn); },
    /** Move n into the slot (a node already in the slot is taken out first: one at a time). kind: the dock tab it
     *  belongs to ('phone' for the phone's screen). */
    put(n, kind = null) {
      if (held && held !== n && held.parentNode === node) held.remove();
      if (n.parentNode !== node) node.append(n);
      setHeld(n, kind);
      show(true);
    },
    /** n leaves the slot: taken out if it is still there (a move back has already taken it), and the slot hides. */
    release(n) {
      if (held !== n) return;
      if (n.parentNode === node) n.remove();
      setHeld(null);
      show(!!target);
    },
    /** Whatever the slot holds goes (a project switch); the panel that put it there is unmounted next. */
    empty() {
      if (held?.parentNode === node) held.remove();
      setHeld(null);
      show(!!target);
    },
    holds: (n) => !!n && held === n,
    heldKind: () => heldKind,
    /** While a dock tab is dragged over the stage the slot shows as a drop target: label is the node with its words
     *  (drawn over whatever the slot holds); null takes it away and the slot is as it was. */
    target(label) {
      if (target && target.parentNode === node) target.remove();
      target = label || null;
      if (target) node.append(target);
      node.classList?.toggle('drop-target', !!target);
      show(!!target || !!held);
    },
  };
}
