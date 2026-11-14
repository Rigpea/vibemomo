// A drag handle that sets one size (DESIGN.md section 8: the columns and the timeline resize): the pages column's
// width at its right edge, the task inspector's width at its left edge, the timeline's height at its top edge. The
// band's own grip (components/dock.js) is the same idea. Pointer drags and the arrow keys both work; the size is
// clamped, applied while dragging and saved once at the end (the caller says where: a layout pref, as a rule).
import { el } from './ui.js';

/**
 * axis: 'x' (a width) or 'y' (a height); sign: +1 when a move right or down grows the size (a left column, a panel
 * above the handle), -1 when a move left or up grows it (a right panel, a section below the handle); read(): the
 * size now in px; apply(px): set it; save(px): keep it; min, max: the clamp; step: px per arrow key.
 */
export function createSplitter({ axis = 'x', sign = 1, read, apply, save, min = 100, max = 1000, step = 16, label = 'Resize' }) {
  const node = el(`div.splitter.splitter-${axis}`, {
    role: 'separator', tabIndex: 0, 'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal', 'aria-label': label,
    title: 'Drag to resize; the arrow keys too',
  });
  const clamp = (v) => Math.round(Math.max(min, Math.min(max, Number.isFinite(v) ? v : min)));
  let drag = null;
  const at = (e) => (axis === 'x' ? e.clientX : e.clientY);
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { start: at(e), from: read() };
    try { node.setPointerCapture?.(e.pointerId); } catch { /* a stub or a lost pointer */ }
    node.classList?.add('dragging');
    e.preventDefault?.();
  });
  node.addEventListener('pointermove', (e) => {
    if (!drag) return;
    apply(clamp(drag.from + sign * (at(e) - drag.start)));
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    node.classList?.remove('dragging');
    save(clamp(read()));
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('keydown', (e) => {
    const k = e.key;
    const dir = axis === 'x' ? (k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0) : (k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0);
    if (!dir) return;
    e.preventDefault?.();
    const v = clamp(read() + sign * dir * step);
    apply(v);
    save(v);
  });
  node.setAttribute('aria-valuemin', String(min));
  node.setAttribute('aria-valuemax', String(max));
  return node;
}
