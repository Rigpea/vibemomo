// Side-by-side compare: two live previews (A and B — a kept version or the
// working tree) next to each other, keyboard and pointer input mirrored to
// both, and the file diff underneath. Built for studio tasks t_51ry0wgsdy and
// t_yvdq0vwjn3 (Esc closes from a focused preview, pointer mirroring, Apply
// live reaches working-tree frames through app.previewTargets).
import { el, clear, button, dialog, select, toast, loading, icon } from './ui.js';
import { previewUrl } from '../api.js';
import { renderDiff, vname, currentVersion, stateLabel } from './version-actions.js';

const MIRRORED = ['keydown', 'keyup'];
const POINTER = ['pointerdown', 'pointerup', 'pointercancel', 'click', 'pointermove'];

function options(b) {
  const opts = [...(b.versions || [])].reverse().map((v) => [v.id, `${vname(v)}${v.id === b.changes?.sinceVersionId ? ' (current)' : ''}`]);
  opts.unshift(['head', `Working tree${b.changes?.dirty ? ` (${b.changes.files.length} changed)` : ''}`]);
  return opts;
}

function labelFor(b, ref) {
  if (ref === 'head') return 'Working tree';
  const v = b.versions.find((x) => x.id === ref);
  return v ? `${vname(v)} · ${stateLabel(v.state)}${v.userPreferred ? ' · preferred' : ''}` : ref;
}

/** Copy a trusted key event from one preview into the other (same-origin iframes). */
function forwardKey(e, target) {
  const win = target.contentWindow;
  const doc = target.contentDocument;
  if (!win || !doc) return;
  const init = { key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, repeat: e.repeat, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true, composed: true };
  const clone = new win.KeyboardEvent(e.type, init);
  clone.__atelierMirror = true;
  (doc.activeElement || doc.body || doc).dispatchEvent(clone);
}

/** Copy a trusted pointer/click event into the other preview at the same relative spot. */
function forwardPointer(e, srcWin, target) {
  const win = target.contentWindow;
  const doc = target.contentDocument;
  if (!win || !doc) return;
  const x = (e.clientX / (srcWin.innerWidth || 1)) * win.innerWidth;
  const y = (e.clientY / (srcWin.innerHeight || 1)) * win.innerHeight;
  const init = { clientX: x, clientY: y, screenX: e.screenX, screenY: e.screenY, button: e.button, buttons: e.buttons,
    pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, width: e.width, height: e.height, pressure: e.pressure,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true, composed: true };
  const clone = e.type === 'click' ? new win.MouseEvent('click', init) : new win.PointerEvent(e.type, init);
  clone.__atelierMirror = true;
  (doc.elementFromPoint(x, y) || doc.body || doc).dispatchEvent(clone);
}

export function sideBySide(app, { a, b: bRef } = {}) {
  const bundle = app.state.bundle;
  if (!bundle?.versions?.length) { toast('No versions to compare yet'); return; }
  const pid = app.projectId();
  const entry = bundle.manifest?.entry || '';
  const cur = currentVersion(bundle) || bundle.versions[bundle.versions.length - 1];
  const prev = bundle.versions.find((v) => v.n === cur.n - 1);
  const state = { a: a || prev?.id || cur.id, b: bRef || (bundle.changes?.dirty ? 'head' : cur.id), mirror: true, focused: null, mirroring: false, offs: [], sideOffs: { a: [], b: [] } };
  let dlg = null;
  const stats = { a: { events: 0, last: '' }, b: { events: 0, last: '' } };

  const selA = select(options(bundle), state.a, { 'aria-label': 'Version A' });
  const selB = select(options(bundle), state.b, { 'aria-label': 'Version B' });
  const mirror = el('input', { type: 'checkbox', id: 'sbs-mirror', checked: true, onchange: () => { state.mirror = mirror.checked; note(); } });
  const status = el('span.small.muted', { role: 'status', 'aria-live': 'polite' });
  const cols = {};
  const frames = {};
  const labels = {};
  for (const side of ['a', 'b']) {
    frames[side] = el('iframe', { title: `Preview ${side.toUpperCase()}`, allow: 'autoplay; fullscreen; gamepad', referrerpolicy: 'same-origin' });
    labels[side] = el('div.sbs-label');
    cols[side] = el(`div.sbs-col.side-${side}`, labels[side], frames[side]);
  }
  const diffOut = el('div.sbs-diff');

  const note = () => clear(status, state.mirror
    ? `Input in ${state.focused ? state.focused.toUpperCase() : 'either preview'} is mirrored · Esc closes`
    : 'Each preview takes its own input · Esc closes');

  function renderLabels() {
    for (const side of ['a', 'b']) {
      const s = stats[side];
      clear(labels[side],
        el('strong', side.toUpperCase()),
        el('span.ellipsis', { style: { flex: 1 } }, labelFor(bundle, state[side])),
        s.events ? el('span.small.muted', `${s.events} event${s.events === 1 ? '' : 's'}${s.last ? ` · ${s.last}` : ''}`) : el('span.small.muted', 'no events yet'),
        button('Reload', { small: true, variant: 'quiet', title: `Reload ${side.toUpperCase()}`, 'aria-label': `Reload ${side.toUpperCase()}`, onclick: () => load(side) }));
      cols[side].classList.toggle('focused', state.focused === side);
    }
  }

  function wire(side) {
    const frame = frames[side];
    const other = side === 'a' ? 'b' : 'a';
    let win;
    try { win = frame.contentWindow; } catch { return; }
    if (!win) return;
    state.sideOffs[side].splice(0).forEach((off) => off()); // drop listeners from the previous load
    const onKey = (e) => {
      if (e.isTrusted && e.key === 'Escape') { // Esc closes the dialog; the game never sees it
        e.stopPropagation();
        if (e.type === 'keydown') { e.preventDefault(); dlg?.close(); }
        return;
      }
      if (!e.isTrusted || e.__atelierMirror || !state.mirror) return;
      forwardKey(e, frames[other]);
    };
    const onPointer = (e) => {
      if (!e.isTrusted || e.__atelierMirror || !state.mirror) return;
      if (e.type === 'pointermove' && e.buttons === 0) return;
      let src = null;
      try { src = win.document.activeElement; } catch { /* ignore */ }
      state.mirroring = true;
      try { forwardPointer(e, win, frames[other]); } finally { state.mirroring = false; }
      if (document.activeElement !== frame) { // the other game's canvas grabbed focus: hand it back
        try { if (src && src !== win.document.body) src.focus(); else win.focus(); } catch { /* ignore */ }
      }
    };
    const onFocus = () => { if (state.mirroring) return; state.focused = side; renderLabels(); note(); };
    const listen = [...MIRRORED.map((t) => [t, onKey]), ...POINTER.map((t) => [t, onPointer]), ['focus', onFocus], ['pointerdown', onFocus]];
    for (const [type, fn] of listen) win.addEventListener(type, fn, true);
    state.sideOffs[side].push(() => { try { for (const [type, fn] of listen) win.removeEventListener(type, fn, true); } catch { /* frame gone */ } });
  }

  function load(side) {
    const ref = state[side];
    stats[side] = { events: 0, last: '' };
    app.workbench?.bus.resetFrame(side.toUpperCase());
    frames[side].src = `${previewUrl(pid, ref, entry)}?sbs=${side}&t=${Date.now()}`;
    renderLabels();
  }
  for (const side of ['a', 'b']) frames[side].addEventListener('load', () => wire(side));

  const onMessage = (e) => {
    for (const side of ['a', 'b']) {
      if (e.source !== frames[side].contentWindow || !e.data || e.data.type !== 'atelier:event') continue;
      stats[side].events += 1;
      stats[side].last = e.data.name || '';
      renderLabels();
      app.workbench?.bus.receiveFrame(side.toUpperCase(), e.data);
    }
  };
  window.addEventListener('message', onMessage);
  state.offs.push(() => window.removeEventListener('message', onMessage));

  async function loadDiff() {
    clear(diffOut, loading('Comparing files…'));
    let from = state.a;
    let to = state.b;
    if (from === to) { clear(diffOut, el('p.small.muted', 'Same version on both sides: no file differences.')); return; }
    let swapped = false;
    if (from === 'head') { [from, to] = [to, from]; swapped = true; }
    try {
      const r = await app.api.compare(pid, from, to);
      const files = r.files || [];
      clear(diffOut,
        el('p.small.muted', `${swapped ? 'B' : 'A'} ${vname(r.a)} → ${swapped ? 'A' : 'B'} ${r.b.id === 'head' ? 'working tree' : vname(r.b)} · ${files.length} file${files.length === 1 ? '' : 's'} differ`),
        files.length ? el('ul.diff-files', files.map((f) => el('li', el('span.tag', f.status), el('span.mono', { style: { flex: 1 } }, f.path),
          el('span.plus.mono', f.additions === null ? 'bin' : `+${f.additions}`), el('span.minus.mono', f.deletions === null ? '' : `−${f.deletions}`)))) : null,
        renderDiff(r.diff),
        r.truncated ? el('p.note.warn', 'Diff truncated at 200 KB.') : null);
    } catch (err) { clear(diffOut, el('p.note.danger', err.message)); }
  }

  const change = (side, sel) => { state[side] = sel.value; load(side); loadDiff(); };
  selA.addEventListener('change', () => change('a', selA));
  selB.addEventListener('change', () => change('b', selB));
  app.previewTargets ??= new Set();
  const targets = ['a', 'b'].map((side) => ({ frame: frames[side], getRef: () => state[side] }));
  targets.forEach((t) => app.previewTargets.add(t));
  const swap = () => { [state.a, state.b] = [state.b, state.a]; selA.value = state.a; selB.value = state.b; load('a'); load('b'); loadDiff(); };
  const focusSide = (side) => { state.focused = side; renderLabels(); note(); try { frames[side].contentWindow?.focus(); } catch { /* ignore */ } };

  const head = el('div.sbs-head',
    el('label.small.muted', { for: selA.id = 'sbs-a' }, 'A'), el('div.sbs-pick', selA),
    button('Swap', { small: true, variant: 'quiet', title: 'Swap A and B', 'aria-label': 'Swap A and B', onclick: swap }),
    el('label.small.muted', { for: selB.id = 'sbs-b' }, 'B'), el('div.sbs-pick', selB),
    el('label.row.small', { for: 'sbs-mirror', style: { gap: '6px', marginLeft: '8px' } }, mirror, 'Mirror input to both'),
    button('Play in A', { small: true, variant: 'quiet', title: 'Put the keyboard in preview A (its own Play button is inside the preview)', onclick: () => focusSide('a') }),
    button('Play in B', { small: true, variant: 'quiet', title: 'Put the keyboard in preview B (its own Play button is inside the preview)', onclick: () => focusSide('b') }),
    status);

  const body = el('div.sbs', head, el('div.sbs-grid', cols.a, cols.b), el('details.sbs-details', el('summary', 'File differences'), diffOut));
  // The overlay takes the whole preview area: collapse the dock while it is open, put it back after.
  const dockWasCollapsed = app.workbench?.collapseDock?.(true);
  // The Versions drawer lies over the preview area and would hide the frames; it stays closed until reopened.
  if (app.layout().versionsOpen.value) app.toggleLayout('versionsOpen', false);
  // So would the Task | Focus overlay of a narrow window; the person can reopen it (], the Panel button).
  if (app.isNarrow() && app.state.narrowPanelOpen) app.toggleLayout('collabCollapsed', true);
  const onClose = () => {
    if (dockWasCollapsed !== undefined) app.workbench?.collapseDock?.(dockWasCollapsed);
    targets.forEach((t) => app.previewTargets.delete(t));
    [...state.offs, ...state.sideOffs.a, ...state.sideOffs.b].forEach((off) => off());
  };
  const d = dialog({ title: 'Side by side', wide: true, body, actions: [], onClose, modal: false, parent: app.workbench?.host?.() || document.body });
  dlg = d;
  d.node.classList.add('overlay');
  // Esc closes it from anywhere on the page: a key pressed on a dock button never passes through the overlay.
  // A modal opened on top (Keep version) takes its own Esc first. Inside a frame, wire() handles it.
  const onDocumentKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog:modal')) return;
    e.preventDefault();
    d.close();
  };
  document.addEventListener('keydown', onDocumentKey);
  state.offs.push(() => document.removeEventListener('keydown', onDocumentKey));
  // After dialog() has handed focus back to its opener, which a toolbar re-render may have replaced. Not after a project switch: the person is elsewhere.
  d.done.then(() => { if (app.projectId() === pid) document.querySelector('#main .stage-head [aria-label="Side by side compare"]')?.focus(); });
  load('a');
  load('b');
  loadDiff();
  note();
  return d;
}
