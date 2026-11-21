// The manager's workers (server/lib/workers.mjs): one worker per project, the queue, the report to the manager that
// started the worker (else the task project's Companion session; held while the recipient answers), the manager's
// accept and revise, and a studio restart: the queue, the held reports and the cut-off tasks survive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkers, reportText, interruptedText, lastFailure, REPORT_MARK, CODEX_WORKER_SANDBOX, CODEX_NO_EXPLORE, CODEX_FINISH_NOTE } from '../server/lib/workers.mjs';
import * as codexMod from '../server/lib/codex.mjs';
import { createTools } from '../server/lib/mcp/tools.mjs';
import { checkWorkerModel } from '../server/lib/models.mjs';
import { studioMcpConfig, claudeArgs } from '../server/lib/console.mjs';
import { consolePrompt } from '../server/lib/tasks.mjs';
import { restartWords } from '../client/components/restart.js';

/**
 * A fake studio. state is shared across restarts (pass it back in): the tasks and their events are the disk.
 * companions: projectId -> its Companion session id. gone: session ids whose record is deleted. busy: sessions
 * mid-turn (a send answers 409). running: sessions whose turn runs in this process.
 */
function setup({ state = null, stateFile = null, companions = { p1: 'cs_companion' }, gone = [], busy = [], dirty = false, records = {}, studioModel = null, tasksExtra = {}, consoleExtra = {}, workersExtra = {} } = {}) {
  state ||= { tasks: new Map(), events: [], ingested: [], reopened: [], answered: [] };
  state.sent = [];
  state.sessions ||= 0;
  const live = { gone: new Set(gone), busy: new Set(busy), running: new Set() };
  state.turns ||= new Map(); // session id -> its turns' roles, as the console records them on disk
  const task = (id, extra = {}) => state.tasks.set(id, { id, title: `Task ${id}`, status: 'ready', mode: 'handle', projectId: 'p1', ...extra });
  const tasks = {
    getTask: async (_p, tid) => {
      const t = state.tasks.get(tid);
      if (!t) throw Object.assign(new Error(`Task ${tid} not found`), { status: 404 });
      return { task: t, events: state.events.filter((e) => e.tid === tid), versionNames: { v_1: '#7 Done thing' } };
    },
    listTasks: async (p) => [...state.tasks.values()].filter((t) => `/${t.projectId}` === p).map((t) => ({ ...t, storedStatus: t.status })),
    handOverTask: async () => ({ moved: false, task: { context: {} }, reason: null }),
    appendEvent: async (_p, tid, type, actor, data) => state.events.push({ tid, ts: '2026-11-07T21:00:00.000Z', type, actor, data }),
    consolePrompt: (tid) => `PROMPT ${tid}`,
    shortLabel: (s) => s,
    noteTask: async (_p, tid, text) => state.events.push({ tid, type: 'note', data: { text } }),
    reopenTask: async (_c, tid) => { state.reopened.push(tid); state.tasks.get(tid).status = 'ready'; },
    answerTask: async (_p, tid, text) => { state.answered.push([tid, text]); state.tasks.get(tid).status = 'working'; },
    ingestTask: async (_c, tid) => { state.ingested.push(tid); state.tasks.get(tid).status = 'done'; return { task: state.tasks.get(tid), version: { id: 'v_1' } }; },
    // as tasks.mjs setTaskWorkerModel: the checked value is stored on the record, null removes it
    setTaskWorkerModel: async (_p, tid, value) => { const t = state.tasks.get(tid); const m = checkWorkerModel(value); if (m) t.workerModel = m; else delete t.workerModel; return { task: t, changed: true }; },
    ...tasksExtra,
  };
  const consoleSvc = {
    createSession: async (opts) => { const s = { id: `cs_w${++state.sessions}`, ...opts }; (state.created ||= []).push(s); return s; },
    getSession: async (id) => { if (live.gone.has(id)) throw Object.assign(new Error('not found'), { status: 404 }); return { id, turns: (state.turns.get(id) || []).map((role) => ({ role })) }; },
    isRunning: (id) => live.running.has(id),
    send: async (id, { text }) => {
      if (live.gone.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
      if (live.busy.has(id)) throw Object.assign(new Error('busy'), { status: 409 });
      state.sent.push({ id, text });
      state.turns.set(id, [...(state.turns.get(id) || []), 'user']);
      if (/^cs_w/.test(id)) live.running.add(id);
      return { runId: `cr_${state.sent.length}` };
    },
    ...consoleExtra,
  };
  const loadProject = async (id) => {
    if (!Object.hasOwn(companions, id)) throw Object.assign(new Error(`Project ${id} not found`), { status: 404 });
    // records: projectId -> extra fields of its .studio/project.json, read afresh at every load (a test may change them)
    return { path: `/${id}`, project: { ui: { companionSessionId: companions[id] }, ...(records[id] || {}) } };
  };
  const queuedRuns = [];
  const runs = { start: (r) => queuedRuns.push(r.id), remove: (id) => { const i = queuedRuns.indexOf(id); if (i >= 0) queuedRuns.splice(i, 1); } };
  const workers = createWorkers({ consoleSvc, tasks, loadProject, listProjects: async () => Object.keys(companions), dirty: async () => dirty, stateFile, runs, ...(studioModel ? { studioModel } : {}), ...workersExtra });
  /** A worker's turn ends: the console's hook, as console.mjs finish() calls it. */
  const workerEnds = (sessionId, tid, turn = {}, projectId = 'p1', backend = 'claude-code') => { live.running.delete(sessionId); state.turns.get(sessionId)?.push('assistant'); return workers.onTurnEnd({ id: sessionId, projectId, worker: true, taskId: tid, backend }, turn); };
  return { state, live, task, workers, queuedRuns, workerEnds };
}

const tempFile = async () => path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-workers-')), 'workers.json');

test('a task goes to a worker on the studio default (Fable 5.2), high; a second one queues behind it as a Queued run', async () => {
  const { state, task, workers, queuedRuns } = setup();
  task('t_a'); task('t_b');
  const a = await workers.start('p1', 't_a');
  assert.equal(a.state, 'working');
  assert.deepEqual(state.sent[0], { id: 'cs_w1', text: 'PROMPT t_a' });
  const handed = state.events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual([handed.data.model, handed.data.effort, handed.data.worker], ['claude-fable-5-2', 'high', true]);
  const b = await workers.start('p1', 't_b');
  assert.deepEqual([b.state, b.position, b.behind], ['queued', 1, 't_a']);
  assert.equal(queuedRuns.length, 1);
  assert.deepEqual(workers.status('p1'), { active: { tid: 't_a', sessionId: 'cs_w1', managerSessionId: null, backend: 'claude-code', model: 'claude-fable-5-2', effort: 'high' }, queue: ['t_b'], held: 0 });
  await assert.rejects(() => { state.tasks.get('t_a').status = 'done'; return workers.start('p1', 't_a'); }, /only a ready/);
});

test('worker model: none set starts on the studio default; a project setting starts its workers on that model', async () => {
  const plain = setup();
  plain.task('t_a');
  await plain.workers.start('p1', 't_a');
  assert.equal(plain.state.created[0].model, 'claude-fable-5-2', 'the session is created on the default');
  assert.equal(plain.state.events.find((e) => e.type === 'handed_to_console').data.model, 'claude-fable-5-2');

  const set = setup({ records: { p1: { workerModel: 'claude-opus-5-5' } } });
  set.task('t_a');
  await set.workers.start('p1', 't_a');
  assert.deepEqual([set.state.created[0].model, set.state.created[0].effort, set.state.created[0].permissionMode], ['claude-opus-5-5', 'high', 'auto'], 'effort and mode stay as they are');
  const handed = set.state.events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual([handed.data.model, handed.data.effort], ['claude-opus-5-5', 'high'], 'the event records the model the session runs on');

  const odd = setup({ records: { p1: { workerModel: 'not-a-model' } } });
  odd.task('t_a');
  await odd.workers.start('p1', 't_a');
  assert.equal(odd.state.created[0].model, 'claude-fable-5-2', 'a record edited by hand to an unknown id falls back to the default');
});

test('worker model: a change reaches the next worker (queued, then revised) and leaves the running one alone', async () => {
  const records = { p1: {} };
  const { state, task, workers, workerEnds } = setup({ records });
  task('t_a'); task('t_b');
  await workers.start('p1', 't_a'); // running on the default
  await workers.start('p1', 't_b'); // queued behind it
  records.p1.workerModel = 'claude-opus-5-5'; // the person changes the setting while t_a works
  assert.deepEqual(state.created.map((s) => [s.taskId, s.model]), [['t_a', 'claude-fable-5-2']], 'no new session for the running worker');
  assert.equal(workers.status('p1').active.sessionId, 'cs_w1', 'the running worker keeps its session');
  Object.assign(state.tasks.get('t_a'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w1', 't_a');
  assert.deepEqual(state.created.map((s) => [s.taskId, s.model]), [['t_a', 'claude-fable-5-2'], ['t_b', 'claude-opus-5-5']], 'the queued task starts on the new model');
  const handedB = state.events.find((e) => e.type === 'handed_to_console' && e.tid === 't_b');
  assert.equal(handedB.data.model, 'claude-opus-5-5');
  Object.assign(state.tasks.get('t_b'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w2', 't_b');
  records.p1.workerModel = 'claude-sonnet-5-5'; // changed again before the manager sends t_a back
  await workers.review('p1', 't_a', { verdict: 'revise', note: 'one more pass' });
  assert.deepEqual(state.created.at(-1), { ...state.created.at(-1), taskId: 't_a', model: 'claude-sonnet-5-5' }, 'the revised round reads the setting again');
  const handedA = state.events.filter((e) => e.type === 'handed_to_console' && e.tid === 't_a');
  assert.deepEqual(handedA.map((e) => e.data.model), ['claude-fable-5-2', 'claude-sonnet-5-5']);
});

test('worker model: a task\'s own model outranks the project\'s, which outranks the studio default; each launch says where it came from', async () => {
  const records = { p1: {} };
  let stored = 'claude-sonnet-5-5'; // the studio default as the registry holds it now
  const { state, task, workers, workerEnds } = setup({ records, studioModel: async () => stored });
  task('t_a'); task('t_b', { workerModel: 'claude-haiku-5-5' }); task('t_c');
  const a = await workers.start('p1', 't_a');
  assert.deepEqual([a.model, a.modelSource], ['claude-sonnet-5-5', 'studio'], 'nothing set: the stored studio default');
  const b = await workers.start('p1', 't_b'); // queued behind t_a
  assert.deepEqual([b.state, b.model, b.modelSource], ['queued', 'claude-haiku-5-5', 'task'], 'the queue answer names the model as the records say now');
  await workers.start('p1', 't_c');
  records.p1.workerModel = 'claude-opus-5-5';
  stored = 'claude-fable-5-1'; // changed while t_a works: no restart, the next launch reads it
  Object.assign(state.tasks.get('t_a'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w1', 't_a');
  assert.deepEqual([state.created[1].taskId, state.created[1].model], ['t_b', 'claude-haiku-5-5'], 'a queued start runs on the task\'s own model, over the project\'s');
  const handedB = state.events.find((e) => e.type === 'handed_to_console' && e.tid === 't_b');
  assert.deepEqual([handedB.data.model, handedB.data.modelSource], ['claude-haiku-5-5', 'task']);
  assert.equal(workers.status('p1').active.model, 'claude-haiku-5-5', 'the running worker\'s model rides the status');
  Object.assign(state.tasks.get('t_b'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w2', 't_b');
  const handedC = state.events.find((e) => e.type === 'handed_to_console' && e.tid === 't_c');
  assert.deepEqual([handedC.data.model, handedC.data.modelSource], ['claude-opus-5-5', 'project'], 'no task model: the project\'s');
  Object.assign(state.tasks.get('t_c'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w3', 't_c');
  // A revise round reads the task's model again; with the project's cleared too, the changed studio default applies.
  await workers.review('p1', 't_b', { verdict: 'revise', note: 'one more pass' });
  assert.deepEqual([state.created.at(-1).taskId, state.created.at(-1).model], ['t_b', 'claude-haiku-5-5'], 'the revise round keeps the task\'s model');
  Object.assign(state.tasks.get('t_b'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds(state.created.at(-1).id, 't_b');
  delete records.p1.workerModel;
  await workers.review('p1', 't_a', { verdict: 'revise', note: 'again' });
  const last = state.events.filter((e) => e.type === 'handed_to_console' && e.tid === 't_a').at(-1);
  assert.deepEqual([last.data.model, last.data.modelSource], ['claude-fable-5-1', 'studio'], 'the studio default changed at run time reaches the next worker');
});

test('worker model: start with a model stores it on the task first; default clears it; an unknown one is a 400 and nothing starts', async () => {
  const { state, task, workers, workerEnds } = setup({ records: { p1: { workerModel: 'claude-opus-5-5' } } });
  task('t_a'); task('t_b', { workerModel: 'claude-haiku-5-5' });
  await assert.rejects(() => workers.start('p1', 't_a', { workerModel: 'gpt-5' }), (err) => err.status === 400 && /workerModel must be one of claude-fable-5-2, .*, or default \(got "gpt-5"\)/.test(err.message));
  assert.equal(state.created, undefined, 'no session was created');
  assert.equal(workers.status('p1').active, null);
  const a = await workers.start('p1', 't_a', { workerModel: 'claude-sonnet-5-5' });
  assert.deepEqual([a.model, a.modelSource, state.created[0].model], ['claude-sonnet-5-5', 'task', 'claude-sonnet-5-5']);
  assert.equal(state.tasks.get('t_a').workerModel, 'claude-sonnet-5-5', 'kept on the task for its later rounds');
  // Started again while it runs: the record takes the new model, the running worker keeps its own.
  const again = await workers.start('p1', 't_a', { workerModel: 'claude-haiku-5-5' });
  assert.deepEqual([again.already, again.model, again.next.model, state.created.length], [true, 'claude-sonnet-5-5', 'claude-haiku-5-5', 1]);
  const b = await workers.start('p1', 't_b', { workerModel: 'default' }); // queued; its own model is cleared
  assert.deepEqual([b.state, b.model, b.modelSource], ['queued', 'claude-opus-5-5', 'project']);
  assert.equal('workerModel' in state.tasks.get('t_b'), false);
  Object.assign(state.tasks.get('t_a'), { status: 'review', result: { summary: 'Done', verification: ['npm test'] } });
  await workerEnds('cs_w1', 't_a');
  assert.deepEqual([state.created[1].taskId, state.created[1].model], ['t_b', 'claude-opus-5-5']);
});

test('worker model: a studio default that cannot be read, or is no model the studio offers, falls back to the built-in one', async () => {
  for (const studioModel of [async () => { throw new Error('registry unreadable'); }, async () => 'not-a-model', async () => null]) {
    const { state, task, workers } = setup({ studioModel });
    task('t_a');
    const out = await workers.start('p1', 't_a');
    assert.deepEqual([out.model, out.modelSource, state.created[0].model], ['claude-fable-5-2', 'studio', 'claude-fable-5-2']);
  }
});

test('a worker that finishes reports into the companion session and the next queued task starts', async () => {
  const { state, task, workers, queuedRuns, workerEnds } = setup();
  task('t_a'); task('t_b');
  await workers.start('p1', 't_a');
  await workers.start('p1', 't_b');
  Object.assign(state.tasks.get('t_a'), { status: 'review', result: { summary: 'Made it', versionId: 'v_1', verification: ['npm test'] } });
  await workerEnds('cs_w1', 't_a');
  const report = state.sent.find((s) => s.id === 'cs_companion');
  assert.ok(report.text.startsWith(REPORT_MARK));
  assert.match(report.text, /finished, ready to review\. Summary: Made it Version: #7 Done thing\. Verified: npm test\./);
  assert.match(report.text, /1 more task waits in the queue/);
  assert.deepEqual(workers.status('p1').active, { tid: 't_b', sessionId: 'cs_w2', managerSessionId: null, backend: 'claude-code', model: 'claude-fable-5-2', effort: 'high' }, 'the queued task started');
  assert.equal(queuedRuns.length, 0, 'its Queued placeholder is gone');
});

test('a report waits while the manager answers, and the end of its turn delivers it', async () => {
  const { state, live, task, workers, workerEnds } = setup({ busy: ['cs_companion'] });
  task('t_a');
  await workers.start('p1', 't_a');
  state.tasks.get('t_a').status = 'working'; // the worker's turn ended without a finish
  await workerEnds('cs_w1', 't_a', { text: 'I ran out of steps' });
  assert.equal(workers.status('p1').held, 1);
  assert.equal(state.sent.filter((s) => s.id === 'cs_companion').length, 0);
  live.busy.delete('cs_companion');
  await workers.onTurnEnd({ id: 'cs_companion', projectId: 'p1', context: 'companion' }, {});
  const report = state.sent.find((s) => s.id === 'cs_companion');
  assert.match(report.text, /did not finish: its turn ended without finishing \(status working\); its last words: "I ran out of steps"/);
  assert.equal(workers.status('p1').held, 0);
});

test('a worker started from another project\'s Companion reports to that session, not to the task project\'s', async () => {
  const { state, task, workers, workerEnds } = setup({ companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' } });
  task('t_a');
  await workers.start('p1', 't_a', { managerSessionId: 'cs_harbor' });
  const handed = state.events.find((e) => e.type === 'handed_to_console');
  assert.equal(handed.data.managerSessionId, 'cs_harbor', 'the handover event names the manager');
  assert.equal(workers.status('p1').active.managerSessionId, 'cs_harbor', 'and the worker state');
  Object.assign(state.tasks.get('t_a'), { status: 'review', result: { summary: 'Done' } });
  await workerEnds('cs_w1', 't_a');
  assert.deepEqual(state.sent.filter((s) => !/^cs_w/.test(s.id)).map((s) => s.id), ['cs_harbor'], 'only the starter heard it');
  assert.equal(workers.status('p1').held, 0);
});

test('a queued task keeps the manager that asked, and a held report for it waits for that manager\'s turn end', async () => {
  const { state, live, task, workers, workerEnds } = setup({ companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' }, busy: ['cs_harbor'] });
  task('t_a'); task('t_b');
  await workers.start('p1', 't_a', { managerSessionId: 'cs_companion' });
  await workers.start('p1', 't_b', { managerSessionId: 'cs_harbor' });
  assert.equal(state.events.find((e) => e.type === 'queued').data.managerSessionId, 'cs_harbor', 'the queued event names the manager');
  state.tasks.get('t_a').status = 'review';
  await workerEnds('cs_w1', 't_a');
  assert.equal(workers.status('p1').active.managerSessionId, 'cs_harbor', 'the queued task started with its own manager');
  state.tasks.get('t_b').status = 'needs-input';
  state.events.push({ tid: 't_b', type: 'question', data: { text: 'Which colour?' } });
  await workerEnds('cs_w2', 't_b');
  assert.equal(state.sent.filter((s) => s.id === 'cs_harbor').length, 0, 'the Harbor manager is mid-turn');
  await workers.onTurnEnd({ id: 'cs_companion', projectId: 'p1', context: 'companion' }, {});
  assert.equal(state.sent.filter((s) => s.id === 'cs_companion' && /t_b/.test(s.text)).length, 0, 'another session\'s turn end does not take it');
  live.busy.delete('cs_harbor');
  await workers.onTurnEnd({ id: 'cs_harbor', projectId: 'p_harbor', context: 'companion' }, {});
  assert.match(state.sent.find((s) => s.id === 'cs_harbor').text, /t_b.*stopped with a question: "Which colour\?"/);
});

test('falls back to the task project\'s Companion session only when the starter is gone', async () => {
  const { state, task, workers, workerEnds } = setup({ companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' }, gone: ['cs_harbor'] });
  task('t_a'); task('t_b');
  await workers.start('p1', 't_a', { managerSessionId: 'cs_harbor' });
  state.tasks.get('t_a').status = 'review';
  await workerEnds('cs_w1', 't_a');
  assert.deepEqual(state.sent.filter((s) => !/^cs_w/.test(s.id)).map((s) => s.id), ['cs_companion']);
  // No starter recorded at all (a worker from before managers were named, or a start from a script): the Companion.
  await workers.start('p1', 't_b');
  state.tasks.get('t_b').status = 'review';
  await workerEnds('cs_w2', 't_b');
  assert.equal(state.sent.filter((s) => s.id === 'cs_companion').length, 2);
  // A malformed id is not taken as a manager.
  task('t_c');
  await workers.start('p1', 't_c', { managerSessionId: '../x' });
  assert.equal(workers.status('p1').active.managerSessionId, null);
});

test('an error or a timeout report carries the error', async () => {
  const timedOut = reportText({ task: { id: 't_x', title: 'X', status: 'working' }, turn: { cancelled: true, timedOut: true, error: 'timed out after 5400000 ms' } });
  assert.match(timedOut, /did not finish: its turn timed out \(timed out after 5400000 ms\) before it finished/);
  const failed = reportText({ task: { id: 't_x', title: 'X', status: 'working' }, turn: { error: 'claude exited with 1: Not logged in' } });
  assert.match(failed, /its turn ended with an error: claude exited with 1: Not logged in/);
  const resultError = reportText({ task: { id: 't_x', title: 'X', status: 'working' }, turn: { isError: true, text: 'API overloaded' } });
  assert.match(resultError, /its turn ended with an error: API overloaded/);
  assert.match(reportText({ task: { id: 't_x', title: 'X', status: 'working' }, turn: { cancelled: true } }), /it was stopped/);
});

test('a worker whose task cannot be read still reports, with the turn\'s error', async () => {
  const { state, task, workers, workerEnds } = setup();
  task('t_a');
  await workers.start('p1', 't_a');
  state.tasks.delete('t_a');
  await workerEnds('cs_w1', 't_a', { error: 'claude exited with 3' });
  assert.match(state.sent.find((s) => s.id === 'cs_companion').text, /task t_a: its turn ended \(its turn ended with an error: claude exited with 3\), and the task record could not be read/);
});

test('a stuck worker is told to ask with task question and stop', () => {
  const prompt = consolePrompt('t_s', 'handle');
  assert.match(prompt, /a command you need is denied, a check fails and you cannot fix it, or you lack access/);
  assert.match(prompt, /run task question saying what blocks you.*and stop; do not guess, work around the block or run on\./);
});

test('the queue, the notes and the held reports are written to the state file as they change', async () => {
  const stateFile = await tempFile();
  const { task, workers } = setup({ stateFile, companions: { p1: null }, gone: ['cs_gone'] });
  task('t_a'); task('t_b');
  await workers.start('p1', 't_a', { managerSessionId: 'cs_m' });
  await workers.start('p1', 't_b', { managerSessionId: 'cs_m' });
  let saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  assert.deepEqual(saved.projects.p1, { active: { tid: 't_a', sessionId: 'cs_w1', managerSessionId: 'cs_m', backend: 'claude-code', model: 'claude-fable-5-2', effort: 'high' }, queue: [{ tid: 't_b', managerSessionId: 'cs_m' }] });
  const r = await workers.report('p1', `${REPORT_MARK} held`, { managerSessionId: 'cs_gone' }); // its manager is gone and p1 has no Companion
  assert.deepEqual(r, { delivered: false, reason: 'no manager session' });
  saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  assert.deepEqual(saved.held.map((h) => [h.projectId, h.managerSessionId, h.text]), [['p1', 'cs_gone', `${REPORT_MARK} held`]]);
  const files = await fsp.readdir(path.dirname(stateFile));
  assert.deepEqual(files, ['workers.json'], 'no temp file left behind');
});

test('a fake restart: the cut-off task\'s manager is told, the kept queue resumes, held reports arrive, once', async () => {
  const stateFile = await tempFile();
  const companions = { p1: 'cs_companion', p_harbor: 'cs_harbor' };
  // Before: a worker on t_a for the Harbor manager, t_b queued behind it, a report held for the busy Harbor manager.
  const before = setup({ stateFile, companions, busy: ['cs_harbor'] });
  before.task('t_a'); before.task('t_b'); before.task('t_c');
  await before.workers.start('p1', 't_a', { managerSessionId: 'cs_harbor' });
  before.state.tasks.get('t_a').status = 'working';
  before.state.events.push({ tid: 't_a', type: 'note', data: { text: 'Header spacing done; footer next' } });
  await before.workers.start('p1', 't_b', { managerSessionId: 'cs_harbor' });
  await before.workers.report('p1', `${REPORT_MARK} an earlier report`, { managerSessionId: 'cs_harbor' });
  // The restart: a new process with nothing running, the same disk and the same state file; the folder is clean.
  const after = setup({ state: before.state, stateFile, companions, dirty: false });
  const out = await after.workers.reconcile();
  assert.deepEqual(out.interrupted, ['t_a']);
  assert.deepEqual(out.started, ['t_b'], 'the kept queue resumed');
  assert.equal(out.delivered, 2);
  const mark = after.state.events.find((e) => e.type === 'worker_interrupted');
  assert.deepEqual([mark.tid, mark.data.sessionId, mark.data.managerSessionId], ['t_a', 'cs_w1', 'cs_harbor']);
  const toHarbor = after.state.sent.filter((s) => s.id === 'cs_harbor');
  assert.equal(toHarbor.length, 1, 'one message for both reports');
  assert.match(toHarbor[0].text, /2 reports came in/);
  assert.match(toHarbor[0].text, /an earlier report/, 'the held report survived the restart');
  assert.match(toHarbor[0].text, /t_a "Task t_a": interrupted by a studio restart before it finished\. It had been working on it since 2026-11-07T21:00:00\.000Z; its last note: "Header spacing done; footer next"\./);
  assert.match(toHarbor[0].text, /holds no uncommitted change.*atelier_review_task \(verdict revise.* The next queued task t_b starts now\./);
  assert.equal(after.state.sent.filter((s) => s.id === 'cs_companion').length, 0, 'the task project\'s Companion is not told');
  assert.deepEqual(after.workers.status('p1'), { active: { tid: 't_b', sessionId: 'cs_w2', managerSessionId: 'cs_harbor', backend: 'claude-code', model: 'claude-fable-5-2', effort: 'high' }, queue: [], held: 0 });
  // A second restart says nothing again about the same cut-off session, and tells about the new one.
  after.state.tasks.get('t_b').status = 'working';
  const again = setup({ state: after.state, stateFile, companions, dirty: false });
  const out2 = await again.workers.reconcile();
  assert.deepEqual(out2.interrupted, ['t_b'], 't_b was cut off by the second restart; t_a was told already');
  // Continue it: revise starts a new worker for t_a, with the note, for the manager who sent it back.
  const back = await again.workers.review('p1', 't_a', { verdict: 'revise', note: 'Go on from the files on disk', managerSessionId: 'cs_harbor' });
  assert.equal(back.state, 'working');
  assert.match(again.state.sent.at(-1).text, /^PROMPT t_a\n\nThe manager reviewed an earlier round .*Go on from the files on disk$/);
});

test('after a restart the queue waits over a cut-off worker\'s uncommitted files until that task is continued', async () => {
  const stateFile = await tempFile();
  const before = setup({ stateFile });
  before.task('t_a'); before.task('t_b');
  await before.workers.start('p1', 't_a', { managerSessionId: 'cs_companion' });
  before.state.tasks.get('t_a').status = 'working';
  await before.workers.start('p1', 't_b', { managerSessionId: 'cs_companion' });
  const after = setup({ state: before.state, stateFile, dirty: true });
  const out = await after.workers.reconcile();
  assert.deepEqual([out.interrupted, out.started, out.waiting], [['t_a'], [], ['t_b']]);
  const told = after.state.sent.find((s) => s.id === 'cs_companion').text;
  assert.match(told, /Its work so far is on disk, not committed\./);
  assert.match(told, /1 queued task waits and does not start by itself: a new worker in this folder would take these uncommitted files into its own version\. Continue this task first and the queue starts when it ends/);
  assert.equal(after.state.events.find((e) => e.type === 'worker_interrupted').data.queueWaits, true);
  assert.deepEqual(after.workers.status('p1'), { active: null, queue: ['t_b'], held: 0 });
  // The manager continues t_a; when that worker ends, the queue starts.
  await after.workers.review('p1', 't_a', { verdict: 'revise', note: 'Go on', managerSessionId: 'cs_companion' });
  assert.equal(after.workers.status('p1').active.tid, 't_a');
  after.state.tasks.get('t_a').status = 'review';
  await after.workerEnds(after.workers.status('p1').active.sessionId, 't_a');
  assert.equal(after.workers.status('p1').active.tid, 't_b');
  // Or the manager starts the waiting task directly: it leaves the queue and is not started twice.
  const third = setup({ state: after.state, stateFile, dirty: true });
  third.task('t_c'); third.task('t_d');
  await third.workers.start('p1', 't_c');
  await third.workers.start('p1', 't_d');
  third.state.tasks.get('t_c').status = 'working';
  const fourth = setup({ state: third.state, stateFile, dirty: true });
  await fourth.workers.reconcile();
  assert.deepEqual(fourth.workers.status('p1').queue, ['t_d']);
  await fourth.workers.start('p1', 't_d');
  assert.deepEqual(fourth.workers.status('p1').queue, [], 'started directly, it left the queue');
});

test('a worker cut off before its task start (the task still ready) is reported too', async () => {
  const stateFile = await tempFile();
  const before = setup({ stateFile });
  before.task('t_a');
  await before.workers.start('p1', 't_a', { managerSessionId: 'cs_companion' });
  const after = setup({ state: before.state, stateFile });
  const out = await after.workers.reconcile();
  assert.deepEqual(out.interrupted, ['t_a']);
  assert.match(after.state.sent.find((s) => s.id === 'cs_companion').text, /It had been handed it since .* and had not run task start yet; it left no note./);
});

test('a worker cut off after its task finish still gets its finished report to the manager', async () => {
  const stateFile = await tempFile();
  const before = setup({ stateFile, companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' } });
  before.task('t_a');
  await before.workers.start('p1', 't_a', { managerSessionId: 'cs_harbor' });
  Object.assign(before.state.tasks.get('t_a'), { status: 'review', result: { summary: 'Made it', versionId: 'v_1' } });
  const after = setup({ state: before.state, stateFile, companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' } });
  const out = await after.workers.reconcile();
  assert.deepEqual(out.interrupted, ['t_a']);
  const text = after.state.sent.find((s) => s.id === 'cs_harbor').text;
  assert.match(text, /finished, ready to review. Summary: Made it Version: #7 Done thing./);
  assert.match(text, /\(Sent after a studio restart that cut its session off once it had finished\.\)$/);
  assert.equal((await setup({ state: after.state, stateFile, companions: { p1: 'cs_companion', p_harbor: 'cs_harbor' } }).workers.reconcile()).interrupted.length, 0, 'once');
});

test('a restart does not call a worker interrupted when its turn ended (it reported then)', async () => {
  const { state, task, workers, workerEnds } = setup();
  task('t_a');
  await workers.start('p1', 't_a');
  state.tasks.get('t_a').status = 'working';
  await workerEnds('cs_w1', 't_a', { text: 'I stopped early' });
  const after = setup({ state, companions: { p1: 'cs_companion' } });
  const out = await after.workers.reconcile();
  assert.deepEqual(out.interrupted, []);
  assert.equal(state.events.filter((e) => e.type === 'worker_interrupted').length, 0);
});

test('a restart drops queue entries whose task closed or went away, and a project that is gone', async () => {
  const stateFile = await tempFile();
  await fsp.writeFile(stateFile, JSON.stringify({ version: 1, projects: { p1: { active: { tid: 't_x', sessionId: 'cs_w9' }, queue: [{ tid: 't_done' }, { tid: 't_none' }, { tid: 't_ok', managerSessionId: 'bad id' }] }, p_gone: { active: null, queue: [{ tid: 't_q' }] } }, held: [{ projectId: 'p1', managerSessionId: null, text: 'kept report' }], notes: { 'p1/t_ok': 'use the red one' } }));
  const { state, task, workers } = setup({ stateFile });
  task('t_done', { status: 'done' }); task('t_ok');
  const out = await workers.reconcile();
  assert.deepEqual(out.dropped.sort(), ['t_done', 't_none']);
  assert.deepEqual(out.started, ['t_ok']);
  assert.equal(workers.status('p1').active.managerSessionId, null, 'a malformed manager id is dropped');
  assert.match(state.sent.find((s) => s.id === 'cs_w1').text, /sent it back with this note: use the red one$/, 'the kept note reached the worker');
  assert.equal(state.sent.find((s) => s.id === 'cs_companion').text, 'kept report');
  assert.deepEqual(Object.keys(JSON.parse(await fsp.readFile(stateFile, 'utf8')).projects), ['p1']);
});

test('review: accept records the result; revise needs a note, reopens and gives the note to the next worker', async () => {
  const { state, task, workers } = setup();
  task('t_a', { status: 'review' });
  const ok = await workers.review('p1', 't_a', { verdict: 'accept', note: 'checked the acceptance' });
  assert.deepEqual([ok.status, ok.versionId, state.ingested], ['done', 'v_1', ['t_a']]);
  task('t_b', { status: 'review' });
  await assert.rejects(() => workers.review('p1', 't_b', { verdict: 'revise' }), /needs a note/);
  const back = await workers.review('p1', 't_b', { verdict: 'revise', note: 'The header still overlaps', managerSessionId: 'cs_harbor' });
  assert.equal(back.state, 'working');
  assert.equal(workers.status('p1').active.managerSessionId, 'cs_harbor', 'the reviewing manager hears the next round');
  assert.deepEqual(state.reopened, ['t_b']);
  assert.match(state.sent.at(-1).text, /^PROMPT t_b\n\nThe manager reviewed an earlier round of this task and sent it back with this note: The header still overlaps$/);
  task('t_c', { status: 'needs-input', startedAt: 'x' });
  await workers.review('p1', 't_c', { verdict: 'revise', note: 'Use the red one' });
  assert.deepEqual(state.answered, [['t_c', 'Use the red one']]);
});

test('the report names a question and what to do with it', () => {
  const text = reportText({ task: { id: 't_q', title: 'Q', status: 'needs-input' }, events: [{ type: 'question', data: { text: 'Which colour?' } }] });
  assert.match(text, /stopped with a question: "Which colour\?"/);
  assert.match(text, /atelier_review_task \(verdict revise, the answer as the note\)/);
  assert.match(interruptedText({ task: { id: 't_n', title: 'N' }, events: [{ type: 'note', actor: 'claude-code', data: { text: 'mine' } }, { type: 'note', actor: 'companion', data: { text: 'Manager sent it back: x' } }] }), /its last note: "mine"/, 'the manager\'s own note is not the worker\'s');
  assert.match(interruptedText({ task: { id: 't_i', title: 'I' } }), /It was working on it; it left no note\. Its work so far is on disk, not committed\. To continue it/);
});

test('the companion\'s MCP server is given its session id, and start and review send it as the manager', async () => {
  const cfg = studioMcpConfig({ studioDir: '/s', projectId: 'p_abc', nodePath: 'node', sessionId: 'cs_me' });
  assert.deepEqual(cfg.mcpServers.atelier.env, { ATELIER_SESSION_ID: 'cs_me' });
  const args = claudeArgs({ id: 'cs_me', model: 'claude-opus-5-5', tools: 'studio', projectId: 'p_abc' }, { studioDir: '/s', nodePath: 'node' });
  assert.equal(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.atelier.env.ATELIER_SESSION_ID, 'cs_me');
  const bodies = [];
  const fetch = async (url, { method, body }) => {
    const p = new URL(url).pathname;
    if (body) bodies.push([method, p, JSON.parse(body)]);
    const data = p === '/api/projects' ? [{ id: 'p_abc', name: 'Room' }] : p.endsWith('/workers') ? { state: 'working', sessionId: 'cs_w1', queued: 0 } : { state: 'working', sessionId: 'cs_w2' };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const tools = createTools({ studio: 'http://x', project: 'p_abc', session: 'cs_me', fetch });
  await tools.find((t) => t.name === 'atelier_start_task').run({ task: 't_a' });
  await tools.find((t) => t.name === 'atelier_review_task').run({ task: 't_a', verdict: 'revise', note: 'again' });
  assert.deepEqual(bodies.map((b) => b[2].managerSessionId), ['cs_me', 'cs_me']);
  const anon = createTools({ studio: 'http://x', project: 'p_abc', fetch });
  await anon.find((t) => t.name === 'atelier_start_task').run({ task: 't_a' });
  assert.equal(bodies.at(-1)[2].managerSessionId, undefined, 'no session, no manager named');
});

test('the restart confirmation says how many workers are mid-task and that their managers are told', () => {
  const two = restartWords({ working: ['Fix header', 'Add footer', 'pwsh'], workers: { active: [{ name: 'Fix header' }, { name: 'Add footer' }], queued: 1, held: 0 } });
  assert.equal(two, '2 workers are mid-task and will be interrupted; their managers are told and can continue them. pwsh is working now and will be stopped. 1 queued task starts again after the restart.');
  assert.match(restartWords({ working: ['Fix header'], workers: { active: [{ name: 'Fix header' }], queued: 0 } }), /^1 worker is mid-task and will be interrupted; its manager is told and can continue it\.$/);
  assert.equal(restartWords({ working: [], workers: { active: [], queued: 0 } }), '');
  assert.match(restartWords({ working: ['a', 'b'], workers: null }), /^2 runs are working now and will be stopped: a, b\. Tasks keep their status\.$/);
});

// ---------- Codex workers (decision row 182): a worker model of codex:<model>[@<effort>] starts a Codex session ----------
test('codex worker: a Codex worker model starts a Codex session in workspace-write with that model and effort; the event, the state and the answer name what ran', async () => {
  assert.equal(CODEX_WORKER_SANDBOX, codexMod.CODEX_WORKER_SANDBOX, 'one sandbox for a Codex worker, in both modules');
  const ready = [];
  const { state, task, workers } = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra@xhigh' } }, consoleExtra: { codexReady: async () => { ready.push('asked'); } } });
  task('t_a'); task('t_b', { workerModel: 'claude-haiku-5-5' });
  const a = await workers.start('p1', 't_a');
  assert.deepEqual([a.state, a.backend, a.model, a.effort, a.modelSource], ['working', 'codex', 'gpt-6-astra', 'xhigh', 'project']);
  assert.deepEqual(ready, ['asked'], 'the CLI and its login are asked for before anything is handed over');
  const s = state.created[0];
  assert.deepEqual([s.backend, s.model, s.effort, s.sandbox, s.worker, s.taskId], ['codex', 'gpt-6-astra', 'xhigh', 'workspace-write', true, 't_a']);
  for (const k of ['permissionMode', 'allowStudioCli', 'tools']) assert.equal(k in s, false, `a Codex worker session takes no ${k}`);
  const handed = state.events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual([handed.data.backend, handed.data.model, handed.data.effort, handed.data.sandbox, handed.data.modelSource, handed.data.worker], ['codex', 'gpt-6-astra', 'xhigh', 'workspace-write', 'project', true]);
  assert.deepEqual(workers.status('p1').active, { tid: 't_a', sessionId: 'cs_w1', managerSessionId: null, backend: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.equal(state.sent[0].text, 'PROMPT t_a', 'the same task prompt a Claude Code worker gets');
  // Its own model outranks the project's, so the next task is a Claude Code worker as before.
  const b = await workers.start('p1', 't_b');
  assert.deepEqual([b.state, b.backend, b.model, b.effort], ['queued', 'claude-code', 'claude-haiku-5-5', 'high']);
  const again = await workers.start('p1', 't_a');
  assert.deepEqual([again.already, again.backend, again.model, again.effort], [true, 'codex', 'gpt-6-astra', 'xhigh']);
});

test('codex worker: no effort named takes what the session recorded (Codex\'s configured one); nothing is a default but Claude Code', async () => {
  const none = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra' } }, consoleExtra: { createSession: async (opts) => ({ id: 'cs_w1', ...opts, effort: 'high' }) } });
  none.task('t_a');
  const a = await none.workers.start('p1', 't_a');
  assert.deepEqual([a.backend, a.model, a.effort], ['codex', 'gpt-6-astra', 'high'], 'the effort the session record holds, not a guess');
  assert.equal(none.state.events.find((e) => e.type === 'handed_to_console').data.effort, 'high');
  const plain = setup();
  plain.task('t_a');
  assert.equal((await plain.workers.start('p1', 't_a')).backend, 'claude-code', 'with nothing set a worker is Claude Code');
  const stored = setup({ studioModel: async () => 'codex:gpt-6-luna@low' });
  stored.task('t_a');
  const c = await stored.workers.start('p1', 't_a');
  assert.deepEqual([c.backend, c.model, c.effort, c.modelSource], ['codex', 'gpt-6-luna', 'low', 'studio'], 'a stored studio default may be a Codex one');
});

test('codex worker: an explore task is refused before anything is handed over; no CLI or no login starts nothing; a model Codex lacks is a 400', async () => {
  const handovers = [];
  const { state, task, workers } = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra@xhigh' } }, tasksExtra: { handOverTask: async () => { handovers.push(1); return { moved: false, task: { context: {} }, reason: null }; } } });
  task('t_x', { mode: 'explore' });
  await assert.rejects(() => workers.start('p1', 't_x'), (err) => err.status === 409 && err.code === 'codex_no_explore' && err.message === CODEX_NO_EXPLORE);
  assert.deepEqual([handovers.length, state.created, workers.status('p1').active], [0, undefined, null], 'no handover, no session, no worker');
  // A Claude Code model on the task itself: the explore task goes to a worker as before.
  assert.equal((await workers.start('p1', 't_x', { workerModel: 'claude-opus-5-5' })).backend, 'claude-code');

  const out = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra' } }, consoleExtra: { codexReady: async () => { throw Object.assign(new Error(codexMod.CODEX_SIGNED_OUT), { status: 503, code: 'console_codex_signed_out' }); } } });
  out.task('t_a');
  await assert.rejects(() => out.workers.start('p1', 't_a'), (err) => err.status === 503 && /Codex is signed out on this machine/.test(err.message));
  assert.deepEqual([out.state.created, out.state.events.length, out.workers.status('p1').active], [undefined, 0, null], 'nothing was created, recorded or left running');

  const choices = { models: [{ id: 'gpt-a', efforts: ['low', 'high'] }] };
  const { checkCodexWorker } = await import('../server/lib/worker-model.mjs');
  const checked = setup({ workersExtra: { checkCodex: (v) => checkCodexWorker(v, { choices }) } });
  checked.task('t_a');
  await assert.rejects(() => checked.workers.start('p1', 't_a', { workerModel: 'codex:gpt-zzz@low' }), (err) => err.status === 400 && /model must be one of gpt-a/.test(err.message));
  await assert.rejects(() => checked.workers.start('p1', 't_a', { workerModel: 'codex:gpt-a@xhigh' }), (err) => err.status === 400 && /effort must be one of low, high for gpt-a/.test(err.message));
  assert.equal('workerModel' in checked.state.tasks.get('t_a'), false, 'a refused model is not stored');
  assert.equal((await checked.workers.start('p1', 't_a', { workerModel: 'codex:gpt-a@high' })).backend, 'codex');
});

test('codex worker: at its turn\'s end the studio keeps the version of the finish it recorded, then reports; a failure is a truthful did not finish', async () => {
  const kept = [];
  const done = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra@xhigh' } }, tasksExtra: {
    dropFinishRequest: async (_p, tid) => { kept.push(`dropped ${tid}`); },
    completeFinishRequest: async (_c, tid) => { kept.push(`completed ${tid}`); Object.assign(done.state.tasks.get(tid), { status: 'review', result: { summary: 'Added the note', versionId: 'v_1', verification: ['read it back'] } }); return { version: { id: 'v_1' } }; },
  } });
  done.task('t_a');
  await done.workers.start('p1', 't_a');
  assert.deepEqual(kept, ['dropped t_a'], 'a finish recorded by an earlier round is dropped before the worker starts');
  done.state.tasks.get('t_a').status = 'working'; // the worker ran task start; its task finish only recorded the finish
  await done.workerEnds('cs_w1', 't_a', {}, 'p1', 'codex');
  assert.deepEqual(kept, ['dropped t_a', 'completed t_a']);
  assert.match(done.state.sent.at(-1).text, /Worker report for task t_a "Task t_a": finished, ready to review\. Summary: Added the note Version: #7 Done thing\. Verified: read it back\./);

  const failing = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra@xhigh' } }, tasksExtra: { completeFinishRequest: async () => { throw new Error('git commit failed: disk full'); } } });
  failing.task('t_a');
  await failing.workers.start('p1', 't_a');
  failing.state.tasks.get('t_a').status = 'working';
  await failing.workerEnds('cs_w1', 't_a', {}, 'p1', 'codex');
  assert.match(failing.state.sent.at(-1).text, /did not finish: it recorded its finish, but the studio could not keep the version: git commit failed: disk full\. Its work is on disk, not committed, and the recorded finish is kept\./);

  // No finish recorded and a refused command: the report names the refusal instead of waiting for an approval nobody can give.
  const refused = setup({ records: { p1: { workerModel: 'codex:gpt-6-astra@xhigh' } }, tasksExtra: { completeFinishRequest: async () => null } });
  refused.task('t_a');
  await refused.workers.start('p1', 't_a');
  refused.state.tasks.get('t_a').status = 'working';
  const turn = { text: 'The compile check cannot run in this sandbox, so I stopped.', events: [{ kind: 'tool', id: 'i1', name: 'Shell', summary: 'bash tools/compile.sh' }, { kind: 'tool-result', id: 'i1', name: 'Shell', ok: false, summary: 'mkdir: cannot create directory: Permission denied' }] };
  await refused.workerEnds('cs_w1', 't_a', turn, 'p1', 'codex');
  assert.match(refused.state.sent.at(-1).text, /did not finish: its turn ended without finishing \(status working\); its last words: "The compile check cannot run in this sandbox, so I stopped\."\. One of its commands failed or was refused; the last: `bash tools\/compile\.sh` → mkdir: cannot create directory: Permission denied\. Decide whether/);
  assert.equal(lastFailure({ events: [{ kind: 'tool', id: 'a', summary: 'ls' }, { kind: 'tool-result', id: 'a', ok: true }] }), '', 'a turn whose commands all worked names none');
  assert.match(lastFailure({ events: [{ kind: 'denied', id: 'b', name: 'Shell', summary: 'rm -rf /' }] }), /One of its commands failed or was refused; the last: `rm -rf \/` was refused\./);
  assert.match(reportText({ task: { id: 't_a', title: 'T', status: 'working' }, turn: { timedOut: true, error: 'timed out after 5400000 ms' } }), /did not finish: its turn timed out \(timed out after 5400000 ms\) before it finished\./);
  // A finished report says what a Codex worker's sandbox could not have checked; a Claude Code worker's does not.
  const finishedTask = { id: 't_a', title: 'T', status: 'review', result: { summary: 'Done', verification: ['read it back'] } };
  assert.match(reportText({ task: finishedTask, codex: true }), /Verified: read it back\. A Codex worker did this in Codex's sandbox: a check that needs the person's own account .* did not run there, .* before you accept\. Review it: /);
  assert.equal(reportText({ task: finishedTask }).includes(CODEX_FINISH_NOTE), false);
  assert.equal(reportText({ task: { id: 't_a', title: 'T', status: 'working' }, turn: {}, codex: true }).includes(CODEX_FINISH_NOTE), false, 'only a finish carries it');
});
