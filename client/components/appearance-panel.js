// Settings › Appearance (docs/DESIGN.md section 12, docs/ARCHITECTURE.md section 24): the person's own look for the
// studio. Accent (a picker, a hex field, presets, the colour cards of the person's Studio look board), density, text
// size, corners, motion, and Reset to defaults. A choice shows at once and is saved through the settings route, which
// checks it again; what the server kept is what stays on screen. The studio project's locked tokens never disable a
// control: they bind the studio's source, and the look is the person's layer on top (decision row 186), so one line
// says when the look differs from them. The surfaces and the display font come from Inspiration › Studio look. The
// nodes are built once and updated in place, so the button that was pressed keeps the focus.
import { el, clear, button, input, toast, toastError } from './ui.js';
import { CONTROLS, CHOICE_KEYS, ACCENT_PRESETS, AA_TEXT, accentCheck, accentPair, accentPatch, accentOf, accentGrounds, optionOf, isCustom, lockDiffs, lockLine, restorePatch, normHex, passAll, ratioWords, contrast, FONTS } from './appearance-model.js';

const INTRO = 'How the studio looks on this computer. A change shows at once and is kept in your studio settings, never in a project.';
const OLDER = 'This studio server started before the appearance settings existed, so it cannot keep them yet. Restart it to load the new code (Ctrl+Alt+R).';
export const BOARD_MAX = 12;
/** The choices this section offers itself; the display face is the Studio look's. */
export const PANEL_KEYS = CHOICE_KEYS.filter((k) => k !== 'display');
const themeNow = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const otherTheme = (t) => (t === 'dark' ? 'light' : 'dark');

/** The colour cards of a board as presets: each hex once, in board order, at most BOARD_MAX. */
export function boardColors(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards || []) {
    const hex = c?.kind === 'color' ? normHex(c.hex) : null;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ hex, name: String(c.name || '').trim() });
    if (out.length === BOARD_MAX) break;
  }
  return out;
}

/**
 * The line under the accent: { words, nearest }. What the accent in effect is against the canvas, and the shade the
 * other theme shows. The studio's own accent is not checked by the route (it is the stylesheet's), so when it is
 * under the ratio text needs, the line says so and names the nearest shade that passes (nearest), as for a choice.
 */
export function accentWords(appearance, theme) {
  const hex = accentOf(appearance, theme);
  const other = otherTheme(theme);
  const grounds = accentGrounds(appearance, theme);
  const worst = grounds.reduce((w, g) => (contrast(hex, g.hex) < contrast(hex, w.hex) ? g : w));
  const ratio = contrast(hex, worst.hex);
  if (ratio >= AA_TEXT) return { words: `${hex} is ${ratioWords(ratio)} against the ${theme} ${worst.name} (text in the accent needs ${AA_TEXT}:1). The ${other} theme shows ${accentOf(appearance, other)}.`, nearest: null };
  const nearest = passAll(hex, grounds.map((g) => g.hex));
  return { words: `${hex}, the studio's own ${theme} accent, is ${ratioWords(ratio)} against the ${theme} ${worst.name}, under the ${AA_TEXT}:1 that text in the accent needs. The nearest shade that passes is ${nearest}.`, nearest };
}

/** Mount the section's body in host. Returns { update(), unmount() }. */
export function mountAppearance(host, app) {
  const st = { gone: false, proposal: null, typing: false, board: [], boardRead: false, boardSeq: 0, timer: 0, previewed: 0 };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  const facts = () => app.state.appearance;
  const effective = () => app.state.lookPreview || facts()?.effective || {};
  const frozen = () => !facts(); // only a server from before the look; a lock never takes a control (decision row 186)

  // ---------- saving ----------
  async function save(patch, look) {
    if (look) app.previewLook(look); // at once; the server's answer replaces it
    try {
      await app.saveAppearance(patch);
      for (const old of document.querySelectorAll('#toasts [data-prefix="Appearance"]')) old.remove(); // a refusal that is no longer true
      return true;
    } catch (err) {
      toastError(err, 'Appearance');
      return false;
    } finally {
      if (!st.gone) update();
    }
  }
  const setChoice = (key, value) => save({ [key]: value }, { ...effective(), [key]: value });

  /** Take a colour as the accent: one that passes is saved for both themes (the other theme gets its nearest shade
   *  that passes there); one that does not is kept as a proposal with its sentence and the shade to use instead. */
  async function chooseAccent(value, base = themeNow()) {
    st.typing = false;
    const stored = facts()?.stored || {};
    const c = accentCheck(value, base, accentGrounds(stored, base));
    if (!c.ok) { app.previewLook(null); st.proposal = { ...c, base, typed: String(value) }; update(); return false; }
    st.proposal = null;
    const pair = accentPatch(c.hex, base, stored); // null: the studio's own accent, which is nothing stored
    const look = { ...effective() };
    if (pair) look.accent = pair; else delete look.accent;
    return save({ accent: pair }, look);
  }

  // ---------- accent ----------
  const pick = el('input.look-pick', { type: 'color', name: 'look-accent', 'aria-label': 'Pick an accent colour', title: 'Pick an accent colour' });
  const hex = input({ name: 'look-accent-hex', class: 'mono look-hex', maxLength: 7, spellcheck: false, autocomplete: 'off', autocapitalize: 'off', placeholder: '#d6a455…', 'aria-label': 'Accent as a hex colour' });
  const presets = el('div.look-swatches', { role: 'group', 'aria-label': 'Accent presets' });
  const boardLabel = el('span.look-sub');
  const boardSwatches = el('div.look-swatches', { role: 'group' });
  const boardRow = el('div.look-board', boardLabel, boardSwatches);
  const accentNote = el('p.look-note', { 'aria-live': 'polite' });
  // While a colour is dragged in the picker it shows on the page as soon as it passes; nothing is saved until it is let go.
  // At most one preview every 40 ms, the first at once and the last always: a timer, not an animation frame, because
  // a window that does not paint may never get a frame.
  function previewPick() {
    st.previewed = performance.now();
    const stored = facts()?.effective || {};
    const c = accentCheck(pick.value, themeNow(), accentGrounds(stored, themeNow()));
    st.proposal = c.ok ? null : { ...c, base: themeNow(), typed: pick.value };
    app.previewLook(c.ok ? { ...stored, accent: accentPair(c.hex, themeNow(), stored) } : null);
    update({ keepPick: true });
  }
  pick.addEventListener('input', () => {
    clearTimeout(st.timer);
    const wait = 40 - (performance.now() - st.previewed);
    if (wait <= 0) previewPick(); else st.timer = setTimeout(previewPick, wait);
  });
  pick.addEventListener('change', () => { clearTimeout(st.timer); chooseAccent(pick.value); });
  hex.addEventListener('input', () => { st.typing = true; }); // half a hex is the person's: a redraw leaves it alone
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chooseAccent(hex.value); } });
  hex.addEventListener('change', () => { if (hex.value.trim() && normHex(hex.value) !== accentOf(effective(), themeNow())) chooseAccent(hex.value); });

  function swatch({ hex: color, name }, base, pressed) {
    const label = name ? `${name}, ${color}` : color;
    const node = el('button.look-swatch', { type: 'button', title: label, 'aria-label': `Accent ${label}`, 'aria-pressed': String(pressed), disabled: frozen(), onclick: () => chooseAccent(color, base) });
    node.style.setProperty('--sw', color); // a custom property is set by name; assigning it as a style field does nothing
    return node;
  }

  // The colours of the person's Studio look board: the studio's own look, never the open project's app board.
  async function loadBoard() {
    const seq = ++st.boardSeq;
    try {
      const out = await app.api.lookBoard();
      if (st.gone || seq !== st.boardSeq) return;
      st.board = boardColors(out.cards);
      st.boardRead = true;
    } catch { if (st.gone || seq !== st.boardSeq) return; st.board = []; st.boardRead = false; } // no board to offer; the presets and the picker stand
    update();
  }

  // ---------- the choices ----------
  const choices = Object.fromEntries(PANEL_KEYS.map((key) => {
    const c = CONTROLS[key];
    const id = `look-${key}`;
    const buttons = Object.entries(c.options).map(([value, o]) => el('button', { type: 'button', dataset: { v: value }, onclick: () => { if (optionOf(effective(), key) !== value) setChoice(key, value === c.def ? null : value); } }, o.label));
    const seg = el('div.seg', { role: 'group', 'aria-labelledby': id }, buttons);
    const node = el('div.field', { dataset: { look: key } }, el('span.look-label', { id }, c.label), el('div', seg), el('div.hint', c.hint));
    return [key, { node, buttons }];
  }));
  const motionNote = el('p.look-lock', { hidden: true }, 'Your system asks for reduced motion, so motion is off whichever is chosen here.');
  choices.motion.node.append(motionNote);

  const reset = button('Reset to defaults', { onclick: async () => {
    const before = facts()?.stored || {};
    st.proposal = null;
    if (!(await save(null, {}))) return;
    toast('Appearance is back to the studio\'s defaults', { tone: 'ok', timeout: 6000, action: { label: 'Undo', run: () => save(restorePatch(before), null) } });
  } });
  const older = el('p.note', { hidden: true }, OLDER, ' ', button('Restart the studio', { small: true, onclick: () => app.restart() }));
  const lockP = el('p.look-lock', { hidden: true });
  const fromLook = el('p.look-lock', { hidden: true });

  clear(host,
    el('p.meta.look-intro', INTRO), older, lockP, fromLook,
    el('div.look',
      el('div.field', { dataset: { look: 'accent' } }, el('span.look-label', { id: 'look-accent' }, CONTROLS.accent.label),
        el('div.look-accent', pick, hex, presets), boardRow, accentNote),
      PANEL_KEYS.map((key) => choices[key].node)),
    el('div.row', reset));

  const openLook = () => { location.hash = '#/inspiration/look'; };

  /** Bring every control to what is in effect now. keepPick: the picker is being dragged, so its value is the person's. */
  function update({ keepPick = false } = {}) {
    if (st.gone) return;
    const f = facts();
    const theme = themeNow();
    const look = effective();
    older.hidden = !!f;
    // One line when the look differs from a locked default of the studio's source (decision row 186).
    const line = f?.rulesUnread ? `${f.rulesProject?.name || 'The studio project'}'s fixed rules could not be read, so whether your look differs from a locked default is not known.` : lockLine(lockDiffs(look, f?.locked || [], theme), f?.rulesProject?.name || '');
    lockP.hidden = !line;
    lockP.textContent = line;
    const stored = f?.stored || {};
    fromLook.hidden = !(stored.surfaces || stored.display);
    if (!fromLook.hidden) clear(fromLook, `The surfaces${stored.display ? ` and the display font (${FONTS[optionOf(stored, 'display')].label})` : ''} come from Inspiration › Studio look.`, ' ', button('Open Studio look', { small: true, variant: 'quiet', onclick: openLook }));

    // Accent: the colour in effect in the theme on screen, the presets, the board's colours, the line under them.
    const current = accentOf(look, theme);
    const off = frozen();
    if (!keepPick) pick.value = st.proposal?.hex || current;
    if (!st.typing) hex.value = st.proposal ? st.proposal.typed : keepPick ? pick.value : current;
    pick.disabled = off; hex.disabled = off;
    const chosenDark = accentOf(look, 'dark');
    const held = presets.contains(document.activeElement) ? document.activeElement.title : null;
    clear(presets, ACCENT_PRESETS.map((p) => swatch(p, 'dark', !st.proposal && chosenDark === p.hex)));
    if (held) [...presets.children].find((b) => b.title === held)?.focus();
    boardRow.hidden = !st.boardRead;
    if (st.boardRead) {
      const heldBoard = boardSwatches.contains(document.activeElement) ? document.activeElement.title : null;
      boardLabel.textContent = st.board.length ? 'From your Studio look board' : 'Color cards on your Studio look board (Inspiration) show here as presets; it has none yet.';
      boardSwatches.setAttribute('aria-label', 'Colors from your Studio look board');
      clear(boardSwatches, st.board.map((c) => swatch(c, theme, !st.proposal && current === c.hex)));
      if (heldBoard) [...boardSwatches.children].find((b) => b.title === heldBoard)?.focus();
    }
    const p = st.proposal;
    accentNote.hidden = !f;
    accentNote.className = p ? 'look-note note warn' : 'look-note';
    const says = p ? { words: p.sentence, nearest: p.nearest, base: p.base } : { ...accentWords(look, theme), base: theme };
    clear(accentNote, el('span', says.words), says.nearest && !off ? button(`Use ${says.nearest}`, { small: true, onclick: () => chooseAccent(says.nearest, says.base) }) : null);

    for (const key of PANEL_KEYS) {
      const { buttons } = choices[key];
      const value = optionOf(look, key);
      for (const b of buttons) { b.setAttribute('aria-pressed', String(b.dataset.v === value)); b.disabled = frozen(); }
    }
    motionNote.hidden = !reduced?.matches;
    reset.disabled = !f || !isCustom(f.stored);
    reset.title = reset.disabled && f ? 'Every choice is already at its default' : '';
  }

  const offs = [
    app.on('studio', () => update()),
    app.on('layout', () => update()), // the theme: the accent is a shade per theme
    app.on('studio-look', loadBoard),
  ];
  const onReduced = () => update();
  reduced?.addEventListener?.('change', onReduced);
  update();
  loadBoard();

  return {
    update,
    unmount() { st.gone = true; clearTimeout(st.timer); offs.forEach((off) => off()); reduced?.removeEventListener?.('change', onReduced); if (app.state.lookPreview) app.previewLook(null); },
  };
}
