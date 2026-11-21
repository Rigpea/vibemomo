// Inspiration › Studio look (docs/DESIGN.md section 15, docs/ARCHITECTURE.md section 27): the column beside the
// person's Studio look board. It says what the board is for (the studio, for you; never the open project's app),
// what look is in effect, and offers Make a look: a proposal from the board's colour, type and note cards, each
// choice naming its card, previewed live over the whole studio until Apply or Discard. Apply, Undo and Reset go
// through the server (settings.appearance; Undo is kept there, so it survives a reload). The words come from
// components/studio-look-model.js and appearance-model.js; nothing here decides a colour.
import { el, clear, button, toast, toastError } from './ui.js';
import { proposeLook, pairsWords, valueWords } from './studio-look-model.js';
import { lockDiffs, lockLine, accentOf, optionOf, FONTS, CONTROLS } from './appearance-model.js';

const OLDER = 'This studio server started before the Studio look existed, so it cannot keep a look yet. Restart it to load the new code (Ctrl+Alt+R).';
const themeNow = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** What the look in effect is, in one line. */
export function lookWords(look, theme) {
  const s = look?.surfaces?.[theme];
  const parts = [];
  if (s) parts.push(`canvas ${s.canvas}, panel ${s.panel}, ink ${s.ink}`);
  if (look?.accent?.[theme] || s) parts.push(`accent ${accentOf(look, theme)}`);
  if (look?.display) parts.push(`${FONTS[optionOf(look, 'display')].label} for display`);
  if (look?.radius) parts.push(`${CONTROLS.radius.options[optionOf(look, 'radius')].label.toLowerCase()} corners`);
  if (!parts.length) return `The studio shows its own look in the ${theme} theme.`;
  return `Your look in the ${theme} theme: ${parts.join(', ')}.`;
}

/** Mount in host. opts.cards(): the board's cards as the view holds them (null while it reads them); opts.projectName()
 *  and opts.projectIsStudio(): the open project, for the scope sentence. Returns { makeButton, refresh(), show(on), unmount() }. */
export function mountStudioLook(host, app, opts) {
  const st = { gone: false, on: false, proposal: null, busy: false };
  const facts = () => app.state.appearance;
  const scope = el('p.slook-scope');
  const now = el('p.slook-now');
  const locks = el('p.slook-lock', { hidden: true });
  const older = el('p.note', { hidden: true }, OLDER, ' ', button('Restart the studio', { small: true, onclick: () => app.restart() }));
  const makeButton = button('Make a look', { variant: 'primary', title: 'Propose a studio look from this board\'s colour, type and note cards', onclick: () => make() });
  const undo = button('Undo', { onclick: () => undoLook() });
  const reset = button('Reset to defaults', { onclick: () => resetLook() });
  const actions = el('div.row.slook-actions', undo, reset);
  const proposal = el('section.slook-proposal', { hidden: true, 'aria-labelledby': 'slook-proposal-h' });
  const live = el('p.sr-only', { 'aria-live': 'polite' });
  clear(host, el('h2.slook-h', 'Studio look'), scope, older, proposal, now, locks, actions, live); // a proposal comes first: it is what is on screen

  // ---------- the proposal ----------
  function make({ quiet = false } = {}) {
    const cards = opts.cards();
    if (!cards) return;
    st.proposal = proposeLook(cards, themeNow(), facts()?.stored || {});
    app.previewLook(st.proposal.preview && canApply() ? st.proposal.preview : null);
    render();
    if (!quiet) { proposal.querySelector('h3')?.focus(); clear(live, 'A look from your board, shown over the studio until you Apply or Discard'); }
  }
  const canApply = () => !!st.proposal && !st.proposal.problem && Object.keys(st.proposal.patch).length > 0;
  function discard() {
    st.proposal = null;
    app.previewLook(null);
    render();
    makeButton.focus();
  }

  async function act(run, words) {
    if (st.busy) return;
    st.busy = true;
    render();
    try {
      await run();
      await app.loadStudio(); // what shows is what the server kept
      return true;
    } catch (err) {
      toastError(err, 'Studio look');
      return false;
    } finally {
      st.busy = false;
      app.previewLook(null);
      if (!st.gone) render();
      if (words && !st.gone) clear(live, words);
    }
  }
  async function apply() {
    if (!canApply()) return;
    const { patch } = st.proposal;
    if (!(await act(() => app.api.applyLook(patch), 'The look is applied'))) return;
    st.proposal = null;
    render();
    toast('Studio look applied', { tone: 'ok', timeout: 8000, action: { label: 'Undo', run: () => undoLook() } });
    makeButton.focus();
  }
  async function undoLook() {
    if (await act(() => app.api.undoLook(), 'The look before is back')) toast('The look before is back', { tone: 'ok', timeout: 3000 });
  }
  async function resetLook() {
    if (!(await act(() => app.api.resetLook(), 'The studio is back to its defaults'))) return;
    st.proposal = null;
    render();
    toast('The studio is back to its defaults', { tone: 'ok', timeout: 8000, action: { label: 'Undo', run: () => undoLook() } });
  }

  // ---------- render ----------
  function row(r) {
    const sw = r.hex ? el('span.slook-sw', { 'aria-hidden': 'true' }) : null;
    if (sw) sw.style.setProperty('--sw', r.hex);
    const value = el('span.slook-value', valueWords(r));
    value.classList.toggle('muted', r.value == null);
    if (r.font) value.style.fontFamily = r.font; // the face itself shows its name
    if (r.hex) value.classList.add('mono');
    return el('li.slook-row', el('span.slook-label', r.label), el('span.slook-pick', sw, value), el('span.slook-from', r.words));
  }
  function renderProposal() {
    const p = st.proposal;
    proposal.hidden = !p;
    if (!p) return clear(proposal);
    const ok = canApply();
    const theme = p.theme === 'dark' ? 'dark' : 'light';
    const lead = ok ? `For the ${theme} theme, the one on screen, and shown over the studio now. Nothing is kept until Apply.` : 'Nothing on the board gives a look yet: add colour cards, or a note that names a face or how corners should feel.';
    clear(proposal,
      el('h3', { id: 'slook-proposal-h', tabindex: '-1' }, 'A look from your board'),
      el('p.meta', lead),
      el('ol.slook-rows', p.rows.map(row)),
      p.problem ? el('p.note.warn', p.problem) : p.pairs.length ? el('p.meta.slook-pairs', pairsWords(p.pairs)) : null,
      el('div.row', button('Apply', { variant: 'primary', disabled: !ok || st.busy, onclick: () => apply() }), button('Discard', { disabled: st.busy, onclick: () => discard() })));
  }
  function render() {
    if (st.gone) return;
    const f = facts();
    const theme = themeNow();
    const project = opts.projectName();
    older.hidden = !!f;
    clear(scope, `Restyles the studio for you, on this computer.${project ? ` It is not ${project}'s app board, and no worker reads it.` : ' No worker reads it.'}${opts.projectIsStudio() ? ` ${project}'s own board is for workers changing the studio's source; this one is only yours.` : ''}`);
    const shown = app.state.lookPreview || f?.effective || {};
    clear(now, f ? lookWords(f.effective || {}, theme) : '');
    const line = f?.rulesUnread ? `${f.rulesProject?.name || 'The studio project'}'s fixed rules could not be read, so whether your look differs from a locked default is not known.` : lockLine(lockDiffs(shown, f?.locked || [], theme), f?.rulesProject?.name || '');
    clear(locks, line);
    locks.hidden = !line;
    const busyOff = !f || st.busy;
    makeButton.disabled = busyOff || opts.cards() === null;
    makeButton.querySelector('span').textContent = st.proposal ? 'Make again' : 'Make a look';
    makeButton.classList.toggle('primary', !st.proposal); // one primary action in sight: Apply, once a look is proposed
    undo.hidden = !f?.undo;
    undo.disabled = busyOff;
    undo.title = f?.undo ? `Bring back ${f.undo.words}` : '';
    reset.disabled = busyOff || !Object.keys(f?.stored || {}).length;
    reset.title = reset.disabled && f ? 'The studio already shows its own look' : 'Every appearance choice back to the studio\'s own, Settings\' too';
    renderProposal();
  }

  const offs = [
    app.on('studio', () => render()),
    app.on('layout', () => { if (st.proposal) make({ quiet: true }); else render(); }), // the theme: a look is made per theme
  ];
  render();

  return {
    makeButton,
    /** The board changed (or was read): an open proposal is made again from it, so the preview follows the board. */
    refresh() { if (st.proposal && st.on) make({ quiet: true }); else render(); },
    show(on) {
      st.on = on;
      makeButton.hidden = !on;
      if (!on && st.proposal) { st.proposal = null; app.previewLook(null); }
      render();
    },
    unmount() { st.gone = true; offs.forEach((off) => off()); if (st.proposal) app.previewLook(null); },
  };
}
