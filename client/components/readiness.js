// Readiness checklist from manifest.readiness; checkbox state is a project-scope UI pref
// (project.ui.readiness = { "<item text>": true }). It records YOUR judgement, not a test result.
import { el, clear, toastError } from './ui.js';

export function readinessChecklist(ctx, { title = 'Readiness checklist' } = {}) {
  const box = el('div');
  const render = () => {
    const items = ctx.manifest?.readiness || [];
    const state = ctx.project?.ui?.readiness || {};
    if (!items.length) return clear(box, el('h3', title), el('p.small.muted', 'No readiness checklist yet. Add one in atelier.json (readiness: [...]).'));
    const done = items.filter((t) => state[t]).length;
    clear(box,
      el('h3', `${title} · ${done}/${items.length}`),
      items.map((text) => {
        const cb = el('input', { type: 'checkbox', checked: !!state[text] });
        cb.addEventListener('change', async () => {
          const next = { ...(ctx.project?.ui?.readiness || {}), [text]: cb.checked };
          if (!cb.checked) delete next[text];
          try { await ctx.saveUi({ readiness: next }); render(); } catch (err) { cb.checked = !cb.checked; toastError(err, 'Readiness checklist'); }
        });
        return el('label.check', cb, el('span', text));
      }),
      el('p.hint', 'Your own judgement after trying it, saved with the project.'));
  };
  render();
  return { node: box, render };
}
