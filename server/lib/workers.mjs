// The manager's workers (docs/ARCHITECTURE.md section 17): the Companion session is the manager, and each studio task
// it hands over runs in its own Claude Code session, a worker, outside the manager's turns. A companion turn is one
// `claude -p` process that ends with its answer, so anything it started in the background would end with it; the
// studio runs the workers instead, and they keep going while the person and the manager talk.
//
// One worker writes in a project folder at a time (AGENTS.md: one writing assistant per checkout); the others wait in
// that project's queue, shown as Queued runs. Each worker remembers the manager that started it (managerSessionId, the
// console session whose studio MCP server called atelier_start_task or atelier_review_task); when its turn ends, the
// report goes to that session, or to the task project's Companion session when there is none or it is gone. While the
// recipient is answering, the report is held until its turn ends. The queue, the held reports and the managers' notes
// are written to <data>/workers.json (atomic writes), and reconcile() on server start tells the manager of every task
// a restart cut off, starts the queues again (not over a cut-off worker's uncommitted files) and delivers what was held.

import { HttpError, nowIso } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';
import { CONSOLE_MODELS, WORKER_MODEL, checkWorkerModel, resolveWorkerModel } from './models.mjs';

export { WORKER_MODEL }; // the built-in studio default; the stored default, a project's and a task's workerModel outrank it (models.mjs)
export const WORKER_EFFORT = 'high';
export const WORKER_PERMISSION = 'auto';
export const STARTABLE = ['ready', 'working', 'interrupted', 'needs-input'];
export const REPORT_MARK = '[Studio report: not from the person]';
export const SESSION_ID_RE = /^cs_[a-z0-9]+$/;

const cut = (s, n = 400) => { const t = String(s ?? '').trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nextWords = (queued) => (queued ? ` ${queued} more task${queued === 1 ? '' : 's'} wait${queued === 1 ? 's' : ''} in the queue; the next one starts now.` : '');

/** Why a worker's turn ended without a finish or a question, with the error when there was one. */
export function endWords(turn = {}, status = 'working') {
  if (turn.timedOut) return `its turn timed out (${cut(turn.error || 'no error text', 200)}) before it finished`;
  if (turn.error) return `its turn ended with an error: ${cut(turn.error, 300)}`;
  if (turn.cancelled) return 'it was stopped';
  if (turn.isError) return `its turn ended with an error${turn.text ? `: ${cut(turn.text, 300)}` : ' and no error text'}`;
  return `its turn ended without finishing (status ${status})${turn.text ? `; its last words: "${cut(turn.text, 240)}"` : ''}`;
}

/**
 * The words of a worker's report to the manager, from the task as the worker left it and the turn's end.
 * task: { id, title, status, result }; events: the task's events; turn: the console turn ({ error, cancelled, timedOut, text }).
 */
export function reportText({ task, events = [], turn = {}, versionName = null, queued = 0 }) {
  const head = `${REPORT_MARK} Worker report for task ${task.id} "${cut(task.title, 90)}":`;
  const next = nextWords(queued);
  const review = ` Review it: read it with atelier_task_report ${task.id} and the changes with atelier_read_diff, check them against the task's acceptance, then accept or send it back with atelier_review_task, update what needs updating, and tell the person in a few lines.`;
  if (task.status === 'review') {
    const r = task.result || {};
    const facts = [
      r.summary ? `Summary: ${cut(r.summary)}` : null,
      versionName ? `Version: ${versionName}.` : r.note ? `No version: ${cut(r.note, 160)}` : null,
      r.verification?.length ? `Verified: ${r.verification.map((v) => cut(v, 120)).join('; ')}.` : 'Verification: none named.',
      r.unresolved?.length ? `Left open: ${r.unresolved.map((v) => cut(v, 120)).join('; ')}.` : null,
    ].filter(Boolean).join(' ');
    return `${head} finished, ready to review. ${facts}${review}${next}`;
  }
  if (task.status === 'needs-input') {
    const q = [...events].reverse().find((e) => e.type === 'question');
    return `${head} stopped with a question: "${cut(q?.data?.text || q?.text || 'no question text', 300)}". Answer it yourself when the project's records settle it; otherwise ask the person. Then send the answer back with atelier_review_task (verdict revise, the answer as the note).${next}`;
  }
  return `${head} did not finish: ${endWords(turn, task.status)}. Decide whether to send it back with atelier_review_task (verdict revise, with what to do differently) or to tell the person.${next}`;
}

/**
 * The report for a task whose worker a studio restart cut off: what it was doing, that its work is on disk and
 * uncommitted, and how to continue it. nextTid: the queued task that starts now in the same folder, if any.
 */
export function interruptedText({ task, events = [], dirty = true, nextTid = null, queued = 0 }) {
  const head = `${REPORT_MARK} Worker report for task ${task.id} "${cut(task.title, 90)}":`;
  const handed = [...events].reverse().find((e) => e.type === 'handed_to_console' && e.data?.worker);
  const note = [...events].reverse().find((e) => e.type === 'note' && e.actor !== 'companion' && (e.data?.text || e.text)); // the worker's, not the manager's send-back
  const since = handed?.ts || handed?.at;
  const started = (task.storedStatus || task.status) !== 'ready';
  const doing = `${since ? `It had been ${started ? 'working on it' : 'handed it'} since ${since}` : started ? 'It was working on it' : 'It had been handed it'}${started ? '' : ' and had not run task start yet'}${note ? `; its last note: "${cut(note.data?.text || note.text, 240)}"` : '; it left no note'}`;
  const disk = dirty ? ' Its work so far is on disk, not committed.' : ' The folder holds no uncommitted change, so it had changed no file yet or its changes are gone.';
  const queue = nextTid
    ? ` The next queued task ${nextTid} starts now.${queued > 0 ? ` ${plural(queued, 'more task')} ${queued === 1 ? 'waits' : 'wait'} behind it.` : ''}`
    : queued > 0 ? ` ${plural(queued, 'queued task')} ${queued === 1 ? 'waits' : 'wait'} and ${queued === 1 ? 'does' : 'do'} not start by itself: a new worker in this folder would take these uncommitted files into its own version. Continue this task first and the queue starts when it ends, or start the next one with atelier_start_task if these files should go with it.` : '';
  return `${head} interrupted by a studio restart before it finished. ${doing}.${disk} To continue it, send it back with atelier_review_task (verdict revise, the note saying to go on from the files on disk); otherwise tell the person.${queue}`;
}

/**
 * createWorkers({ consoleSvc, tasks, loadProject, listProjects, stateFile, afterChange, emit, runs }) ->
 * { start, review, status, overview, onTurnEnd, report, reconcile, flush }.
 * tasks: server/lib/tasks.mjs (getTask, listTasks, handOverTask, appendEvent, consolePrompt, shortLabel, noteTask,
 * reopenTask, answerTask, ingestTask, departmentParagraph). consoleSvc: send, createSession, getSession (a gone
 * session throws), isRunning. dirty(projectPath): whether the folder holds uncommitted changes, for the restart's
 * queue rule. runs: the run registry, for the Queued placeholders. stateFile: where the queue,
 * the held reports and the notes are kept across restarts (null: memory only). The worker model is read at every
 * launch: the task's own workerModel, else the project's, else the studio default. studioModel: async, the stored
 * studio default (server/lib/worker-model.mjs); model: the fallback when studioModel is absent, fails or answers a
 * model the studio does not offer.
 */
export function createWorkers({ consoleSvc, tasks, loadProject, listProjects = async () => [], dirty = async () => true, stateFile = null, afterChange = async () => {}, emit = () => {}, runs = null, model: defaultModel = WORKER_MODEL, studioModel = null, effort = WORKER_EFFORT, permissionMode = WORKER_PERMISSION }) {
  const projects = new Map(); // projectId -> { active: { tid, sessionId, managerSessionId, model } | null, queue: [{ tid, managerSessionId }] }
  let held = []; // [{ projectId, managerSessionId, text, at }]: reports waiting for their recipient's turn to end
  const notes = new Map(); // `${projectId}/${tid}` -> the manager's note for the next round, given to the next worker
  const of = (projectId) => {
    if (!projects.has(projectId)) projects.set(projectId, { active: null, queue: [] });
    return projects.get(projectId);
  };
  const queuedRunId = (projectId, tid) => `wq_${projectId}_${tid}`;
  const cleanManager = (id) => (typeof id === 'string' && SESSION_ID_RE.test(id) ? id : null);
  const heldFor = (projectId) => held.filter((h) => h.projectId === projectId).length;
  /** The studio default as it is stored now (read per launch, so a change needs no restart), else the fallback. */
  async function studioDefault() {
    try { const m = await studioModel?.(); if (CONSOLE_MODELS.includes(m)) return m; } catch (err) { console.error('[atelier] workers: studio default model not read', err.message); }
    return defaultModel;
  }
  /** The model the next worker of this task starts on, and where it comes from (task, project or studio). */
  const modelFor = async (task, project) => resolveWorkerModel({ task, project, studioDefault: await studioDefault() });

  // ---------- persistence: one file, written atomically, one write at a time ----------
  let writing = Promise.resolve();
  function persist() {
    if (!stateFile) return writing;
    const snapshot = () => ({
      version: 1,
      savedAt: nowIso(),
      projects: Object.fromEntries([...projects].filter(([, p]) => p.active || p.queue.length).map(([id, p]) => [id, { active: p.active, queue: p.queue }])),
      held,
      notes: Object.fromEntries(notes),
    });
    // Windows refuses a rename over a file another handle has open (EPERM, EBUSY): a few short retries.
    const save = async () => {
      for (let i = 0; ; i++) {
        try { return await writeJson(stateFile, snapshot()); } catch (err) {
          if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
          await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        }
      }
    };
    writing = writing.then(save).catch((err) => console.error('[atelier] workers state save failed', err.message));
    return writing;
  }

  // ---------- who hears a report ----------
  async function alive(sessionId) {
    if (!sessionId) return false;
    if (!consoleSvc.getSession) return true;
    try { await consoleSvc.getSession(sessionId); return true; } catch { return false; }
  }
  /** The manager that started the worker, else the task project's Companion session, else nobody (null). */
  async function recipient(item) {
    if (await alive(item.managerSessionId)) return { sessionId: item.managerSessionId, via: 'manager' };
    let companion = null;
    try { companion = (await loadProject(item.projectId)).project?.ui?.companionSessionId || null; } catch { /* project gone */ }
    if (companion && (await alive(companion))) return { sessionId: companion, via: 'companion' };
    return null;
  }
  async function hold(item) {
    held.push(item);
    emit('workers.changed', { projectId: item.projectId, held: heldFor(item.projectId) });
    await persist();
  }

  async function launch(projectId, tid, managerSessionId = null) {
    const ctx = await loadProject(projectId);
    const { task } = await tasks.getTask(ctx.path, tid);
    const handed = await tasks.handOverTask(ctx, tid);
    if (handed.moved) await afterChange(projectId, { taskId: tid });
    // The worker model as the records say now (the task's own, else the project's, else the studio default), so a
    // change reaches the next worker (a queued task, a revise); a running worker keeps the model its session was created with.
    const { model, source: modelSource } = await modelFor(task, ctx.project);
    const session = await consoleSvc.createSession({
      backend: 'claude-code', projectId, model, effort, permissionMode, allowStudioCli: true, worker: true,
      title: `Task · ${tasks.shortLabel(task.title, 70)}`, taskId: tid, department: task.department?.name || null,
    });
    await tasks.appendEvent(ctx.path, tid, 'handed_to_console', 'companion', { sessionId: session.id, worker: true, model, modelSource, effort, managerSessionId });
    const p = of(projectId);
    p.active = { tid, sessionId: session.id, managerSessionId, model };
    runs?.remove(queuedRunId(projectId, tid));
    emit('task.changed', { projectId, taskId: tid, sessionId: session.id });
    const key = `${projectId}/${tid}`;
    const note = notes.get(key);
    notes.delete(key);
    await persist();
    const prompt = tasks.consolePrompt(tid, task.mode, handed.task.context?.baseVersionId, handed.reason === 'kept' ? handed.task.context?.baseSha : null);
    // A task with a department: its first message names the department and lists its skills (server/lib/departments.mjs).
    const department = task.department && tasks.departmentParagraph ? await tasks.departmentParagraph(ctx.path, task) : '';
    const text = [prompt, department, note ? `The manager reviewed an earlier round of this task and sent it back with this note: ${note}` : ''].filter(Boolean).join('\n\n');
    try {
      const { runId } = await consoleSvc.send(session.id, { text });
      return { sessionId: session.id, runId, model, modelSource };
    } catch (err) {
      if (p.active?.sessionId === session.id) p.active = null; // no turn runs, so no turn end would ever free the folder
      await persist();
      throw err;
    }
  }

  /**
   * Hand a task to a worker now, or queue it behind the project's running worker. managerSessionId: who asked.
   * workerModel: when given, the task's own model is set first (a CONSOLE_MODELS id; 'default' or null clears it; an
   * unknown one is a 400 and nothing starts), and it stays on the task for its later rounds until changed.
   */
  async function start(projectId, tid, { managerSessionId = null, workerModel = undefined } = {}) {
    managerSessionId = cleanManager(managerSessionId);
    if (workerModel !== undefined) checkWorkerModel(workerModel);
    const ctx = await loadProject(projectId);
    let { task } = await tasks.getTask(ctx.path, tid);
    if (!STARTABLE.includes(task.status)) throw new HttpError(409, 'task_closed', `Task ${tid} is ${task.status}; only a ready, working, interrupted or needs-input task can go to a worker`);
    if (workerModel !== undefined) ({ task } = await tasks.setTaskWorkerModel(ctx.path, tid, workerModel, 'companion'));
    const p = of(projectId);
    // Already running: its worker keeps the model it started on; next names what a later round would start on.
    if (p.active?.tid === tid) return { state: 'working', already: true, sessionId: p.active.sessionId, model: p.active.model || null, next: await modelFor(task, ctx.project), queued: p.queue.length };
    if (p.active) {
      const waiting = p.queue.find((q) => q.tid === tid);
      if (!waiting) {
        p.queue.push({ tid, managerSessionId });
        await tasks.appendEvent(ctx.path, tid, 'queued', 'companion', { behind: p.active.tid, position: p.queue.length, managerSessionId });
        runs?.start({ id: queuedRunId(projectId, tid), kind: 'session', projectId, name: tasks.shortLabel(task.title, 70), department: task.department?.name || null, state: 'Queued', latest: `waits for ${p.active.tid}` });
        emit('task.changed', { projectId, taskId: tid, queued: true });
        await persist();
      } else if (managerSessionId && waiting.managerSessionId !== managerSessionId) {
        waiting.managerSessionId = managerSessionId; // the latest manager to ask hears the report
        await persist();
      }
      const { model, source: modelSource } = await modelFor(task, ctx.project); // as the records say now; read again when it starts
      return { state: 'queued', position: p.queue.findIndex((q) => q.tid === tid) + 1, behind: p.active.tid, model, modelSource };
    }
    const waiting = p.queue.findIndex((q) => q.tid === tid);
    if (waiting >= 0) { // started directly while it waited (a queue held after a restart): it leaves the queue
      managerSessionId ||= p.queue[waiting].managerSessionId;
      p.queue.splice(waiting, 1);
    }
    const out = await launch(projectId, tid, managerSessionId);
    return { state: 'working', ...out, queued: p.queue.length };
  }

  async function next(projectId) {
    const p = of(projectId);
    while (!p.active && p.queue.length) {
      const { tid, managerSessionId } = p.queue.shift();
      await persist();
      try { await launch(projectId, tid, managerSessionId); } catch (err) {
        runs?.remove(queuedRunId(projectId, tid));
        await report(projectId, `${REPORT_MARK} The queued task ${tid} could not start a worker: ${cut(err.message, 200)}. Tell the person or start it again with atelier_start_task.`, { managerSessionId });
      }
    }
  }

  /** Send a report to the manager that started the worker (else the project's Companion session), or hold it. */
  async function report(projectId, text, { managerSessionId = null } = {}) {
    const item = { projectId, managerSessionId: cleanManager(managerSessionId), text, at: nowIso() };
    const to = await recipient(item);
    if (!to) { await hold(item); return { delivered: false, reason: 'no manager session' }; }
    try {
      await consoleSvc.send(to.sessionId, { text });
      emit('workers.changed', { projectId, delivered: true, sessionId: to.sessionId });
      return { delivered: true, sessionId: to.sessionId, via: to.via };
    } catch (err) {
      await hold({ ...item, managerSessionId: item.managerSessionId || to.sessionId }); // mid-turn (409): its turn's end delivers it
      return { delivered: false, reason: err.message, sessionId: to.sessionId };
    }
  }

  /**
   * Deliver the held reports whose recipient is sessionId (null: every recipient that can take one now), one
   * message per recipient. A send that fails puts its reports back.
   */
  async function flush(sessionId = null) {
    if (!held.length) return { delivered: 0 };
    const items = held;
    held = [];
    const groups = new Map(); // recipient session -> items
    const keep = [];
    for (const item of items) {
      const to = await recipient(item);
      if (!to || (sessionId && to.sessionId !== sessionId) || consoleSvc.isRunning?.(to.sessionId)) { keep.push(item); continue; }
      if (!groups.has(to.sessionId)) groups.set(to.sessionId, []);
      groups.get(to.sessionId).push(item);
    }
    let delivered = 0;
    for (const [to, list] of groups) {
      const text = list.length === 1 ? list[0].text : `${REPORT_MARK} ${list.length} reports came in while you were away or answering:\n\n${list.map((h) => h.text).join('\n\n')}`;
      try {
        await consoleSvc.send(to, { text });
        delivered += list.length;
        emit('workers.changed', { projectId: list[0].projectId, delivered: true, sessionId: to });
      } catch { keep.push(...list); }
    }
    held = [...keep, ...held]; // anything held while this ran stays behind the older reports
    await persist();
    return { delivered };
  }

  /** The manager a worker session reports to: the running worker's record, else the task's handover event. */
  function managerOf(projectId, sessionId, events) {
    const p = of(projectId);
    if (p.active?.sessionId === sessionId) return p.active.managerSessionId || null;
    const handed = [...events].reverse().find((e) => e.type === 'handed_to_console' && e.data?.sessionId === sessionId);
    return handed?.data?.managerSessionId || null;
  }

  /** The console's turn-end hook: a worker's end reports and starts the next; any other session's lets its held reports through. */
  async function onTurnEnd(rec, turn) {
    if (!rec?.projectId) return;
    const p = of(rec.projectId);
    if (rec.worker && rec.taskId) {
      let text;
      let managerSessionId = p.active?.sessionId === rec.id ? p.active.managerSessionId : null;
      if (p.active?.sessionId === rec.id) { p.active = null; await persist(); }
      try {
        const ctx = await loadProject(rec.projectId);
        const { task, events, versionNames } = await tasks.getTask(ctx.path, rec.taskId);
        managerSessionId = managerSessionId || managerOf(rec.projectId, rec.id, events);
        const vid = task.result?.versionId;
        await afterChange(rec.projectId, { taskId: rec.taskId });
        text = reportText({ task, events, turn, versionName: vid ? versionNames?.[vid] || vid : null, queued: p.queue.length });
      } catch (err) {
        // The task could not be read: the report still goes, with the turn's own error and the read's.
        text = `${REPORT_MARK} Worker report for task ${rec.taskId}: its turn ended (${endWords(turn)}), and the task record could not be read: ${cut(err.message, 200)}.${nextWords(p.queue.length)}`;
      }
      await report(rec.projectId, text, { managerSessionId });
      await next(rec.projectId);
      return;
    }
    if (held.length) await flush(rec.id);
  }

  /**
   * After a studio restart: every registered project's task still working (or ready, cut off before its task start)
 * whose last worker session is not running
   * and whose last turn has no end gets an "interrupted by a studio restart" report to its manager (once per
   * session: a worker_interrupted event marks it), each persisted queue starts again where no worker runs, and the held reports are delivered.
   */
  async function reconcile() {
    const saved = stateFile ? await readJson(stateFile, null).catch(() => null) : null;
    if (saved && typeof saved === 'object') {
      held = Array.isArray(saved.held) ? saved.held.filter((h) => h && typeof h.text === 'string' && h.projectId).map((h) => ({ ...h, managerSessionId: cleanManager(h.managerSessionId) })) : [];
      for (const [k, v] of Object.entries(saved.notes || {})) if (typeof v === 'string') notes.set(k, v);
      for (const [id, sp] of Object.entries(saved.projects || {})) {
        const p = of(id);
        p.active = null; // nothing a fresh process did not start can be running in it
        p.queue = (Array.isArray(sp?.queue) ? sp.queue : []).filter((q) => q && /^t_[a-z0-9]+$/.test(q.tid)).map((q) => ({ tid: q.tid, managerSessionId: cleanManager(q.managerSessionId) }));
      }
    }
    let ids = [];
    try { ids = (await listProjects()).filter(Boolean); } catch (err) { console.error('[atelier] workers reconcile: projects', err.message); }
    const out = { interrupted: [], started: [], waiting: [], dropped: [], delivered: 0 };
    for (const projectId of new Set([...ids, ...projects.keys()])) {
      let ctx;
      try { ctx = await loadProject(projectId); } catch { projects.delete(projectId); continue; } // gone: its queue goes with it
      const p = of(projectId);
      // The queue keeps only tasks a worker can still take, and only once.
      const queue = [];
      for (const q of p.queue) {
        try {
          const { task } = await tasks.getTask(ctx.path, q.tid);
          if (STARTABLE.includes(task.status) && !queue.some((x) => x.tid === q.tid)) queue.push(q);
          else out.dropped.push(q.tid);
        } catch { out.dropped.push(q.tid); }
      }
      p.queue = queue;
      const running = p.active && consoleSvc.isRunning?.(p.active.sessionId);
      if (!running) p.active = null;
      const cutOff = []; // [{ t, events, sid, managerSessionId }]
      let list = [];
      try { list = await tasks.listTasks(ctx.path); } catch { list = []; }
      for (const t of list) {
        // working, or still ready when the worker was cut off before its first "task start"; review or needs-input when
        // it ran task finish or task question and was cut off before its turn ended, so its usual report never went
        const stored = t.storedStatus || t.status;
        if (!['working', 'ready', 'review', 'needs-input'].includes(stored) || p.queue.some((q) => q.tid === t.id)) continue;
        let events = [];
        try { ({ events } = await tasks.getTask(ctx.path, t.id)); } catch { continue; }
        const handed = [...events].reverse().find((e) => e.type === 'handed_to_console');
        if (!handed?.data?.worker || !handed.data.sessionId) continue; // only the studio's own workers
        const sid = handed.data.sessionId;
        if (consoleSvc.isRunning?.(sid) || p.active?.sessionId === sid) continue;
        if (events.some((e) => e.type === 'worker_interrupted' && e.data?.sessionId === sid)) continue; // told already
        // Cut off, not ended: the session's last turn is the message it was sent, with no answer after it. A turn that
        // ended reported then (a worker that stopped without finishing stays working), and a gone record proves nothing.
        let rec = null;
        try { rec = await consoleSvc.getSession?.(sid); } catch { rec = null; }
        if (!rec || rec.turns?.at(-1)?.role !== 'user') continue;
        const managerSessionId = cleanManager(handed.data.managerSessionId);
        if (stored === 'review' || stored === 'needs-input') {
          const full = await tasks.getTask(ctx.path, t.id).catch(() => null);
          const vid = full?.task?.result?.versionId;
          await tasks.appendEvent(ctx.path, t.id, 'worker_interrupted', 'studio', { sessionId: sid, managerSessionId, reason: 'studio restart', after: stored });
          held.push({ projectId, managerSessionId, text: `${reportText({ task: full?.task || t, events, versionName: vid ? full.versionNames?.[vid] || vid : null })} (Sent after a studio restart that cut its session off once it had ${stored === 'review' ? 'finished' : 'asked'}.)`, at: nowIso() });
          out.interrupted.push(t.id);
          continue;
        }
        cutOff.push({ t, events, sid, managerSessionId });
      }
      // The queue starts again where no worker runs, except over a cut-off worker's uncommitted files: a handover keeps
      // a dirty tree as a base version only for explore tasks, so a new worker's finish would take them as its own.
      let isDirty = false;
      if (cutOff.length) { try { isDirty = await dirty(ctx.path); } catch { isDirty = true; } }
      const queueStarts = !p.active && p.queue.length > 0 && !isDirty;
      const nextTid = queueStarts ? p.queue[0].tid : null;
      for (const { t, events, sid, managerSessionId } of cutOff) {
        await tasks.appendEvent(ctx.path, t.id, 'worker_interrupted', 'studio', { sessionId: sid, managerSessionId, reason: 'studio restart', dirty: isDirty, queueWaits: !queueStarts && p.queue.length > 0 });
        held.push({ projectId, managerSessionId, text: interruptedText({ task: t, events, dirty: isDirty, nextTid, queued: p.queue.length - (nextTid ? 1 : 0) }), at: nowIso() });
        out.interrupted.push(t.id);
        emit('task.changed', { projectId, taskId: t.id, interrupted: true });
      }
      await persist();
      const byId = new Map(list.map((t) => [t.id, t]));
      for (const q of p.queue) runs?.start({ id: queuedRunId(projectId, q.tid), kind: 'session', projectId, name: tasks.shortLabel(byId.get(q.tid)?.title || q.tid, 70), department: byId.get(q.tid)?.department?.name || null, state: 'Queued', latest: 'waits since the studio restarted' });
      if (queueStarts) {
        await next(projectId); // a start that fails reports itself to the task's manager
        if (p.active) out.started.push(p.active.tid);
      } else if (!p.active && p.queue.length) out.waiting.push(...p.queue.map((q) => q.tid));
    }
    out.delivered = (await flush()).delivered;
    return out;
  }

  /**
   * The manager's verdict on a task. accept: the result is recorded (ingest) and the task is done. revise: the note
   * goes to the task (as the answer when it asked a question), the task is reopened and handed to a worker again.
   */
  async function review(projectId, tid, { verdict, note = '', managerSessionId = null } = {}) {
    const ctx = await loadProject(projectId);
    const { task } = await tasks.getTask(ctx.path, tid);
    if (verdict === 'accept') {
      if (task.status !== 'review') throw new HttpError(409, 'task_not_finished', `Task ${tid} is ${task.status}; only a finished task (Ready to try) can be accepted`);
      if (note.trim()) await tasks.noteTask(ctx.path, tid, `Manager accepted: ${note.trim()}`, 'companion');
      const out = await tasks.ingestTask(ctx, tid);
      await afterChange(projectId, { taskId: tid });
      emit('task.changed', { projectId, taskId: tid, status: 'done' });
      return { verdict, status: out.task.status, versionId: out.version?.id || null };
    }
    if (verdict !== 'revise') throw new HttpError(400, 'invalid_input', 'verdict must be accept or revise');
    if (!note.trim()) throw new HttpError(400, 'invalid_input', 'A revise verdict needs a note: what the worker should do differently');
    if (task.status === 'needs-input') await tasks.answerTask(ctx.path, tid, note.trim());
    else {
      await tasks.noteTask(ctx.path, tid, `Manager sent it back: ${note.trim()}`, 'companion');
      notes.set(`${projectId}/${tid}`, note.trim());
      await persist();
      if (['review', 'done', 'cancelled'].includes(task.status)) await tasks.reopenTask(ctx, tid);
    }
    await afterChange(projectId, { taskId: tid });
    const started = await start(projectId, tid, { managerSessionId });
    return { verdict, ...started };
  }

  function status(projectId) {
    const p = of(projectId);
    return { active: p.active, queue: p.queue.map((q) => q.tid), held: heldFor(projectId) };
  }

  /** Every project's worker at once, for the restart confirmation: who is mid-task, how many wait, how many reports are held. */
  async function overview() {
    const active = [];
    let queued = 0;
    for (const [projectId, p] of projects) {
      queued += p.queue.length;
      if (!p.active) continue;
      // name: the worker's run name (server/lib/runs.mjs sessionName), so the confirmation does not count it twice.
      let name = p.active.tid;
      try { name = tasks.shortLabel((await tasks.getTask((await loadProject(projectId)).path, p.active.tid)).task.title, 70); } catch { /* the id then */ }
      active.push({ projectId, ...p.active, name });
    }
    return { active, queued, held: held.length };
  }

  return { start, review, status, overview, onTurnEnd, report, reconcile, flush };
}
