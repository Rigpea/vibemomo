// Fixed rules (docs/DESIGN.md section 11, docs/ARCHITECTURE.md section 23): the part of the Inspiration view that
// holds what must stay the same in the open project's design. The rules by kind, each one sentence with the token it
// locks and why; Add rule and Edit open one dialog, Remove asks once. The records are the server's
// (.studio/rules.json), so every change is sent and the list is read again; a refusal is the server's sentence.
// views/inspiration.js mounts it beside the board and places its Add button and its count in the view's head.
import { el, clear, button, empty, errorBox, loading, toast, toastError, confirmDialog } from './ui.js';
import { ruleDialog } from './rules-edit.js';
import { olderServer } from './skills-panel.js';
import { kindWord, groupRules, shownOrder, countWords, tokenWords, swatchOf, ruleName, removeWords, EMPTY_WORDS } from './rules-words.js';

/**
 * Mount the list in host. opts.onChange() runs whenever the rules or their count may have changed (the view's head
 * shows them). Returns { addButton, count(), words(), sync(), unmount() }: count() is the number of rules or null
 * while they are not read; words() the count line for the head.
 */
export function mountRules(host, app, { onChange = () => {} } = {}) {
  const list = el('div.rules-cols');
  const fill = el('div.rules-fill', { hidden: true });
  clear(host, fill, list);
  const st = { pid: null, rules: null, kinds: [], limits: {}, error: null, snapshot: null, seq: 0, timer: null, gone: false };
  const projectName = () => app.state.projects.find((p) => p.id === st.pid)?.name || '';
  const addButton = button('Add rule', { variant: 'primary', title: 'Add something that must stay the same in this project\'s design', onclick: () => edit(null) });

  function sync() {
    const pid = app.projectId();
    if (pid === st.pid) return;
    Object.assign(st, { pid, rules: null, error: null, snapshot: null });
    render();
    if (pid) load();
  }

  async function load({ focusId = null } = {}) {
    const pid = st.pid;
    if (!pid) return;
    const seq = ++st.seq;
    try {
      const out = await app.api.rules(pid);
      if (st.gone || st.pid !== pid || seq !== st.seq) return;
      const snapshot = JSON.stringify(out.rules || []);
      // The list as it already stands (the echo of this window's own change): the nodes and the focus stay.
      const same = !st.error && st.rules !== null && snapshot === st.snapshot;
      Object.assign(st, { rules: out.rules || [], kinds: out.kinds || [], limits: out.limits || {}, error: null, snapshot });
      if (same) return focusRule(focusId);
    } catch (err) {
      if (st.gone || st.pid !== pid || seq !== st.seq) return;
      Object.assign(st, { error: err, snapshot: null });
    }
    render({ focusId });
  }

  /** A change someone else made (another window, a hand edit): read again once it has been quiet. */
  function later() {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (!st.gone) load(); }, 150);
  }

  function focusRule(id) {
    const node = id ? list.querySelector(`[data-rule="${id}"]`) : null;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
  }

  async function edit(rule) {
    const pid = st.pid;
    if (!pid || st.rules === null) return;
    const saved = await ruleDialog(rule, { kinds: st.kinds, limits: st.limits, save: (patch) => (rule ? app.api.patchRule(pid, rule.id, patch) : app.api.addRule(pid, patch)) });
    if (saved && !st.gone && st.pid === pid) load({ focusId: saved.id });
  }

  async function remove(rule) {
    const pid = st.pid;
    const ok = await confirmDialog({ title: 'Remove rule', message: removeWords(rule, projectName()), confirm: 'Remove', variant: 'danger', cancel: 'Keep it' });
    if (!ok || st.gone || st.pid !== pid) return;
    const ids = shownOrder(st.rules, st.kinds);
    const next = ids[ids.indexOf(rule.id) + 1] || ids[ids.indexOf(rule.id) - 1] || null;
    try {
      await app.api.removeRule(pid, rule.id);
      toast(`Removed: ${rule.text}`, { tone: 'ok', timeout: 2500, clears: 'Fixed rules' });
      if (!st.gone && st.pid === pid) { await load({ focusId: next }); if (!next) addButton.focus(); }
    } catch (err) { toastError(err, 'Fixed rules'); if (!st.gone && st.pid === pid) load(); }
  }

  /** One rule: its sentence, the token it locks, why. The item takes the focus itself: Enter edits, Delete removes. */
  function ruleNode(rule) {
    const li = el('li.rule', { tabindex: '0', dataset: { rule: rule.id }, 'aria-label': ruleName(rule), 'aria-keyshortcuts': 'Enter Delete' });
    const body = el('div.rule-body', el('p.rule-text', rule.text));
    if (rule.token) {
      const color = swatchOf(rule.token.value);
      const code = el('code.rule-code', tokenWords(rule.token));
      code.setAttribute('translate', 'no'); // a declaration, not words
      body.append(el('p.rule-token', { title: `This rule locks ${rule.token.name} at this value` }, el('span.rule-locks', 'Locks'), color ? el('span.rules-swatch', { style: { background: color }, 'aria-hidden': 'true' }) : null, code));
    }
    if (rule.why) body.append(el('p.rule-why', rule.why));
    li.append(body, el('div.rule-actions',
      button('', { icon: 'edit', small: true, variant: 'quiet', title: 'Edit this rule (Enter)', onclick: () => edit(rule) }),
      button('', { icon: 'trash', small: true, variant: 'quiet', title: 'Remove this rule (Delete)', onclick: () => remove(rule) })));
    li.addEventListener('keydown', (e) => {
      if (e.target !== li || e.ctrlKey || e.metaKey || e.altKey) return; // a key inside a control of the rule is that control's
      if (e.key === 'Enter') { e.preventDefault(); edit(rule); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(rule); }
    });
    li.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) edit(rule); });
    return li;
  }

  function render({ focusId = null } = {}) {
    if (st.gone) return;
    addButton.disabled = !st.pid || st.rules === null;
    // A redraw rebuilds the rows: the one that held the focus holds it again.
    const keepId = focusId || list.querySelector('.rule:focus-within')?.dataset.rule || null;
    const show = (node) => { clear(list); list.hidden = true; fill.hidden = false; clear(fill, node); onChange(); };
    if (!st.pid) return show(empty('Create a project first; its fixed rules appear here.'));
    if (st.error && olderServer(st.error)) { // a window newer than the server it talks to
      return show(empty('This studio server started before fixed rules existed, so it has no route for them yet. Restart it to load the new code (Ctrl+Alt+R).', null, button('Restart the studio', { onclick: () => app.restart() })));
    }
    if (st.error) return show(errorBox(st.error, () => load()));
    if (st.rules === null) return show(loading('Reading the rules…'));
    if (!st.rules.length) return show(empty(EMPTY_WORDS));
    fill.hidden = true;
    clear(fill);
    list.hidden = false;
    clear(list, groupRules(st.rules, st.kinds).map((g) => {
      const id = `rules-kind-${g.kind}`;
      return el('section.rules-group', { 'aria-labelledby': id },
        el('h2.overline.rules-kind', { id }, kindWord(g.kind), el('span.rules-n', String(g.rules.length))),
        el('ul.rules-list', g.rules.map(ruleNode)));
    }));
    focusRule(keepId);
    onChange();
  }

  const offs = [
    app.on('project-switch', sync),
    app.on('bundle', sync),
    app.on('rules', (d) => { if (!d?.projectId || d.projectId === st.pid) later(); }),
    app.on('sse', (d) => { if (d?.state === 'open' && d.prev === 'down') load(); }),
  ];
  sync();

  return {
    addButton,
    count: () => (st.rules ? st.rules.length : null),
    words: () => (st.rules ? countWords(projectName(), st.rules) : projectName()),
    sync,
    unmount() { st.gone = true; clearTimeout(st.timer); offs.forEach((off) => off()); },
  };
}
