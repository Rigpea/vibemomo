// The task inspector (DESIGN.md section 8): one task in focus at the top of the right panel, as the reference's "Task
// inspector". Its state as a word with a dot (the panel head shows it), "<project> / task <id>" with the elapsed time
// while a session runs it, the title in the display face, who runs it (brainLine), the intent (intentLine), then
// Activity | Output and Follow run · Ask Claude. The task in focus is the one a session runs now, else the one the
// person picked (a tap on a row's "Inspect"), else the newest. Everything shown comes from the task record and the
// session's own events (task-activity.js); nothing is summarised or invented.
import { el, clear, button, chip, ago } from './ui.js';
import { createActivity } from './task-activity.js';
import { sessionBrainLine, clock, intentLine } from './companion-words.js';
import { taskState } from './status-words.js';
import { markdown } from './markdown.js';

/**
 * sourceOf(t): the task's Activity source as task-list.js reads it (null, { terminal: true } or { id, running }).
 * onFollow(sessionId, t): open the session in the Claude Code view. onAsk(): the band's composer.
 */
export function createTaskInspector(app, { sourceOf, onFollow, onAsk }) {
  const activity = createActivity(app);
  const chipSlot = el('span.insp-chip');
  const ref = el('span.insp-ref');
  const when = el('span.insp-when');
  const title = el('h2.insp-title');
  const who = el('p.meta.insp-who');
  const intent = el('p.insp-intent');
  const tabs = el('div.insp-tabs', { role: 'tablist', 'aria-label': 'Activity or output' });
  const body = el('div.insp-body');
  const actions = el('div.insp-actions');
  const node = el('section.inspector', { 'aria-label': 'Task inspector', hidden: true }, el('div.insp-line', ref, when), title, who, intent, tabs, body, actions);
  let tab = 'activity';
  let picked = null; // a task id the person chose
  let task = null; // the task in focus
  let tasks = [];
  let timer = null;

  function choose(list) {
    const running = list.find((t) => sourceOf(t)?.running);
    if (running) return running;
    const chosen = picked ? list.find((t) => t.id === picked) : null;
    return chosen || list[0] || null;
  }

  function update(list = []) {
    tasks = list;
    task = choose(list);
    node.hidden = !task;
    if (!task) { clear(chipSlot); stopClock(); return; }
    render();
  }

  function render() {
    const t = task;
    const source = sourceOf(t);
    const rec = source?.id ? activity._recs.get(source.id) : null;
    const name = app.state.bundle?.project?.name || 'Project';
    clear(chipSlot, chip(taskState(t)));
    ref.textContent = `${name} / task ${t.id}`;
    renderWhen(rec, source);
    title.textContent = t.title;
    who.textContent = source?.terminal ? 'Claude Code · in a terminal · your login' : rec?.session ? sessionBrainLine(rec.session) : source ? 'Reading the session…' : 'No session yet';
    const line = typeof t.intent === 'string' || t.intent === null ? t.intent || null : intentLine(t);
    intent.hidden = !line;
    intent.textContent = line || '';
    const focused = tabs.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
    clear(tabs, [['activity', 'Activity'], ['output', 'Output']].map(([k, words]) => el('button', { type: 'button', role: 'tab', dataset: { tab: k }, 'aria-selected': String(tab === k), onclick: () => { tab = k; render(); } }, words)));
    if (focused) tabs.querySelector(`[data-tab="${focused}"]`)?.focus();
    clear(body, tab === 'activity' ? activityNodes(t, source) : outputNodes(rec));
    clear(actions,
      source?.id ? button('Follow run', { small: true, title: 'Open this session in the Claude Code view', onclick: () => onFollow?.(source.id, t) }) : null,
      button('Ask Claude', { small: true, variant: 'quiet', title: 'Write to the companion in the band below about this', onclick: () => onAsk?.(t) }));
    tickClock(rec);
  }

  function activityNodes(t, source) {
    activity.begin();
    const n = activity.node(t, source);
    activity.end();
    if (!n) return el('p.meta', 'No session has run this task yet. Hand it over from its row below.');
    if (n.tagName?.toLowerCase?.() === 'details' || n.spec?.startsWith?.('details')) { n.open = true; n.classList?.add?.('insp-open'); }
    return n;
  }

  function outputNodes(rec) {
    const turns = rec?.session?.turns || [];
    const last = [...turns].reverse().find((x) => x.role !== 'user' && x.text);
    if (!rec?.session) return el('p.meta', rec?.loading ? 'Reading the session…' : 'Open Activity first: the output is read with the session.');
    if (!last) return el('p.meta', rec.running ? 'No answer yet.' : 'The session wrote no answer.');
    return el('div.insp-output', markdown(last.text, 'prose'), el('p.meta', `${rec.session.backend === 'codex' ? 'Codex' : 'Claude Code'} · ${ago(last.at)}`));
  }

  function renderWhen(rec, source) {
    if (rec?.running && rec.live?.startedAt) when.textContent = clock(Date.now() - rec.live.startedAt);
    else when.textContent = task?.updatedAt ? `updated ${ago(task.updatedAt)}` : '';
  }
  function tickClock(rec) {
    stopClock();
    if (rec?.running) timer = setInterval(() => { const r = task && sourceOf(task)?.id ? activity._recs.get(sourceOf(task).id) : null; if (!r?.running) { stopClock(); renderWhen(r); return; } renderWhen(r); }, 1000);
  }
  function stopClock() { if (timer) { clearInterval(timer); timer = null; } }

  // A record read after the first draw (the Activity reads lazily): draw the who line and the output again.
  const off = typeof app.on === 'function' ? app.on('console', () => { if (task) render(); }) : null;

  return {
    node,
    /** The state chip for the panel head. */
    chip: chipSlot,
    update,
    /** The person chose a task: it is the one in focus unless a session runs another. */
    pick(id) { picked = id; update(tasks); },
    task: () => task,
    /** The Activity rows are read lazily; a record arriving redraws (the list calls this when its sessions change). */
    refresh() { if (task) render(); },
    destroy() { stopClock(); off?.(); activity.destroy(); },
  };
}
