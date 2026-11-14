// Settings › Appearance (docs/DESIGN.md section 12, docs/ARCHITECTURE.md section 24): the person's own look for the
// studio. Accent (a picker, a hex field, presets, the colour cards of the open project's Inspiration board), density,
// text size, corners, motion, and Reset to defaults. A choice shows at once and is saved through the settings route,
// which checks it again; what the server kept is what stays on screen. A control whose token a fixed rule of the
// studio project locks is disabled, with the rule named beside it. The nodes are built once and updated in place,
// so the button that was pressed keeps the focus.
import { el, clear, button, input, toast, toastError } from './ui.js';
import { CONTROLS, CHOICE_KEYS, ACCENT_PRESETS, AA_TEXT, accentCheck, accentPair, accentPatch, accentOf, optionOf, isCustom, lockSentence, normHex, nearestPassing, ratioWords, contrast, CANVAS } from './appearance-model.js';

const INTRO = 'How the studio looks on this computer. A change shows at once and is kept in your studio settings, never in a project.';
const OLDER = 'This studio server started before the appearance settings existed, so it cannot keep them yet. Restart it to load the new code (Ctrl+Alt+R).';
export const BOARD_MAX = 12;
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
  const ratio = contrast(hex, CANVAS[theme]);
  if (ratio >= AA_TEXT) return { words: `${hex} is ${ratioWords(ratio)} against the ${theme} canvas (text in the accent needs ${AA_TEXT}:1). The ${other} theme shows ${accentOf(appearance, other)}.`, nearest: null };
  const nearest = nearestPassing(hex, CANVAS[theme]);
  return { words: `${hex}, the studio's own ${theme} accent, is ${ratioWords(ratio)} against the ${theme} canvas, under the ${AA_TEXT}:1 that text in the accent needs. The nearest shade that passes is ${nearest}.`, nearest };
}

/** Mount the section's body in host. Returns { update(), unmount() }. */
export function mountAppearance(host, app) {
  const st = { gone: false, proposal: null, typing: false, board: [], boardPid: null, boardSeq: 0, timer: 0, previewed: 0 };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  const facts = () => app.state.appearance;
  const effective = () => app.state.lookPreview || facts()?.effective || {};
  const lockOf = (key) => facts()?.locks?.[key] || null;
  const frozen = (key) => !facts() || !!facts().rulesUnread || !!lockOf(key);

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
    const c = accentCheck(value, base);
    if (!c.ok) { app.previewLook(null); st.proposal = { ...c, base, typed: String(value) }; update(); return false; }
    st.proposal = null;
    const pair = accentPatch(c.hex, base); // null: the studio's own accent, which is nothing stored
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
  const accentLock = el('p.look-lock', { hidden: true });
  // While a colour is dragged in the picker it shows on the page as soon as it passes; nothing is saved until it is let go.
  // At most one preview every 40 ms, the first at once and the last always: a timer, not an animation frame, because
  // a window that does not paint may never get a frame.
  function previewPick() {
    st.previewed = performance.now();
    const c = accentCheck(pick.value, themeNow());
    st.proposal = c.ok ? null : { ...c, base: themeNow(), typed: pick.value };
    app.previewLook(c.ok ? { ...(facts()?.effective || {}), accent: accentPair(c.hex, themeNow()) } : null);
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
    const node = el('button.look-swatch', { type: 'button', title: label, 'aria-label': `Accent ${label}`, 'aria-pressed': String(pressed), disabled: frozen('accent'), onclick: () => chooseAccent(color, base) });
    node.style.setProperty('--sw', color); // a custom property is set by name; assigning it as a style field does nothing
    return node;
  }

  async function loadBoard() {
    const pid = app.projectId();
    const seq = ++st.boardSeq;
    if (!pid) { st.board = []; st.boardPid = null; return update(); }
    try {
      const out = await app.api.inspiration(pid);
      if (st.gone || seq !== st.boardSeq) return;
      st.board = boardColors(out.cards);
    } catch { if (st.gone || seq !== st.boardSeq) return; st.board = []; } // no board to offer; the presets and the picker stand
    st.boardPid = pid;
    update();
  }

  // ---------- the choices ----------
  const choices = Object.fromEntries(CHOICE_KEYS.map((key) => {
    const c = CONTROLS[key];
    const id = `look-${key}`;
    const buttons = Object.entries(c.options).map(([value, o]) => el('button', { type: 'button', dataset: { v: value }, onclick: () => { if (optionOf(effective(), key) !== value) setChoice(key, value === c.def ? null : value); } }, o.label));
    const seg = el('div.seg', { role: 'group', 'aria-labelledby': id }, buttons);
    const note = el('p.look-lock', { hidden: true });
    const node = el('div.field', { dataset: { look: key } }, el('span.look-label', { id }, c.label), el('div', seg), el('div.hint', c.hint), note);
    return [key, { node, buttons, note }];
  }));
  const motionNote = el('p.look-lock', { hidden: true }, 'Your system asks for reduced motion, so motion is off whichever is chosen here.');
  choices.motion.node.append(motionNote);

  const reset = button('Reset to defaults', { onclick: async () => {
    const before = facts()?.stored || {};
    st.proposal = null;
    if (!(await save(null, {}))) return;
    toast('Appearance is back to the studio\'s defaults', { tone: 'ok', timeout: 6000, action: { label: 'Undo', run: () => save(before, null) } });
  } });
  const older = el('p.note', { hidden: true }, OLDER, ' ', button('Restart the studio', { small: true, onclick: () => app.restart() }));
  const unread = el('p.note.warn', { hidden: true });

  clear(host,
    el('p.meta.look-intro', INTRO), older, unread,
    el('div.look',
      el('div.field', { dataset: { look: 'accent' } }, el('span.look-label', { id: 'look-accent' }, CONTROLS.accent.label),
        el('div.look-accent', pick, hex, presets), boardRow, accentNote, accentLock),
      CHOICE_KEYS.map((key) => choices[key].node)),
    el('div.row', reset));

  function lockNote(node, key) {
    const lock = lockOf(key);
    node.hidden = !lock;
    if (!lock) return;
    const project = facts().rulesProject;
    clear(node, lockSentence(key, lock, project?.name || ''), ' ',
      project ? button('Show the rule', { small: true, variant: 'quiet', title: `Open ${project.name}'s fixed rules`, onclick: async () => { await app.selectProject(project.id); location.hash = '#/inspiration/rules'; } }) : null);
  }

  /** Bring every control to what is in effect now. keepPick: the picker is being dragged, so its value is the person's. */
  function update({ keepPick = false } = {}) {
    if (st.gone) return;
    const f = facts();
    const theme = themeNow();
    const look = effective();
    older.hidden = !!f;
    unread.hidden = !f?.rulesUnread;
    if (f?.rulesUnread) unread.textContent = `${f.rulesProject?.name || 'The studio project'}'s fixed rules could not be read, so the look cannot change until they can: a rule may lock what a change would touch.`;

    // Accent: the colour in effect in the theme on screen, the presets, the board's colours, the line under them.
    const current = accentOf(look, theme);
    const off = frozen('accent');
    if (!keepPick) pick.value = st.proposal?.hex || current;
    if (!st.typing) hex.value = st.proposal ? st.proposal.typed : keepPick ? pick.value : current;
    pick.disabled = off; hex.disabled = off;
    const chosenDark = accentOf(look, 'dark');
    const held = presets.contains(document.activeElement) ? document.activeElement.title : null;
    clear(presets, ACCENT_PRESETS.map((p) => swatch(p, 'dark', !st.proposal && chosenDark === p.hex)));
    if (held) [...presets.children].find((b) => b.title === held)?.focus();
    const name = app.state.projects.find((p) => p.id === st.boardPid)?.name || '';
    boardRow.hidden = !st.boardPid;
    if (st.boardPid) {
      const heldBoard = boardSwatches.contains(document.activeElement) ? document.activeElement.title : null;
      boardLabel.textContent = st.board.length ? `From ${name}'s board` : `Color cards on ${name}'s Inspiration board show here as presets; it has none yet.`;
      boardSwatches.setAttribute('aria-label', `Colors from ${name}'s Inspiration board`);
      clear(boardSwatches, st.board.map((c) => swatch(c, theme, !st.proposal && current === c.hex)));
      if (heldBoard) [...boardSwatches.children].find((b) => b.title === heldBoard)?.focus();
    }
    lockNote(accentLock, 'accent');
    const p = st.proposal;
    accentNote.hidden = !f || (!!lockOf('accent') && !p);
    accentNote.className = p ? 'look-note note warn' : 'look-note';
    const says = p ? { words: p.sentence, nearest: p.nearest, base: p.base } : { ...accentWords(look, theme), base: theme };
    clear(accentNote, el('span', says.words), says.nearest && !off ? button(`Use ${says.nearest}`, { small: true, onclick: () => chooseAccent(says.nearest, says.base) }) : null);

    for (const key of CHOICE_KEYS) {
      const { buttons, note } = choices[key];
      const value = optionOf(look, key);
      for (const b of buttons) { b.setAttribute('aria-pressed', String(b.dataset.v === value)); b.disabled = frozen(key); }
      lockNote(note, key);
    }
    motionNote.hidden = !reduced?.matches;
    reset.disabled = !f || !isCustom(f.stored);
    reset.title = reset.disabled && f ? 'Every choice is already at its default' : '';
  }

  const offs = [
    app.on('studio', () => update()),
    app.on('layout', () => update()), // the theme: the accent is a shade per theme
    app.on('project-switch', loadBoard),
    app.on('bundle', () => { if (app.projectId() !== st.boardPid) loadBoard(); }),
    app.on('inspiration', (d) => { if (!d?.projectId || d.projectId === app.projectId()) loadBoard(); }),
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
