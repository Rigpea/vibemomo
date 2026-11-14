// Web-app workbench panel: preview device widths (desktop / 768 / 390) and the readiness checklist.
import { el, clear, button } from '/components/ui.js';
import { readinessChecklist } from '/components/readiness.js';

const WIDTHS = [[null, 'Desktop'], [768, 'Tablet 768'], [390, 'Phone 390']];
let st = null;

export function mount(container, ctx) {
  const group = el('div.seg', { role: 'group', 'aria-label': 'Preview width' });
  const checklist = readinessChecklist(ctx);
  st = { ctx, group, checklist, width: null };
  container.append(el('div.wbp',
    el('div', el('h3', 'Preview width'), group,
      el('p.hint', { style: { marginTop: '8px' } }, 'Narrows the preview frame only; touch and mobile browsers are not emulated.')),
    checklist.node));
  renderWidths();
}

export function update() { st?.checklist.render(); }

export function unmount() {
  if (!st) return;
  st.ctx.setPreviewWidth(null);
  st = null;
}

function renderWidths() {
  clear(st.group, WIDTHS.map(([w, label]) => el('button', {
    type: 'button', 'aria-pressed': String(st.width === w),
    onclick: () => { st.width = w; st.ctx.setPreviewWidth(w); renderWidths(); },
  }, label)));
}
