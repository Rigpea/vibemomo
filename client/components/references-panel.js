// References (docs/DESIGN.md section 13, docs/ARCHITECTURE.md section 25): the part of the Inspiration view that holds
// what the open project keeps to build from. A bar with the search and the tags in use, then the entries by kind
// (links, snippets, prompts, notes), each with what to use it for, its tags and where it came from. A prompt and a
// snippet have one Copy button; Add reference and Edit open one dialog; Remove asks once. The records are the
// server's (.studio/references.json), so every change is sent and the list is read again; a refusal is the server's
// sentence. views/inspiration.js mounts it beside the board and the fixed rules and places its Add button and its
// count in the view's head.
import { el, clear, button, input, empty, errorBox, loading, toast, toastError, confirmDialog, copyText } from './ui.js';
import { refDialog } from './references-edit.js';
import { olderServer } from './skills-panel.js';
import { kindWord, groupRefs, shownOrder, filterRefs, tagsInUse, countWords, refName, refLabel, linkMeta, lineCount, clampLines, isLong, moreWords, removeWords, SHOWN_LINES, EMPTY_WORDS, NO_MATCH_WORDS } from './references-words.js';

const kept = new Map(); // project id -> { tag, search }: the filter each project was left on, for this window

/**
 * Mount the list in host. opts.onChange() runs whenever the entries or their count may have changed (the view's head
 * shows them). Returns { addButton, count(), words(), sync(), unmount() }: count() is the number of entries or null
 * while they are not read; words() the count line for the head.
 */
export function mountReferences(host, app, { onChange = () => {} } = {}) {
  const search = input({ type: 'search', name: 'references-search', class: 'refs-search', placeholder: 'Search titles, text and tags…', 'aria-label': 'Search the references', autocomplete: 'off', spellcheck: false });
  const filter = el('div.inspo-filter', { role: 'group', 'aria-label': 'Filter by tag', hidden: true });
  const bar = el('div.refs-bar', search, filter);
  const list = el('div.refs-cols');
  const fill = el('div.refs-fill', { hidden: true });
  const live = el('p.sr-only', { 'aria-live': 'polite' });
  clear(host, bar, live, el('div.refs-scroll', fill, list));
  const st = { pid: null, entries: null, kinds: [], limits: {}, error: null, snapshot: null, seq: 0, timer: null, gone: false, tag: null, search: '', open: new Set() };
  const projectName = () => app.state.projects.find((p) => p.id === st.pid)?.name || '';
  const addButton = button('Add reference', { variant: 'primary', title: 'Add a link, a snippet, a prompt or a note to build from', onclick: () => edit(null) });
  const shown = () => filterRefs(st.entries || [], st);
  const keep = () => { if (st.tag || st.search) kept.set(st.pid, { tag: st.tag, search: st.search }); else kept.delete(st.pid); };

  function sync() {
    const pid = app.projectId();
    if (pid === st.pid) return;
    const was = kept.get(pid) || {};
    Object.assign(st, { pid, entries: null, error: null, snapshot: null, tag: was.tag || null, search: was.search || '', open: new Set() });
    search.value = st.search;
    render();
    if (pid) load();
  }

  async function load({ focusId = null } = {}) {
    const pid = st.pid;
    if (!pid) return;
    const seq = ++st.seq;
    try {
      const out = await app.api.references(pid);
      if (st.gone || st.pid !== pid || seq !== st.seq) return;
      const snapshot = JSON.stringify(out.entries || []);
      // The list as it already stands (the echo of this window's own change): the nodes and the focus stay.
      const same = !st.error && st.entries !== null && snapshot === st.snapshot;
      Object.assign(st, { entries: out.entries || [], kinds: out.kinds || [], limits: out.limits || {}, error: null, snapshot });
      if (same) return focusRef(focusId);
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

  function focusRef(id) {
    const node = id ? list.querySelector(`[data-ref="${id}"]`) : null;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
  }

  async function edit(entry) {
    const pid = st.pid;
    if (!pid || st.entries === null) return;
    const saved = await refDialog(entry, { kinds: st.kinds, limits: st.limits, tags: tagsInUse(st.entries).map((t) => t.tag), save: (patch) => (entry ? app.api.patchReference(pid, entry.id, patch) : app.api.addReference(pid, patch)) });
    if (!saved || st.gone || st.pid !== pid) return;
    // A new entry that the filter in use would hide: the filter lets go, so what was just added is in sight.
    if (!entry && (st.tag || st.search) && !filterRefs([saved], st).length) { Object.assign(st, { tag: null, search: '' }); search.value = ''; keep(); st.snapshot = null; }
    load({ focusId: saved.id });
  }

  async function remove(entry) {
    const pid = st.pid;
    const ok = await confirmDialog({ title: `Remove ${entry.kind}`, message: removeWords(entry, projectName()), confirm: 'Remove', variant: 'danger', cancel: 'Keep it' });
    if (!ok || st.gone || st.pid !== pid) return;
    const ids = shownOrder(shown(), st.kinds);
    const next = ids[ids.indexOf(entry.id) + 1] || ids[ids.indexOf(entry.id) - 1] || null;
    try {
      await app.api.removeReference(pid, entry.id);
      toast(`Removed: ${refName(entry, 60)}`, { tone: 'ok', timeout: 2500, clears: 'References' });
      if (!st.gone && st.pid === pid) { await load({ focusId: next }); if (!next) addButton.focus(); }
    } catch (err) { toastError(err, 'References'); if (!st.gone && st.pid === pid) load(); }
  }

  async function copy(entry) {
    if (await copyText(entry.text)) toast(`Copied the ${entry.kind}: ${refName(entry, 50)}`, { timeout: 2000, clears: 'References' });
    else toastError(new Error(`The ${entry.kind} could not be copied; select its text instead`), 'References');
  }

  /** The text of a snippet, a prompt or a note: a long one shows its first lines and one button for the rest. */
  function textNode(entry) {
    const long = isLong(entry);
    const open = st.open.has(entry.id);
    const code = entry.kind === 'snippet';
    const box = el(code ? 'pre.ref-code' : `p.ref-text${long && !open ? '.clamped' : ''}`, { tabindex: code ? '0' : undefined, role: code ? 'group' : undefined, 'aria-label': code ? `Code of ${refName(entry, 60)}` : undefined }); // a box that scrolls sideways takes the focus, so the keys can scroll it
    const fillBox = () => clear(box, code ? el('code', long && !st.open.has(entry.id) ? clampLines(entry.text, SHOWN_LINES.snippet).text : entry.text) : entry.text);
    fillBox();
    if (code) box.setAttribute('translate', 'no'); // code, not words
    if (!long) return [box];
    const more = button(moreWords(entry, open), { small: true, variant: 'quiet', class: 'ref-more', 'aria-expanded': String(open), onclick: () => {
      const now = !st.open.has(entry.id);
      if (now) st.open.add(entry.id); else st.open.delete(entry.id);
      more.setAttribute('aria-expanded', String(now));
      more.querySelector('span').textContent = moreWords(entry, now);
      if (code) fillBox(); else box.classList.toggle('clamped', !now);
    } });
    return [box, more];
  }

  /** One entry: its name, what it holds, what to use it for, then its tags and where it came from. The item takes
   *  the focus itself: Enter edits, Delete removes. */
  function refNode(entry) {
    const li = el(`li.ref.ref-${entry.kind}`, { tabindex: '0', dataset: { ref: entry.id }, 'aria-label': refLabel(entry), 'aria-keyshortcuts': 'Enter Delete' });
    const main = el('div.ref-main');
    const rest = [];
    if (entry.kind === 'link') {
      main.append(el('a.ref-title', { href: entry.url, target: '_blank', rel: 'noopener noreferrer', title: `${entry.url} (opens in a new tab)` }, entry.title || entry.url), el('p.ref-meta', linkMeta(entry)));
    } else if (entry.title) {
      main.append(el('p.ref-title', entry.title));
      rest.push(...textNode(entry));
    } else {
      main.append(...textNode(entry)); // a note with no title: its words are its name
    }
    if (entry.useFor) rest.push(el('p.ref-use', el('span.ref-label', 'Use it for'), ' ', entry.useFor));
    const facts = [entry.kind === 'snippet' ? [entry.language, `${lineCount(entry.text)} line${lineCount(entry.text) === 1 ? '' : 's'}`].filter(Boolean).join(', ') : null, entry.tags?.length ? entry.tags.join(' · ') : null, entry.source ? `from ${entry.source}` : null].filter(Boolean);
    if (facts.length) rest.push(el('p.ref-meta', facts.join(' · ')));
    const copies = entry.kind === 'prompt' || entry.kind === 'snippet';
    // Copy stands at the row's right edge on every prompt and snippet; Edit and Remove wait to its left.
    li.append(main, el('div.ref-actions',
      el('span.ref-tools',
        button('', { icon: 'edit', small: true, variant: 'quiet', title: `Edit this ${entry.kind} (Enter)`, onclick: () => edit(entry) }),
        button('', { icon: 'trash', small: true, variant: 'quiet', title: `Remove this ${entry.kind} (Delete)`, onclick: () => remove(entry) })),
      copies ? button('Copy', { icon: 'copy', small: true, title: `Copy this ${entry.kind} to the clipboard`, onclick: () => copy(entry) }) : null));
    if (rest.length) li.append(el('div.ref-rest', rest));
    li.addEventListener('keydown', (e) => {
      if (e.target !== li || e.ctrlKey || e.metaKey || e.altKey) return; // a key inside a control of the entry is that control's
      if (e.key === 'Enter') { e.preventDefault(); edit(entry); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(entry); }
    });
    li.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button, pre') && !String(window.getSelection?.() || '')) edit(entry); });
    return li;
  }

  function renderFilter() {
    const tags = tagsInUse(st.entries || []);
    if (st.tag && !tags.some((t) => t.tag === st.tag)) { st.tag = null; keep(); }
    filter.hidden = !tags.length;
    const choose = (tag) => { st.tag = tag; keep(); render(); filter.querySelector('[aria-pressed="true"]')?.focus(); };
    const one = (tag, words, n) => el('button.inspo-filter-tag', { type: 'button', 'aria-pressed': String(st.tag === tag), onclick: () => choose(tag) }, words, el('span.inspo-filter-n', String(n)));
    clear(filter, one(null, 'All', st.entries?.length || 0), tags.map((t) => one(t.tag, t.tag, t.count)));
  }

  /** The entries the search and the tag leave, by kind. The search field is not redrawn, so typing keeps its place. */
  function renderList({ focusId = null } = {}) {
    // A redraw rebuilds the rows: the one that held the focus holds it again.
    const keepId = focusId || list.querySelector('.ref:focus-within')?.dataset.ref || null;
    const found = shown();
    if (!found.length) {
      clear(list); list.hidden = true; fill.hidden = false;
      clear(fill, empty(NO_MATCH_WORDS, null, button('Show all references', { onclick: () => { Object.assign(st, { tag: null, search: '' }); search.value = ''; keep(); render(); search.focus(); } })));
    } else {
      fill.hidden = true; clear(fill); list.hidden = false;
      clear(list, groupRefs(found, st.kinds).map((g) => {
        const id = `refs-kind-${g.kind}`;
        return el('section.refs-group', { 'aria-labelledby': id },
          el('h2.overline.refs-kind', { id }, kindWord(g.kind), el('span.refs-n', String(g.entries.length))),
          el('ul.refs-list', g.entries.map(refNode)));
      }));
      focusRef(keepId);
    }
    onChange();
  }

  function render({ focusId = null } = {}) {
    if (st.gone) return;
    addButton.disabled = !st.pid || st.entries === null;
    const show = (node) => { clear(list); list.hidden = true; bar.hidden = true; fill.hidden = false; clear(fill, node); onChange(); };
    if (!st.pid) return show(empty('Create a project first; its references appear here.'));
    if (st.error && olderServer(st.error)) { // a window newer than the server it talks to
      return show(empty('This studio server started before references existed, so it has no route for them yet. Restart it to load the new code (Ctrl+Alt+R).', null, button('Restart the studio', { onclick: () => app.restart() })));
    }
    if (st.error) return show(errorBox(st.error, () => load()));
    if (st.entries === null) return show(loading('Reading the references…'));
    if (!st.entries.length) return show(empty(EMPTY_WORDS));
    bar.hidden = false;
    renderFilter();
    renderList({ focusId });
  }

  let said = null;
  search.addEventListener('input', () => {
    st.search = search.value;
    keep();
    if (st.entries?.length) renderList();
    // What the search left, for a screen reader, once the typing has stopped.
    clearTimeout(said);
    said = setTimeout(() => { if (!st.gone && st.entries) clear(live, st.search.trim() ? `${shown().length} of ${st.entries.length} references` : ''); }, 600);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; search.dispatchEvent(new Event('input')); } });

  const offs = [
    app.on('project-switch', sync),
    app.on('bundle', sync),
    app.on('references', (d) => { if (!d?.projectId || d.projectId === st.pid) later(); }),
    app.on('sse', (d) => { if (d?.state === 'open' && d.prev === 'down') load(); }),
  ];
  sync();

  return {
    addButton,
    search,
    count: () => (st.entries ? st.entries.length : null),
    words: () => (st.entries ? countWords(projectName(), st.entries.length, shown().length, st) : projectName()),
    sync,
    unmount() { st.gone = true; clearTimeout(st.timer); clearTimeout(said); offs.forEach((off) => off()); },
  };
}
