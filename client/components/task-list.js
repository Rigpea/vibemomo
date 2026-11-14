// Task list + expandable task rows, shared by the collaboration panel and the Tasks view.
import { el, clear, button, chip, stateChip, ago, when, toast, toastError, dialog, confirmDialog, closeDialogsIn, textarea, field, copyText, loading, empty, shortLabel } from './ui.js';
import { markdown } from './markdown.js';
import { taskState, resultVersions, resultOptions, producedWords, madeBeforeCancel, eventWords, splitEvents } from './status-words.js';
import { createActivity } from './task-activity.js';

const OPEN = ['ready', 'working', 'interrupted', 'needs-input'];

/** A task's department as its row and detail say it: "Backend department"; null without one. */
export const departmentWords = (t) => (t?.department?.name ? `${t.department.name} department` : null);

export const MODE_LABELS = {
  teach: 'Teach me this',
  explore: 'Explore alternatives with me',
  handle: 'Handle the implementation',
};

/** Same prompt text the server's openPrompt() hands to Claude Code (server/lib/tasks.mjs). */
export function claudeCommand(app, tid, projectId = app.projectId()) {
  const entry = (projectId === app.projectId() && app.state.bundle?.entry) || app.state.projects.find((p) => p.id === projectId);
  const prompt = `Studio task ${tid}: read .studio/tasks/${tid}/brief.md and carry it out. Begin by running the "task handover" command it lists, then the "task start" command; finish with the "task finish" command.`;
  const dir = entry?.path || '<project folder>';
  // The prompt is wrapped in double quotes for the shell, so inner double quotes become single quotes.
  const safe = prompt.replace(/"/g, "'");
  return app.state.studio?.platform === 'win32' ? `cd /d "${dir}" && claude "${safe}"` : `cd "${dir}" && claude "${safe}"`;
}

/** allProjects: rows come from GET /api/tasks (each carries projectId/projectName) and are
 *  prefixed with their project's name; a row of another project offers only Switch to the
 *  project and Copy command, every other action runs once that project is the active one. */
/** onToggle(tid, open): a row was opened or closed (the task inspector follows the opened one); onRender(): the list drew. */
export function createTaskList(app, { compact = false, showStatus = compact, allProjects = false, onToggle = null, onRender = null } = {}) {
  const expanded = new Set();
  const openEvents = new Set(); // "<tid>" and "<tid>:earlier": every render rebuilds the row, and a note arriving must not close what is being read
  const pidOf = (t) => t?.projectId || app.projectId();
  const elsewhere = (t) => allProjects && !!t?.projectId && t.projectId !== app.projectId();
  const details = new Map(); // tid -> {task, events, brief, versionNames} | {error}
  const detailLoads = new Map(); // tid -> number of the newest request
  const node = el('div.task-list');
  let last = [];
  // Chat sessions that run a task (POST …/tasks/:tid/console sets session.taskId); refreshed lazily.
  let chats = new Map(); // tid -> newest session summary
  let chatsAt = 0;
  let chatsBusy = false;
  const activity = createActivity(app);
  async function refreshChats() {
    const pid = allProjects ? null : app.projectId();
    if ((!pid && !allProjects) || chatsBusy || Date.now() - chatsAt < 1500) return;
    chatsBusy = true;
    try {
      const out = await app.api.consoleSessions(pid);
      const next = new Map();
      for (const ses of (Array.isArray(out) ? out : out.sessions || [])) if (ses.taskId && !next.has(ses.taskId)) next.set(ses.taskId, ses);
      const sig = (m) => [...m].map(([k, x]) => `${k}:${x.id}:${x.status}`).join('|');
      const changed = sig(next) !== sig(chats);
      chats = next;
      chatsAt = Date.now();
      if (changed) render(last);
    } catch { /* the list still works without it */ } finally { chatsBusy = false; }
  }
  /** The Chat session a task was handed to: from its events (detail), its last event or the sessions list. */
  function chatOf(t) {
    const ev = [...(details.get(t.id)?.events || [])].reverse().find((e) => e.type === 'handed_to_console');
    const fromList = chats.get(t.id);
    const id = ev?.data?.sessionId || (t.lastEvent?.type === 'handed_to_console' ? t.lastEvent.data?.sessionId : null) || fromList?.id;
    return id ? { id, running: fromList?.id === id && fromList.status === 'running' } : null;
  }
  /** What the row's Activity reads: the latest handover decides. Open in Claude Code ('opened') is a terminal the
   *  studio cannot see; a Chat handover names its session; else a listed session whose taskId is the task. */
  function activitySource(t) {
    const handover = (e) => e?.type === 'handed_to_console' || e?.type === 'opened';
    const evs = details.get(t.id)?.events;
    const last = evs ? [...evs].reverse().find(handover) : handover(t.lastEvent) ? t.lastEvent : null;
    if (last?.type === 'opened') return { terminal: true };
    const fromList = chats.get(t.id);
    const id = last?.data?.sessionId || fromList?.id;
    return id ? { id, running: fromList?.id === id && fromList.status === 'running' } : null;
  }
  async function openChat(sessionId, t) {
    if (elsewhere(t)) await app.selectProject(t.projectId);
    sessionStorage.setItem('atelier.consoleSession', sessionId);
    sessionStorage.setItem('atelier.consoleMode', 'chat');
    sessionStorage.setItem('atelier.consoleScope', 'project');
    app.go('claude-code');
  }

  // One finish writes several files, so requests come in bursts: only the newest answer counts.
  async function loadDetail(tid) {
    const load = (detailLoads.get(tid) || 0) + 1;
    detailLoads.set(tid, load);
    let out;
    try {
      out = await app.api.task(pidOf(last.find((x) => x.id === tid)), tid);
    } catch (err) {
      out = { error: err };
    }
    if (detailLoads.get(tid) !== load) return;
    details.set(tid, out);
    render(last);
  }

  function toggle(tid) {
    if (expanded.has(tid)) expanded.delete(tid);
    else { expanded.add(tid); if (!details.has(tid)) loadDetail(tid); }
    try { onToggle?.(tid, expanded.has(tid)); } catch (err) { console.error(err); }
    render(last);
    requestAnimationFrame(() => node.querySelector(`[data-tid="${tid}"] .task-sum`)?.focus());
  }

  function render(tasks) {
    last = tasks;
    activity.begin();
    clear(node, tasks.map((t) => row(t)));
    activity.end();
    if (tasks.length) refreshChats(); // every row may have a session, closed tasks too (their Activity stays readable)
    try { onRender?.(); } catch (err) { console.error(err); }
  }

  function row(t) {
    const open = expanded.has(t.id);
    const projectName = allProjects ? null : app.state.bundle?.project?.name;
    const meta = [compact ? null : projectName, departmentWords(t), `updated ${ago(t.updatedAt)}`, producedText(t)].filter(Boolean).join(' · ');
    const chat = OPEN.includes(t.status) ? chatOf(t) : null;
    const sum = el('button.task-sum', { type: 'button', 'aria-expanded': String(open), onclick: () => toggle(t.id) },
      el('span.task-title', allProjects && t.projectName ? el('span.task-project', `${t.projectName} · `) : null, t.title),
      chat?.running ? stateChip('Running in Chat', 'busy', 'A Claude Code session in Chat is working on this task') : showStatus ? chip(taskState(t)) : el('span'),
      el('span.task-meta', meta),
      t.status === 'needs-input' && t.question?.text ? el('span.task-q', `Question: ${t.question.text}`) : null);
    const wrap = el('article.task', { dataset: { tid: t.id } }, sum);
    if (chat) wrap.append(el('div.task-chat', button(chat.running ? 'Open the Chat session' : 'Open the Chat session it was handed to', { small: true, variant: 'quiet', onclick: () => openChat(chat.id, t) })));
    const act = activity.node(t, activitySource(t));
    if (act) wrap.append(el('div.task-activity-wrap', act));
    if (open) wrap.append(detail(t));
    return wrap;
  }

  function detail(t) {
    const d = details.get(t.id);
    const box = el('div.task-detail');
    if (!d) return clear(box, loading('Loading task…'));
    if (d.error) return clear(box, el('p.small', { style: { color: 'var(--danger)' } }, d.error.message), button('Retry', { small: true, onclick: () => loadDetail(t.id) }));
    const task = d.task;
    if (task.result) {
      // Native append() writes null as the text "null": only real nodes go in.
      box.append(...[el('h4', 'Result'), el('p', task.result.summary || ''),
        task.result.note ? el('p.note', task.result.note) : null,
        task.result.verification?.length ? el('ul.small', task.result.verification.map((v) => el('li', v))) : null,
        task.result.unresolved?.length ? el('h4', 'Unresolved') : null,
        task.result.unresolved?.length ? el('ul.small', task.result.unresolved.map((u) => el('li', u))) : null,
        task.status === 'cancelled' ? el('p.note', 'Cancelled; the result above was recorded before the cancel.') : null].filter(Boolean));
    }
    box.append(el('h4', 'Request'), el('p', { style: { margin: 0 } }, task.request),
      el('p.meta', { style: { margin: '2px 0 0' } }, [MODE_LABELS[task.mode] || task.mode, departmentWords(task), task.inspiration ? `inspiration: ${task.inspiration}` : null].filter(Boolean).join(' · ')));
    box.append(elsewhere(t) ? elsewhereActions(t) : actions(task));
    if (!compact || d.brief) box.append(el('details.more', { style: { marginTop: '12px' } }, el('summary', 'Brief for Claude Code'), el('div.brief', markdown(d.brief || '_No brief written._'))));
    box.append(keptOpen(t.id, `Events · ${d.events?.length || 0}`, eventList(t.id, d.events || [], d.versionNames, task.result)));
    return box;
  }

  function keptOpen(key, summary, ...body) {
    return el('details.more', { open: openEvents.has(key), ontoggle: (e) => { if (e.target.open) openEvents.add(key); else openEvents.delete(key); } }, el('summary', summary), ...body);
  }

  /** Oldest first, because a teach task's notes read top down; the last 12 stay open. */
  function eventList(tid, events, names, result) {
    if (!events.length) return el('p.small.muted', 'No events yet.');
    const list = (part) => el('ul.events', part.map((e) => el('li', { title: when(e.ts) },
      el('span.events-when', ago(e.ts)),
      el('span.events-what', el('strong', eventWords(e.type)), ` · ${e.actor}`, e.data?.text ? ` — ${eventText(e)}` : '', eventVersions(e, names, result)))));
    const { earlier, recent } = splitEvents(events);
    return el('div', earlier.length ? keptOpen(`${tid}:earlier`, `${earlier.length} earlier`, list(earlier)) : null, list(recent));
  }

  /** An event's text; a base_moved written before the line was shortened starts with its own type. */
  const eventText = (e) => (e.type === 'base_moved' ? String(e.data.text).replace(/^base moved /, '') : e.data.text);

  /** " → #8, #9" for an event about several versions, " → #9 label" for one. An ingested event from before it
   *  recorded versionIds names only the last of the result's versions, so it reads the result's list. */
  function eventVersions(e, names, result) {
    const own = e.data?.versionIds?.length ? e.data.versionIds : e.data?.versionId ? [e.data.versionId] : [];
    const vids = e.type === 'ingested' && own.length === 1 && result?.versionIds?.includes(own[0]) ? result.versionIds : own;
    if (!vids.length) return '';
    return vids.length === 1 ? ` → ${versionName(vids[0], names)}` : ` → ${vids.map((vid) => versionName(vid, names).split(' ')[0]).join(', ')}`;
  }

  /** "#n label": from the task's own detail (it may belong to another project), then the active bundle; else the id. */
  function versionName(vid, names) {
    if (names?.[vid]) return names[vid];
    const v = app.state.bundle?.versions?.find((x) => x.id === vid);
    return v ? `#${v.n} ${v.label}` : vid;
  }

  function producedText(t) {
    return producedWords(t.result, (vid) => versionName(vid, details.get(t.id)?.versionNames), t.status, t.mode);
  }

  /** What Try it opens: the last option, never what the finish left over. */
  const tryTarget = (task) => resultOptions(task.result, task.mode).options.at(-1) || null;

  /** Beside Try it when a task made more than one option: the same quiet button in every state. */
  function compareButton(task) {
    const { options } = resultOptions(task.result, task.mode);
    if (options.length < 2) return null;
    return button('Compare side by side', { small: true, variant: 'quiet', title: `Open the first and the last ${task.mode === 'explore' ? 'option' : 'version'} this task made in two live previews`, onclick: () => compareVersions(options[0], options.at(-1)) });
  }

  /** A row of another project (All projects scope): its actions need that project active. */
  function elsewhereActions(t) {
    return el('div',
      el('div.task-actions',
        button(`Switch to ${t.projectName || 'its project'}`, { small: true, title: 'Make this the active project; the task keeps its place in this list with all its actions', onclick: () => app.selectProject(t.projectId) }),
        copyButton(t)),
      el('p.meta.task-hint', `Its other actions work on the active project: switch to ${t.projectName || 'it'} first.`));
  }

  const copyButton = (t) => button('Copy command', { small: true, variant: 'quiet', onclick: async () => toast((await copyText(claudeCommand(app, t.id, pidOf(t)))) ? 'Command copied' : 'Copy failed. Use Open in Claude Code instead.', { tone: 'ok', timeout: 2000 }) });

  function actions(task) {
    const s = task.status;
    const closed = s === 'done' || s === 'cancelled';
    const box = el('div');
    const bar = el('div.task-actions');
    box.append(bar);
    // The state's own next step comes first; only Record the result is filled (one primary per view).
    if (s === 'needs-input') bar.append(button('Answer', { small: true, onclick: () => answer(task) }));
    if (s === 'review') {
      const vid = tryTarget(task);
      if (vid) bar.append(button('Try it', { small: true, title: 'Preview the version this task produced', onclick: () => tryVersion(vid) }));
      const compare = compareButton(task);
      if (compare) bar.append(compare);
      bar.append(button('Record the result', { small: true, variant: 'primary', title: vid ? 'Mark the task done and record its version, commits and decisions' : 'Mark the task done and record its commits and decisions', onclick: () => ingest(task) }));
      if (taskState(task) === 'record-result') box.append(el('p.meta.task-hint', 'This task has no version, so there is nothing to try. Record the result to close the task.'));
    }
    if (s === 'ready' || s === 'interrupted') {
      bar.append(
        button('Run with Claude Code here', { small: true, onclick: () => runHere(task) }),
        button('Open in Claude Code', { small: true, onclick: () => openInClaudeCode(task) }));
    } else if (!closed && s !== 'review') bar.append(button('Open in Claude Code', { small: true, onclick: () => openInClaudeCode(task) }));
    // Done, or cancelled after it made something: nothing is waiting, so no filled button; the produced version can still be tried.
    if ((s === 'done' || (s === 'cancelled' && madeBeforeCancel(task.result))) && tryTarget(task)) bar.append(button('Try it', { small: true, variant: 'quiet', title: 'Preview the version this task produced', onclick: () => tryVersion(tryTarget(task)) }));
    if (s === 'done') { const compare = compareButton(task); if (compare) bar.append(compare); }
    bar.append(copyButton(task));
    if (closed || s === 'interrupted') bar.append(button('Reopen', { small: true, variant: 'quiet', onclick: () => act(task, 'ready', 'Task reopened: ready for Claude Code') }));
    if (!closed) bar.append(button('Cancel task', { small: true, variant: 'danger', onclick: () => act(task, 'cancel', 'Task cancelled') }));
    if (s === 'ready' || s === 'interrupted') box.append(el('p.meta.task-hint', 'Here: a headless session in Chat that reports back through the studio. Outside: your own terminal window with the prompt on the clipboard.'));
    return box;
  }

  /** The Workbench registers app.workbench when it mounts: wait for it after a navigation. */
  function inWorkbench(run) {
    if (app.state.view !== 'workbench') app.go('workbench');
    let tries = 0;
    const go = () => { if (app.workbench) run(app.workbench); else if (++tries < 40) setTimeout(go, 50); };
    go();
  }

  function tryVersion(vid) {
    if (vid) inWorkbench((wb) => wb.viewVersion(vid));
  }

  function compareVersions(a, b) {
    inWorkbench((wb) => {
      closeDialogsIn(wb.host()); // a side by side already open would stay underneath the new one
      wb.sideBySide({ a, b });
    });
  }

  async function runHere(task) {
    try {
      const out = await app.api.taskConsole(app.projectId(), task.id, {});
      toast('Claude Code is working on the task in Chat', { tone: 'ok' });
      chatsAt = 0;
      app.loadBundle({ quiet: true });
      openChat(out.sessionId);
    } catch (err) {
      toastError(err, err.status === 404 && err.code !== 'not_found' ? 'Run with Claude Code here (restart the studio server: it does not know this route yet)' : 'Run with Claude Code here');
    }
  }

  async function act(task, action, msg, text) {
    if (action === 'cancel' && !(await confirmDialog({ title: 'Cancel this task?', message: 'The record stays; you can reopen it later.', confirm: 'Cancel task', variant: 'danger', cancel: 'Keep it' }))) return;
    try {
      await app.api.taskAction(app.projectId(), task.id, action, text);
      toast(msg, { tone: 'ok', timeout: 2200 });
      await loadDetail(task.id);
      app.loadBundle({ quiet: true });
    } catch (err) { toastError(err); }
  }

  function answer(task) {
    const ta = textarea({ rows: 4, placeholder: 'Your answer for Claude Code' });
    dialog({
      title: 'Answer Claude Code',
      body: el('div', el('p.note.warn', task.question?.text || 'Claude Code asked for input.'), field('Answer', ta)),
      actions: [{ label: 'Cancel' }, { label: 'Send answer', variant: 'primary', run: (close) => { if (!ta.value.trim()) return ta.focus(); close(); act(task, 'answer', 'Answer recorded', ta.value.trim()); } }],
    });
  }

  async function ingest(task) {
    try {
      const out = await app.api.ingestTask(app.projectId(), task.id);
      await app.loadBundle({ quiet: true });
      await loadDetail(task.id);
      const v = out.version;
      const several = resultVersions(out.task?.result).length > 1;
      const { options } = resultOptions(out.task?.result, out.task?.mode);
      dialog({
        title: 'Result recorded',
        body: el('div.prose',
          el('p', several ? `This task ${producedText(out.task)}. The task is done.` : v ? `This task produced version #${v.n} “${shortLabel(v.label, 72)}”. The task is done.` : out.task?.result?.note ? `${out.task.result.note} The task is done.` : 'No matching version was found for this result.'),
          // A result with no version names no commit, so its zero counts would contradict a note saying HEAD moved.
          el('p.small.muted', [...(v ? [`Commits since the task's base: ${out.evidence?.commitsSinceBase?.length ?? 0}`, `files changed: ${out.evidence?.filesChanged?.length ?? 0}`] : []), `decisions recorded: ${out.decisions?.length ?? 0}`, `unresolved items added: ${out.unresolved?.length ?? 0}`].join(' · '))),
        // The task is done: no primary action remains (Try it is there for a second look).
        actions: [...(v ? [{ label: 'Try it', variant: 'quiet', run: (close) => { close(); tryVersion(options.at(-1) || v.id); } }] : []),
          ...(options.length > 1 ? [{ label: 'Compare side by side', variant: 'quiet', run: (close) => { close(); compareVersions(options[0], options.at(-1)); } }] : []),
          { label: 'Close', variant: 'secondary' }],
      });
    } catch (err) { toastError(err, 'Record the result'); }
  }

  async function openInClaudeCode(task) {
    const ok = await confirmDialog({
      title: 'Open in Claude Code',
      message: el('p', 'Opens a terminal window in the project folder and starts your own Claude Code session with the task prompt. The studio only watches the task record.'),
      confirm: 'Open terminal',
    });
    if (!ok) return;
    try {
      const out = await app.api.openTask(app.projectId(), task.id);
      const cmd = el('div.cmd', el('code', out.command || ''), button('', { icon: 'copy', small: true, variant: 'ghost', title: 'Copy command', onclick: async () => toast((await copyText(out.command)) ? 'Copied' : 'Copy failed') }));
      dialog({
        title: out.launched ? 'Terminal launched' : 'Run this yourself',
        body: el('div.prose', el('p', out.launched ? 'A terminal window was asked to open on this machine. If you do not see it, run the command below.' : (out.detail || 'The studio could not open a terminal. Run this command:')), cmd),
        actions: [{ label: 'Close', variant: 'primary' }],
      });
      loadDetail(task.id);
    } catch (err) { toastError(err, 'Open in Claude Code'); }
  }

  return {
    node,
    render(tasks) {
      if (!tasks.length) { activity.begin(); activity.end(); return clear(node, empty(compact ? 'No tasks yet. Describe a change below.' : 'No tasks yet.')); }
      render(tasks);
    },
    /** Refresh details for an expanded task after an SSE task.changed. */
    invalidate(tid) {
      if (tid && expanded.has(tid)) loadDetail(tid);
      else if (!tid) for (const id of expanded) loadDetail(id);
    },
    reset() { expanded.clear(); details.clear(); openEvents.clear(); },
    /** What a task's Activity reads (null, { terminal: true } or { id, running }): the task inspector uses the same. */
    activitySource,
    /** Stops the Activity's console subscription and clock; the list is not used after this. */
    destroy() { activity.destroy(); },
    expand(tid) { if (!expanded.has(tid)) toggle(tid); },
  };
}
