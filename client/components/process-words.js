// The Processes tab's model (components/process-graph.js draws it): a project as the hub, each run of the last hour
// as a node wired to it, and the edge's line says the run's state. The picker chooses whose runs: the open project,
// another project with runs this hour, or all of them, each under its own hub. No DOM, so the tests read it directly.
// Every word comes from GET /api/runs and the project list; nothing is inferred.
import { isRunning, agoWords, AXIS_MS } from './run-words.js';

export const MAX_NODES = 9; // one project on its own
export const MAX_PER_PROJECT = 6; // a project among all of them: two rows of three, then "n more"
export const OPEN = 'open'; // the picker's value for whichever project is open
export const ALL = 'all';
export const NO_PROJECT = 'No project'; // the hub of runs the server keeps with no projectId
export const KIND_MARK = { session: 'C', build: 'B', device: 'P', terminal: '>', utility: 'U' };
export const KIND_WORDS = { session: 'Claude Code', build: 'Build', device: 'Phone', terminal: 'Shell', utility: 'Utility' };

/** The edge of a run: working (dashed, moving), queued (dotted), waiting (dashed amber), done (solid), failed, stopped. */
export function edgeOf(r) {
  if (r.state === 'Waiting for you' || (r.state === 'Working' && r.waitsFor)) return 'waiting';
  return { Working: 'working', Queued: 'queued', Done: 'done', Failed: 'failed', Stopped: 'stopped' }[r.state] || 'stopped';
}

export const EDGE_WORDS = [
  ['working', 'Working'], ['queued', 'Queued'], ['waiting', 'Waiting for you'], ['done', 'Done'], ['failed', 'Failed'], ['stopped', 'Stopped'],
];

/** The runs of the last hour: still running (Working, Queued), or ended within the hour. */
const recentOf = (runs, now) => (runs || []).filter((r) => r && (isRunning(r) || (r.endedAt && now - Date.parse(r.endedAt) <= AXIS_MS)));
const keyOf = (r) => r.projectId || null;

function nodesOf(recent, now, max) {
  const startedAt = (r) => Date.parse(r.startedAt) || 0;
  const sorted = [...recent].sort((a, b) => (Number(isRunning(b)) - Number(isRunning(a))) || startedAt(b) - startedAt(a));
  const nodes = sorted.slice(0, max).map((r) => ({
    id: r.id, kind: r.kind, projectId: keyOf(r), mark: KIND_MARK[r.kind] || '•', kindWords: KIND_WORDS[r.kind] || r.kind,
    name: r.name || KIND_WORDS[r.kind] || 'Run', department: r.department || null, state: r.state, edge: edgeOf(r), live: isRunning(r),
    latest: r.latest || null, ago: agoWords(r.latestAt || r.startedAt, now),
  }));
  // live and ended count every recent run, shown or not, so a hub never reads fewer working than there are.
  return { nodes, live: sorted.filter(isRunning).length, ended: sorted.filter((r) => !isRunning(r)).length, hidden: Math.max(0, sorted.length - nodes.length) };
}

/**
 * processModel(runs, { projectId, now, max }) -> { nodes, live, ended, hidden } for one project: the runs still working
 * or queued first (newest first), then the ones that ended within the hour, at most `max`. Each node:
 * { id, kind, projectId, mark, kindWords, name, department, state, edge, live, latest, ago }. live and ended count every recent
 * run of the project, shown or not; hidden is how many the cap left out.
 */
export function processModel(runs, { projectId, now = Date.now(), max = MAX_NODES } = {}) {
  return nodesOf(recentOf(runs, now).filter((r) => keyOf(r) === (projectId || null)), now, max);
}

/**
 * allProjectsModel(runs, projects, { activeId, now, max }) -> { groups, live, ended } with one group per project that
 * has runs this hour: { projectId, name, open, nodes, live, ended, hidden }. The open project comes first, then the
 * order of the project list (the rail's), then runs of projects the list no longer holds, then runs with no project.
 * The order does not follow states, so a group stays where the eye left it while its runs change.
 */
export function allProjectsModel(runs, projects = [], { activeId = null, now = Date.now(), max = MAX_PER_PROJECT } = {}) {
  const byKey = new Map();
  for (const r of recentOf(runs, now)) {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const list = projects || [];
  const names = new Map(list.map((p) => [p.id, p.name || p.id]));
  const known = [activeId, ...list.map((p) => p.id)].filter((id) => id && byKey.has(id));
  const rest = [...byKey.keys()].filter((k) => k !== null && !known.includes(k)).sort();
  const keys = [...new Set([...known, ...rest]), ...(byKey.has(null) ? [null] : [])];
  const groups = keys.map((k) => ({
    projectId: k, name: k === null ? NO_PROJECT : names.get(k) || k, open: k !== null && k === activeId,
    ...nodesOf(byKey.get(k), now, max),
  }));
  return { groups, live: groups.reduce((s, g) => s + g.live, 0), ended: groups.reduce((s, g) => s + g.ended, 0) };
}

/** A node's detail line: what it is, the department of the task it works on, and (among all projects) whose it is. */
export const nodeDetail = (n, projectName = null) => [n.kindWords, n.department ? `${n.department} department` : null, projectName].filter(Boolean).join(' · ');

/** "1 working", "3 ended", "1 working · 2 ended", or "" when there is nothing. */
export function countWords({ live = 0, ended = 0 } = {}) {
  return [live ? `${live} working` : '', ended ? `${ended} ended` : ''].filter(Boolean).join(' · ');
}

/**
 * The picker's options: [{ value, label, projectId }]. The open project first (value OPEN), then each other project
 * with runs this hour, with its counts ("Atelier (studio) · 1 working"), then All projects (value ALL).
 */
export function projectChoices(runs, projects = [], { activeId = null, now = Date.now() } = {}) {
  const all = allProjectsModel(runs, projects, { activeId, now });
  const openName = (projects || []).find((p) => p.id === activeId)?.name || 'This project';
  const label = (name, g) => [name, g ? countWords(g) : ''].filter(Boolean).join(' · ');
  const out = [{ value: OPEN, label: label(`${openName} (open)`, activeId && all.groups.find((g) => g.projectId === activeId)), projectId: activeId }];
  for (const g of all.groups) {
    if (activeId && g.projectId === activeId) continue;
    out.push({ value: g.projectId === null ? NO_PROJECT : g.projectId, label: label(g.name, g), projectId: g.projectId });
  }
  out.push({ value: ALL, label: label('All projects', all), projectId: null });
  return out;
}

/**
 * Which view a kept choice gives now: { value, projectId, all, fellBack }. The open project's own id reads as OPEN;
 * a project with nothing this hour (or no longer listed) falls back to the open project with fellBack true, so the
 * choice can stay kept for the session and come back when that project runs again.
 */
export function resolveChoice(choice, choices, activeId = null) {
  if (choice === ALL) return { value: ALL, projectId: null, all: true, fellBack: false };
  if (!choice || choice === OPEN || (activeId && choice === activeId)) return { value: OPEN, projectId: activeId, all: false, fellBack: false };
  const hit = (choices || []).find((c) => c.value === choice && c.value !== OPEN && c.value !== ALL);
  if (hit) return { value: hit.value, projectId: hit.projectId, all: false, fellBack: false };
  return { value: OPEN, projectId: activeId, all: false, fellBack: true };
}

/** A run's progress reports, kept in the browser as its latest action changes: newest last, at most `keep`. */
export function addReport(log, run, at = Date.now(), keep = 8) {
  if (!run?.id || !run.latest) return false;
  const list = log.get(run.id) || [];
  if (list.length && list[list.length - 1].text === run.latest) return false;
  list.push({ text: run.latest, at });
  if (list.length > keep) list.splice(0, list.length - keep);
  log.set(run.id, list);
  return true;
}

/** Forgets the reports of runs the server no longer lists, and only those: the log is keyed by run, not by project. */
export function pruneReports(log, runs) {
  const ids = new Set((runs || []).map((r) => r?.id));
  let gone = 0;
  for (const id of [...log.keys()]) if (!ids.has(id)) { log.delete(id); gone++; }
  return gone;
}
