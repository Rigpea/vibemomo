// The Visualizer (docs/DESIGN.md section 14, docs/ARCHITECTURE.md section 26): the part of the Inspiration view that
// draws the design system the open project really has, read by the server from the stylesheets its web entry loads,
// beside what the person wants: the board's colour cards and the fixed rules. It reads only. The one thing it can
// make is a task (Make it a task), through the task route every task goes through, after the person has read and
// edited its request. views/inspiration.js mounts it and places its two buttons and its count in the view's head.
import { el, clear, button, textarea, field, empty, errorBox, loading, toast, toastError, dialog } from './ui.js';
import { olderServer } from './skills-panel.js';
import { drawDesign } from './visualizer-draw.js';
import { headWords, taskRequest, itemName, placeRef, placeFull, placeWhat, countWords, lockState, EMPTY_SHEETS, NO_ENTRY_HINT } from './visualizer-words.js';

/**
 * Mount the part in host. opts.onChange() runs whenever what the head shows may have changed. Returns
 * { taskButton, readButton, words(), sync(), show(on), unmount() }: show(true) when the part comes on screen, so it
 * reads the files again (they change without the studio hearing of it).
 */
export function mountVisualizer(host, app, { onChange = () => {} } = {}) {
  const body = el('div.viz-cols');
  const fill = el('div.viz-fill', { hidden: true });
  clear(host, el('div.viz-scroll', fill, body));
  const st = { pid: null, answer: null, error: null, snapshot: null, seq: 0, timer: null, gone: false, shown: false, busy: false };
  const projectName = () => app.state.projects.find((p) => p.id === st.pid)?.name || '';
  const taskButton = button('Make it a task', { title: 'Write a task that tidies the drift; you read and edit it before it is made', onclick: () => makeTask() });
  const readButton = button('', { icon: 'refresh', variant: 'quiet', title: 'Read the stylesheets again', onclick: () => load() });

  function sync() {
    const pid = app.projectId();
    if (pid === st.pid) return;
    Object.assign(st, { pid, answer: null, error: null, snapshot: null });
    render();
    if (pid && st.shown) load();
  }

  async function load() {
    const pid = st.pid;
    if (!pid) return;
    const seq = ++st.seq;
    st.busy = true;
    readButton.disabled = true;
    try {
      const answer = await app.api.visualizer(pid);
      if (st.gone || st.pid !== pid || seq !== st.seq) return;
      const snapshot = JSON.stringify(answer);
      // The files as they already stand on screen: nothing is redrawn, so the scroll and the focus stay.
      const same = !st.error && st.answer !== null && snapshot === st.snapshot;
      Object.assign(st, { answer, error: null, snapshot });
      if (same) return;
    } catch (err) {
      if (st.gone || st.pid !== pid || seq !== st.seq) return;
      Object.assign(st, { error: err, snapshot: null });
    } finally {
      if (seq === st.seq) { st.busy = false; readButton.disabled = false; }
    }
    render();
  }

  /** A rule or a card changed (this window, another one, the companion): read again once it has been quiet. */
  function later() {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (!st.gone && st.shown) load(); }, 150);
  }

  const open = (place) => app.openSource({ path: place.file, line: place.line || null });

  /** Where one value is set and used: its definitions, then every place read, each a button into the Source tab. */
  function places(item) {
    const go = (close, place) => { close(); open(place); };
    const lock = st.answer?.locks?.[item.name];
    const content = (close) => {
      const row = (place, what) => el('li.viz-place', button(placeRef(place), { small: true, variant: 'quiet', class: 'mono viz-src', title: `Open ${placeFull(place)} in the Source tab`, onclick: () => go(close, place) }), what);
      const code = (text) => { const n = el('span.mono.viz-what', text); n.setAttribute('translate', 'no'); return n; };
      const out = [];
      if (item.kind === 'token') {
        out.push(el('h3.viz-sub', 'Set', el('span.viz-n', String(item.defs.length))),
          el('ul.viz-places', item.defs.map((d) => row(d, [el('span.viz-chip.sm', { style: { backgroundColor: d.canon }, 'aria-hidden': 'true' }), code(`${d.scope} { ${item.name}: ${d.value} }`)]))));
        if (lock) out.push(el('p.viz-note', `Locked at ${lock.value} by the rule "${lock.text}": ${lockState(lock.state).word.toLowerCase()}.`));
      }
      const shown = item.places || [];
      out.push(el('h3.viz-sub', item.kind === 'token' ? 'Read' : 'Written', el('span.viz-n', String(item.count))),
        shown.length ? el('ul.viz-places', shown.map((p) => row(p, code(placeWhat(p))))) : el('p.viz-none', 'No stylesheet read here reads it.'));
      if (item.count > shown.length) out.push(el('p.viz-none', `and ${item.count - shown.length} more, not listed`));
      return el('div.viz-detail', out);
    };
    dialog({ title: itemName(item), wide: true, body: content, actions: [{ label: 'Close', variant: 'primary' }] });
  }

  /** The task that tidies the drift: its request is shown first and is the person's to edit; nothing is made before Create. */
  function makeTask() {
    const pid = st.pid;
    const draft = st.answer ? taskRequest(projectName(), st.answer) : null;
    if (!pid || !draft) return;
    const text = textarea({ name: 'visualizer-task', rows: 16, value: draft.request, 'aria-label': 'The request of the task', spellcheck: false });
    const reason = el('p.note.danger', { role: 'alert', hidden: true });
    const create = async (close) => {
      const request = text.value.trim();
      if (!request) { reason.hidden = false; clear(reason, 'The task needs a request.'); text.focus(); return; }
      const base = { request, title: draft.title, mode: 'handle', files: draft.files, acceptance: ['Every listed value is moved to the scale or a custom property, or the result says why it stays', 'No fixed rule is broken; a locked token keeps its value'] };
      try {
        let task;
        try { task = await app.api.createTask(pid, { ...base, department: 'Design' }); } // the studio may have no Design department: then without one
        catch (err) { if (err.status !== 400 || !/department/i.test(err.message)) throw err; task = await app.api.createTask(pid, base); }
        close(task);
        toast(`Task made: ${task.title}`, { tone: 'ok', timeout: 6000, clears: 'Visualizer', action: { label: 'Open it', run: () => app.showPanel('task', { taskId: task.id }) } });
      } catch (err) { reason.hidden = false; clear(reason, err.message || String(err)); }
    };
    dialog({
      title: 'Make it a task', wide: true,
      body: el('div.viz-task', el('p.hint', `${countWords(draft.count, 'value')} for ${projectName() || 'this project'}. The task is made ready for Claude Code and handed to no one; edit the request first if you like.`), field('Request', text), reason),
      actions: [{ label: 'Cancel', value: false }, { label: 'Create task', variant: 'primary', run: create }],
    });
    text.setSelectionRange(0, 0); // the request is read from its first line
    text.scrollTop = 0;
  }

  function render() {
    if (st.gone) return;
    const a = st.answer;
    taskButton.disabled = !a || !taskRequest('', a);
    taskButton.title = taskButton.disabled && a ? 'Nothing drifts and no lock is broken' : 'Write a task that tidies the drift; you read and edit it before it is made';
    const show = (node) => { clear(body); body.hidden = true; fill.hidden = false; clear(fill, node); onChange(); };
    if (!st.pid) return show(empty('Create a project first; its design system is drawn here.'));
    if (st.error && olderServer(st.error)) { // a window newer than the server it talks to
      return show(empty('This studio server started before the Visualizer existed, so it has no route for it yet. Restart it to load the new code (Ctrl+Alt+R).', null, button('Restart the studio', { onclick: () => app.restart() })));
    }
    if (st.error) return show(errorBox(st.error, () => load()));
    if (a === null) return show(loading('Reading the stylesheets…'));
    if (!a.entry) return show(empty(a.reason || 'This project has no web entry.', NO_ENTRY_HINT));
    if (!a.sheets.length) return show(empty(EMPTY_SHEETS, (a.skipped || []).map((s) => `${s.href}: ${s.reason}`).join(' · ') || null));
    fill.hidden = true;
    clear(fill);
    body.hidden = false;
    clear(body, drawDesign(a, { open, places, limits: a.limits || {}, locks: a.locks || {}, goto: (hash) => { location.hash = hash; } }));
    onChange();
  }

  const onFocus = () => { if (st.shown && !st.busy && !document.querySelector('dialog[open]')) load(); };
  window.addEventListener('focus', onFocus);
  const offs = [
    app.on('project-switch', sync),
    app.on('bundle', sync),
    app.on('rules', (d) => { if (!d?.projectId || d.projectId === st.pid) later(); }),
    app.on('inspiration', (d) => { if (!d?.projectId || d.projectId === st.pid) later(); }),
    app.on('sse', (d) => { if (d?.state === 'open' && d.prev === 'down' && st.shown) load(); }),
    () => window.removeEventListener('focus', onFocus),
  ];
  sync();

  return {
    taskButton,
    readButton,
    words: () => (st.answer ? headWords(projectName(), st.answer) : projectName()),
    sync,
    /** The part came on screen (true) or left it. Coming on screen reads the files as they are now. */
    show(on) { const was = st.shown; st.shown = !!on; if (on && !was && st.pid) load(); },
    unmount() { st.gone = true; clearTimeout(st.timer); offs.forEach((off) => off()); },
  };
}
