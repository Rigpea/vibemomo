// Runs: what is running in the studio now, and what ran in the last 24 hours this process still remembers.
// Contract: docs/ARCHITECTURE.md section 16. A run is only what a server hook reported: console.mjs (a session's
// turn), devices/android.mjs (a build, a boot), terminal.mjs (a shell), live.mjs (a project's live server) and api-utility (a utility run) call
// start/update/end here, and every change is one runs.changed event. Nothing polls and nothing is stored on disk:
// a restart forgets the finished runs, and the list says since when it knows.
import { newId } from './paths.mjs';
import { toolVerb, toolObject, questionWords, asksQuestion } from '../../client/components/companion-words.js';
import { durationWords } from '../../client/components/run-words.js';

export const RUN_KINDS = ['session', 'build', 'device', 'terminal', 'utility', 'live'];
export const RUN_STATES = ['Working', 'Queued', 'Waiting for you', 'Done', 'Failed', 'Stopped'];
export const FINISHED_STATES = ['Waiting for you', 'Done', 'Failed', 'Stopped'];
export const KEEP_MS = 24 * 3600 * 1000;
export const KEEP_PER_PROJECT = 50;

/** A reason or a latest action in a few words: the first line, cut at `max` characters. */
export function firstWords(text, max = 80) {
  const s = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A session's tool call as its latest action: "Read copy.mjs", "Run npm test", "Phone screenshot". */
export const toolWords = (name, summary) => firstWords([toolVerb(name), toolObject(summary, name)].filter(Boolean).join(' '), 80);

/** A shell's name as the person knows it: pwsh, powershell, bash (no folder, no .exe). */
export const shellName = (shell) => String(shell || 'shell').split(/[\\/]/).pop().replace(/\.exe$/i, '') || 'shell';

/** A session's name: the task's title for a task-bound session (its title is "Task · <title>"), else its title or model. */
export function sessionName(rec) {
  const title = String(rec?.title || '').trim();
  if (rec?.taskId && /^Task · /.test(title)) return title.slice('Task · '.length);
  return title || rec?.model || 'Session';
}

/**
 * How a session's turn ended, from the turn as console.mjs finished it: { state, reason, waitsFor }.
 * Cancelled by the person: Stopped. Timed out: Stopped with the limit. An error: Failed with its first words.
 * An answer whose last paragraph asks a question: Waiting for you with the question's first words. Else Done.
 */
export function sessionEnd(turn = {}) {
  if (turn.timedOut) return { state: 'Stopped', reason: firstWords(turn.error || 'timed out'), waitsFor: null };
  if (turn.cancelled) return { state: 'Stopped', reason: 'you stopped it', waitsFor: null };
  if (turn.isError || turn.error) return { state: 'Failed', reason: firstWords(turn.error || 'the run ended with an error'), waitsFor: null };
  // The same rule as the app bar's "needs you" (companion-words.js): the last paragraph ends with "?".
  if (asksQuestion(turn.text)) return { state: 'Waiting for you', reason: questionWords(turn.text), waitsFor: 'you' };
  return { state: 'Done', reason: null, waitsFor: null };
}

/**
 * The registry. emit(type, payload) is the server's SSE emit; now() is ms. Each run is
 * { id, kind, projectId, name, department, state, reason, startedAt, endedAt, latest, latestAt, waitsFor };
 * department is the skill department's name of the task a session works on (null otherwise).
 * start/update/end return the row (or null); each change emits runs.changed { projectId, run } once,
 * and a call that changes nothing emits nothing.
 */
export function createRunRegistry({ emit = null, now = () => Date.now(), keepMs = KEEP_MS, cap = KEEP_PER_PROJECT } = {}) {
  const runs = new Map(); // id -> run
  const since = new Date(now()).toISOString();
  let sink = emit;
  const iso = () => new Date(now()).toISOString();

  const row = (r) => {
    const { seq: _seq, ...out } = r;
    // A shell says how long it has been open; that is its latest action while nothing else is known.
    if (r.kind === 'terminal' && !r.endedAt) { out.latest = `open ${durationWords(now() - Date.parse(r.startedAt))}`; out.latestAt = iso(); }
    return out;
  };
  const changed = (r) => { try { sink?.('runs.changed', { projectId: r.projectId, run: row(r) }); } catch { /* events never break a run */ } };

  function prune() {
    const cutoff = now() - keepMs;
    const perProject = new Map();
    for (const r of runs.values()) {
      if (!r.endedAt) continue;
      if (Date.parse(r.endedAt) < cutoff) { runs.delete(r.id); continue; }
      const key = r.projectId || '';
      if (!perProject.has(key)) perProject.set(key, []);
      perProject.get(key).push(r);
    }
    for (const list of perProject.values()) {
      if (list.length <= cap) continue;
      list.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || (b.seq - a.seq));
      for (const r of list.slice(cap)) runs.delete(r.id);
    }
  }

  let seq = 0;
  function start({ id = null, kind, projectId = null, name, department = null, latest = null, waitsFor = null, state = 'Working' } = {}) {
    if (!RUN_KINDS.includes(kind)) throw new Error(`run kind must be one of ${RUN_KINDS.join(', ')}`);
    if (!['Working', 'Queued'].includes(state)) throw new Error('a run starts Working or Queued');
    const runId = id || newId(`run_${kind}_`);
    const at = iso();
    const r = { id: runId, kind, projectId: projectId || null, name: firstWords(name || kind, 80), department: department ? firstWords(department, 40) : null, state, reason: null, startedAt: at, endedAt: null, latest: latest ? firstWords(latest) : null, latestAt: latest ? at : null, waitsFor: waitsFor || null, seq: ++seq };
    runs.set(runId, r);
    changed(r);
    return row(r);
  }

  /** name, latest, waitsFor, state (Working or Queued) and reason of a run that has not ended. */
  function update(id, patch = {}) {
    const r = runs.get(id);
    if (!r || r.endedAt) return null;
    let diff = false;
    const set = (k, v) => { if (r[k] !== v) { r[k] = v; diff = true; } };
    if ('name' in patch && patch.name) set('name', firstWords(patch.name, 80));
    if ('state' in patch && ['Working', 'Queued'].includes(patch.state)) set('state', patch.state);
    if ('reason' in patch) set('reason', patch.reason ? firstWords(patch.reason) : null);
    if ('waitsFor' in patch) set('waitsFor', patch.waitsFor || null);
    if ('latest' in patch) {
      const l = patch.latest ? firstWords(patch.latest) : null;
      if (l !== r.latest) { r.latest = l; r.latestAt = iso(); diff = true; }
    }
    if (diff) changed(r);
    return row(r);
  }

  /** A run ends once: Done, Failed, Stopped or Waiting for you, with its reason. A second end changes nothing. */
  function end(id, { state, reason = null, latest, waitsFor = null } = {}) {
    const r = runs.get(id);
    if (!r || r.endedAt) return null;
    if (!FINISHED_STATES.includes(state)) throw new Error(`a run ends ${FINISHED_STATES.join(', ')}`);
    const at = iso();
    Object.assign(r, { state, reason: reason ? firstWords(reason) : null, endedAt: at, waitsFor: waitsFor || null });
    if (latest !== undefined) { r.latest = latest ? firstWords(latest) : null; r.latestAt = at; }
    changed(r);
    prune();
    return row(r);
  }

  /** A placeholder that never ran (a queued worker that has now started as its own run): gone from the list. */
  function remove(id) {
    const r = runs.get(id);
    if (!r) return false;
    runs.delete(id);
    try { sink?.('runs.changed', { projectId: r.projectId, run: { ...row(r), removed: true } }); } catch { /* events never break a run */ }
    return true;
  }

  const get = (id) => (runs.has(id) ? row(runs.get(id)) : null);

  /** The runs of a project (or every project with 'all' or no id), running first, then newest ended first. */
  function list({ projectId = 'all' } = {}) {
    prune();
    const all = !projectId || projectId === 'all';
    const out = [...runs.values()].filter((r) => all || r.projectId === projectId)
      .sort((a, b) => (!!a.endedAt - !!b.endedAt) || (Date.parse(b.endedAt || b.startedAt) - Date.parse(a.endedAt || a.startedAt)) || (b.seq - a.seq))
      .map(row);
    const young = now() - Date.parse(since) < keepMs;
    return { runs: out, since, keepHours: keepMs / 3600000, note: young ? `since the studio started at ${since}` : null };
  }

  return { start, update, end, remove, get, list, setEmit: (fn) => { sink = fn; }, since };
}

/** The studio's one registry. index.mjs gives it the SSE emit; tests make their own with createRunRegistry. */
export const runs = createRunRegistry();
