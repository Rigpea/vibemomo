// Action workbench panel: tuning editor for manifest.tuning (a `window.ATELIER_TUNING = {...};` file).
// Reads the JSON between the first "{" and the last "}", edits it as a form, applies it live to the
// preview (postMessage atelier:tuning) and saves it back with the original comments and wrapper intact.
// Unsaved edits are kept per project as project.ui.tuningDraft = { file, values, at } (debounced) and
// restored on mount; Reset and Save to file clear the draft. A draft is never applied live automatically.
import { el, clear, button, stateChip, toast, toastError, loading } from '/components/ui.js';

let st = null;

export function mount(container, ctx) {
  st = { ctx, container, file: null, prefix: '', suffix: '', text: null, saved: {}, values: {}, appliedAt: null, ack: null, busy: false, error: null, draftTimer: null, draftAt: null, draftErrShown: false };
  // The product acknowledges atelier:tuning with an atelier:event named "tuning" ({applied, ignored}).
  st.offs = [
    ctx.bus.on('event', (ev) => {
      if (!st || ev.name !== 'tuning') return;
      st.ack = { at: ev.at, applied: ev.data.applied || [], ignored: ev.data.ignored || [] };
      renderBar();
    }),
    ctx.bus.on('reload', () => {
      if (!st) return;
      st.ack = null;
      st.appliedAt = null;
      renderBar();
    }),
  ];
  load();
}

export function unmount() {
  if (!st) return;
  st.offs.forEach((off) => off());
  if (st.draftTimer) persistDraft(st); // flush the last edit so a project switch does not lose it
  st.ctx.app.tuningApplied = null;
  st = null;
}

/** Bundle refreshed (file saved, version restored, …): re-sync from disk. Unsaved edits are kept and
 *  re-counted against the new file (the form re-renders only when the file actually changed). */
export function update() {
  if (st && !st.busy) load({ quiet: true });
}

async function load({ quiet = false } = {}) {
  const { ctx } = st;
  const path = ctx.manifest.tuning;
  if (!path) return clear(st.container, el('div.empty.compact', el('p.empty-title', 'No tuning file. Add "tuning": "src/tuning.js" to atelier.json to tune values here.')));
  if (!quiet) clear(st.container, loading(`Reading ${path}…`));
  try {
    const f = await ctx.api.readFile(ctx.projectId, path);
    if (!st) return;
    const text = f.content;
    const keep = quiet && dirty(st) ? st.values : null; // unsaved edits in this session
    const draft = ctx.project?.ui?.tuningDraft?.file === path ? ctx.project.ui.tuningDraft : null;
    if (quiet && !st.error && text === st.text && (keep || !draft)) return; // nothing changed underneath: keep the form (and focus)
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error(`${path} has no {…} object`);
    const obj = JSON.parse(text.slice(a, b + 1));
    Object.assign(st, { file: path, text, prefix: text.slice(0, a), suffix: text.slice(b + 1), saved: obj, values: structuredClone(obj), error: null });
    const src = keep || draft?.values || {};
    // Merge only keys the file has, that differ from it and keep the file value's type.
    const merged = Object.keys(obj).filter((k) => k in src && src[k] !== obj[k] && typeof src[k] === typeof obj[k]);
    for (const k of merged) st.values[k] = src[k];
    if (keep) { if (st.draftAt || merged.length) scheduleDraft(); } // re-sync the stored draft with the new file
    else {
      st.draftAt = merged.length ? draft.at : null;
      // The file caught up with the stored draft (restore, an outside edit): nothing is unsaved any more.
      if (draft && !merged.length) writeDraft(ctx, null).catch((err) => toastError(err, 'Clear tuning draft'));
    }
  } catch (err) {
    if (!st) return;
    st.error = err;
  }
  render();
}

const dirty = (s) => !!s && Object.keys(s.values).some((k) => s.values[k] !== s.saved[k]);
const isDirty = () => dirty(st);

function scheduleDraft() {
  clearTimeout(st.draftTimer);
  const s = st;
  st.draftTimer = setTimeout(() => persistDraft(s), 500);
}

const cancelDraft = () => { clearTimeout(st.draftTimer); st.draftTimer = null; };

/** Store (or clear) this project's draft. Uses the panel's own state object so it also runs after unmount. */
function persistDraft(s) {
  clearTimeout(s.draftTimer);
  s.draftTimer = null;
  const keep = dirty(s);
  const at = new Date().toISOString();
  if (keep) s.draftAt = at;
  if (s === st) renderBar();
  writeDraft(s.ctx, keep ? { file: s.file, values: { ...s.values }, at } : null).catch((err) => {
    if (s.draftErrShown) return;
    s.draftErrShown = true; // one toast per panel, not one per keystroke
    toastError(err, 'Keep tuning draft');
  });
}

async function writeDraft(ctx, draft) {
  if (ctx.project?.id === ctx.projectId) {
    if (ctx.project.ui) ctx.project.ui.tuningDraft = draft; // a bundle refresh before the PATCH lands sees it too
    return ctx.saveUi({ tuningDraft: draft });
  }
  // Flushed during a project switch: ctx.saveUi would merge into the new project's ui, so patch ours directly.
  const b = await ctx.api.project(ctx.projectId);
  return ctx.api.patchProject(ctx.projectId, { ui: { ...(b.project.ui || {}), tuningDraft: draft } });
}

function stepFor(v) {
  if (!Number.isInteger(v)) {
    const decimals = (String(v).split('.')[1] || '').length;
    return decimals >= 2 ? 0.05 : 0.1;
  }
  return Math.abs(v) >= 500 ? 20 : Math.abs(v) >= 50 ? 10 : 1;
}

function control(key) {
  const v = st.values[key];
  const orig = st.saved[key];
  const row = el('div.tune', { class: v !== orig ? 'changed' : '' });
  const id = `tune-${key}`;
  const set = (nv) => { st.values[key] = nv; row.classList.toggle('changed', nv !== orig); renderBar(); scheduleDraft(); };
  let ctl;
  if (typeof orig === 'number') {
    // aria-label = the parameter name (the visible label stays): several panels can be mounted at
    // once, so the label's for= alone is not a reliable accessible name.
    ctl = el('input.input', { id, type: 'number', step: stepFor(orig), value: v, title: `File value: ${orig}`, 'aria-label': key });
    ctl.addEventListener('input', () => { if (Number.isFinite(ctl.valueAsNumber)) set(ctl.valueAsNumber); });
    ctl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyLive(); } });
  } else if (typeof orig === 'boolean') {
    ctl = el('input.switch', { id, type: 'checkbox', role: 'switch', checked: !!v, 'aria-label': key });
    ctl.addEventListener('change', () => set(ctl.checked));
  } else {
    ctl = el('input.input', { id, type: 'text', value: v ?? '', 'aria-label': key });
    ctl.addEventListener('input', () => set(ctl.value));
    if (/^#[0-9a-f]{6}$/i.test(String(orig))) {
      const color = el('input', { type: 'color', value: v, 'aria-label': `${key} color picker`, style: { width: '28px', height: '28px', padding: 0, border: 0, background: 'none' } });
      color.addEventListener('input', () => { ctl.value = color.value; set(color.value); });
      ctl = el('div.row', { style: { gap: '4px' } }, color, ctl);
    }
  }
  row.append(el('label', { htmlFor: id, title: key }, key), ctl);
  return row;
}

function render() {
  if (!st) return;
  const { container } = st;
  if (st.error) {
    return clear(container, el('div.empty.compact.error', el('p.empty-title', `Could not read the tuning file: ${st.error.message}`), button('Retry', { small: true, onclick: () => load() })));
  }
  st.bar = el('div.panel-bar.tuning-bar');
  clear(container, st.bar, el('div.tuning-form', Object.keys(st.values).map(control)));
  renderBar();
}

function renderBar() {
  if (!st?.bar) return;
  const dirty = isDirty();
  const changed = Object.keys(st.values).filter((k) => st.values[k] !== st.saved[k]);
  const ready = !!st.ctx.bus.ready;
  // Chips only for states (unsaved, the product's acknowledgement); everything else is one meta line.
  const acks = ackChips();
  // For Keep version (client/components/tuning-note.js): which project has acknowledged values live that the file lacks.
  st.ctx.app.tuningApplied = liveNotInFile().length ? st.ctx.projectId : null;
  const meta = [st.file, dirty && st.draftAt ? `draft kept ${new Date(st.draftAt).toLocaleTimeString()}` : dirty || acks.length ? null : 'matches file', sentLine()].filter(Boolean).join(' · ');
  clear(st.bar,
    dirty ? stateChip(`unsaved · ${changed.length} changed`, 'warn', changed.join(', ')) : null,
    ...acks,
    el('span.meta.mono', { title: dirty && st.draftAt ? 'Unsaved values are kept for this project until Reset or Save to file' : '' }, meta),
    el('span.panel-actions',
      button('Apply live', { small: true, variant: 'quiet', title: ready ? 'Send these values to the running preview (does not save)' : 'Send to the preview (it has not reported ready yet)', onclick: applyLive }),
      button('Reset', { small: true, variant: 'quiet', disabled: !dirty, title: 'Back to the values in the file', onclick: reset }),
      button('Save to file', { small: true, disabled: !dirty, onclick: save })));
}

/** "sent HH:MM:SS" while the last Apply live has no acknowledgement from the product. */
function sentLine() {
  if (!st.appliedAt) return null;
  const { ack } = st;
  return !ack || ack.at < st.appliedAt ? `sent ${new Date(st.appliedAt).toLocaleTimeString()}` : null;
}

const acked = () => !!st.appliedAt && !!st.ack && st.ack.at >= st.appliedAt;

/** Acknowledged keys whose live value differs from the file. Counted now, not when the ack arrived: the
 *  live values (as sent) against the file as it is now, so it empties once the same values are saved or kept. */
function liveNotInFile() {
  if (!acked()) return [];
  const live = st.sentValues || {};
  return st.ack.applied.filter((k) => k in live && live[k] !== st.saved[k]);
}

/** The product's acknowledgement of the last Apply live (only when it arrived after the send). */
function ackChips() {
  if (!acked()) return [];
  const { ack } = st;
  const changed = liveNotInFile();
  const label = !ack.applied.length ? 'nothing applied' : changed.length ? `applied · ${changed.length} changed` : 'applied · matches file';
  return [
    stateChip(label, ack.applied.length ? 'ok' : 'warn', ack.applied.length ? (changed.length ? `Live but not in the file: ${changed.join(', ')}` : `Applied: ${ack.applied.join(', ')}`) : 'The product applied none of the keys it was sent'),
    ack.ignored.length ? stateChip(`ignored: ${ack.ignored.join(', ')}`, 'warn', 'The product skipped these keys (unknown key or wrong type)') : null,
  ];
}

function reset() {
  cancelDraft();
  st.values = structuredClone(st.saved);
  st.draftAt = null;
  render();
  applyLive({ quiet: true });
  writeDraft(st.ctx, null).catch((err) => toastError(err, 'Clear tuning draft'));
}

function applyLive({ quiet = false } = {}) {
  if (!st) return;
  st.ack = null;
  st.sentValues = { ...st.values };
  st.ctx.post({ type: 'atelier:tuning', tuning: st.sentValues });
  st.appliedAt = Date.now();
  renderBar();
  if (!quiet) toast(st.ctx.bus.ready ? 'Applied live to the preview (not saved yet)' : 'Sent to the preview — it has not reported ready, so it may ignore it', { timeout: 2200, tone: st.ctx.bus.ready ? 'ok' : 'warn' });
}

async function save() {
  if (!st || st.busy) return;
  st.busy = true;
  const content = `${st.prefix}${JSON.stringify(st.values, null, 2)}${st.suffix}`;
  try {
    await st.ctx.api.writeFile(st.ctx.projectId, st.file, content);
    if (!st) return;
    st.saved = structuredClone(st.values);
    st.text = content;
    cancelDraft();
    st.draftAt = null;
    render();
    const { ctx, file } = st;
    // Before the bundle reload: a reload that overtook the PATCH would bring the cleared draft back,
    // and Keep version would still say the change is unsaved.
    await writeDraft(ctx, null).catch((err) => toastError(err, 'Clear tuning draft'));
    toast(`Saved ${file}. Keep a version to record it.`, { tone: 'ok' });
    ctx.app.loadBundle({ quiet: true });
  } catch (err) {
    toastError(err, 'Save');
  } finally {
    if (st) st.busy = false;
  }
}
