// Task records: the resumable handoff between the studio and Claude Code.
// Everything is a file under <project>/.studio/tasks/<id>/ so both sides can
// read and write it; status is derived from recorded events, never asserted.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { STUDIO_DIR, newId, nowIso, HttpError } from './paths.mjs';
import { readJson, writeJson, writeText, ensureDir, appendJsonl, readJsonl, exists } from './fsutil.mjs';
import { studioPath, stores, saveProject, withProjectRecord, readManifest } from './projects.mjs';
import { listMemory } from './memory.mjs';
import { versionAtHead, listVersions, checkpoint, adoptHead, changes } from './versions.mjs';
import * as git from './git.mjs';
import { resolveTaskDepartment, departmentSkills } from './departments.mjs';
import { departmentPrompt } from '../../client/components/skill-departments.js';
import { checkWorkerModel, ownWorkerModel, workerWords } from './models.mjs';
import { briefBoard } from './inspiration.mjs';
import { briefRules } from './rules.mjs';
import { briefRefs, taskWords } from './references.mjs';

export const MODES = ['teach', 'explore', 'handle'];
export const ROUTES = ['claude-code', 'api-utility', 'direct'];
export const STALE_MS = 30 * 60 * 1000;

export const CLI = path.join(STUDIO_DIR, 'bin', 'atelier.mjs');
export const cliCommand = (args) => `node "${CLI}" ${args}`;

const taskDir = (projectPath, tid) => studioPath(projectPath, 'tasks', tid);

export { taskIdFromPath } from './watch-events.mjs';

export async function appendEvent(projectPath, tid, type, actor, data = {}) {
  await appendJsonl(path.join(taskDir(projectPath, tid), 'events.jsonl'), { ts: nowIso(), type, actor, data });
}

async function readTask(projectPath, tid) {
  const task = await readJson(path.join(taskDir(projectPath, tid), 'task.json'), null);
  if (!task) throw new HttpError(404, 'not_found', `Task ${tid} not found`);
  return task;
}

async function saveTask(projectPath, task) {
  task.updatedAt = nowIso();
  await writeJson(path.join(taskDir(projectPath, task.id), 'task.json'), task);
  return task;
}

/** Status shown to people: the stored status, except a stale "working" shows as interrupted. */
export function effectiveStatus(task, now = Date.now()) {
  if (task.status === 'working' && task.heartbeatAt && now - Date.parse(task.heartbeatAt) > STALE_MS) return 'interrupted';
  return task.status;
}

export const STATUS_LABELS = {
  draft: 'Draft',
  ready: 'Ready for Claude Code',
  working: 'Working',
  review: 'Ready to try',
  done: 'Done',
  'needs-input': 'Needs your input',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

export async function listTasks(projectPath) {
  const dir = studioPath(projectPath, 'tasks');
  if (!(await exists(dir))) return [];
  const names = await fsp.readdir(dir);
  const out = [];
  for (const n of names) {
    const t = await readJson(path.join(dir, n, 'task.json'), null);
    // startedAt and finishedAt ride every list, so a row or the version strip knows when a task ran without the detail.
    if (t) out.push({ ...t, status: effectiveStatus(t), storedStatus: t.status, startedAt: t.startedAt || null, finishedAt: t.result?.finishedAt || null });
  }
  if (out.some((t) => t.result)) {
    const versions = await listVersions(projectPath);
    for (const t of out) if (t.result) t.result = withVersionFacts(t.result, versions);
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** Every version a result names; a result from before versionIds has only versionId. */
const resultVersionIds = (result) => (result?.versionIds?.length ? result.versionIds : result?.versionId ? [result.versionId] : []);

/** A result as people read it: the number and the role of every version it names, null for one that is gone
 *  or has no role. Derived on read and never stored. */
function withVersionFacts(result, versions) {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const ids = resultVersionIds(result);
  return { ...result, versionNumbers: ids.map((id) => byId.get(id)?.n ?? null), versionRoles: ids.map((id) => byId.get(id)?.role ?? null) };
}

/** The most recent recorded event, for task summaries. */
export async function lastEvent(projectPath, tid) {
  const events = await readJsonl(path.join(taskDir(projectPath, tid), 'events.jsonl'));
  const e = events[events.length - 1];
  return e ? { type: e.type, ts: e.ts, actor: e.actor } : null;
}

export async function getTask(projectPath, tid) {
  const task = await readTask(projectPath, tid);
  const events = await readJsonl(path.join(taskDir(projectPath, tid), 'events.jsonl'));
  let brief = '';
  try {
    brief = await fsp.readFile(path.join(taskDir(projectPath, tid), 'brief.md'), 'utf8');
  } catch {
    brief = '';
  }
  brief = await caughtUpBrief(projectPath, task, brief);
  const result = await readJson(path.join(taskDir(projectPath, tid), 'result.json'), null);
  // Names for every version this task mentions, so a row of another project can show them too.
  const ids = new Set([task.result?.versionId, ...(task.result?.versionIds || []), ...events.flatMap((e) => [e.data?.versionId, ...(e.data?.versionIds || [])])].filter(Boolean));
  const versionNames = {};
  const versions = ids.size ? await listVersions(projectPath) : [];
  for (const v of versions) if (ids.has(v.id)) versionNames[v.id] = `#${v.n} ${v.label}`;
  return { task: { ...task, ...(task.result ? { result: withVersionFacts(task.result, versions) } : {}), status: effectiveStatus(task), storedStatus: task.status }, events, brief, result, versionNames };
}

const VERSION_WORDS = 'In notes and in the result, refer to versions by their number, #n, as the checkpoint command prints it.';

/** A started explore task's base that stayed without a version, in the brief, the Chat prompt and the CLI alike. */
export const keptBareBase = (sha) => `The task's base is commit ${String(sha).slice(0, 8)} with no version: this started task already has work on it. Go on from the files on disk; options made from here cannot be restored to a base, so they sit in one line.`;

/** How an explore session makes its options, in the brief and the Chat prompt alike: each from the base,
 *  so they are siblings in git. A handover gives the base a version; a brief read without one (Copy command)
 *  sends the session to the same step, so the base is never a checkpoint of its own that could count as an option.
 *  keptSha: the commit a started task with work on it keeps as its base, where that step can give it no version. */
function exploreSteps(tid, baseVersionId, keptSha = null) {
  const save = `checkpoint it with \`${cliCommand(`checkpoint --task ${tid} --label "..."`)}\``;
  if (!baseVersionId && keptSha) return `${keptBareBase(keptSha)} When an option is ready, ${save}. ${VERSION_WORDS}`;
  if (!baseVersionId) return `The task's base has no version yet. Before anything else run \`${cliCommand(`task handover ${tid}`)}\`: the studio keeps the files as the base and writes its id into the brief. Then read the brief again and follow it. ${VERSION_WORDS}`;
  const back = `The task's base is version ${baseVersionId}. Make each option from the base; ${save}; before starting the next option run \`${cliCommand(`restore ${baseVersionId}`)}\``;
  return `${back}; when the options are done, restore to the base once more and finish on a clean tree. Every option is then a sibling in git, and Compare side by side shows real alternatives. ${VERSION_WORDS}`;
}

function bullet(items, empty = '_none recorded_') {
  const arr = (items || []).filter((x) => x && String(typeof x === 'string' ? x : x.text || '').trim());
  if (!arr.length) return `- ${empty}`;
  return arr.map((x) => `- ${typeof x === 'string' ? x : x.text}`).join('\n');
}

/** The brief's Inspiration section: what the person typed for this task, then the project's board as lines
 *  (server/lib/inspiration.mjs briefLines: tagged cards first, capped). '' when there is neither. */
function inspirationSection(task, board = []) {
  const parts = [task.inspiration || '', (board || []).join('\n')].filter(Boolean);
  return parts.length ? `## Inspiration\n${parts.join('\n\n')}\n` : '';
}

/** The brief's "Must stay the same" section: the project's fixed rules as lines (server/lib/rules.mjs briefLines;
 *  with no rules, the one sentence saying so). '' only when the caller read no rules at all. */
const rulesSection = (rules) => (Array.isArray(rules) && rules.length ? `## Must stay the same\n${rules.join('\n')}\n\n` : '');

/** The brief's References section: the project's references that match this task's request (server/lib/
 *  references.mjs briefLines: tag matches first, capped). '' when the project keeps none. A blank line stands
 *  between it and a section before or after it. */
function referencesSection(refs, { after = false, before = false } = {}) {
  if (!Array.isArray(refs) || !refs.length) return '';
  return `${after ? '\n' : ''}## References\n${refs.join('\n')}\n${before ? '\n' : ''}`;
}

/** ctx.board: the inspiration board's lines as they are when the brief is written (at create and at every handover);
 *  ctx.rules: the fixed rules' lines and ctx.refs: the matching references' lines, read at the same moments. */
export function renderBrief(task, ctx) {
  const { project, manifest, entry, version } = ctx;
  const modeText = {
    teach: 'TEACH ME: explain what you do and why as you go; keep steps small; leave readable comments; prefer showing one concept at a time.',
    explore: `EXPLORE ALTERNATIVES WITH ME: produce 2-3 distinct options as separate versions, each with a clear label. ${exploreSteps(task.id, task.context?.baseVersionId, ctx.baseKept ? task.context?.baseSha : null)} Note tradeoffs with task note, do not pick for me.`,
    handle: 'HANDLE THE IMPLEMENTATION: make routine engineering choices yourself; report what changed and how it was verified.',
  }[task.mode] || '';
  const prefs = (task.context.preferences || []).map((p) => `- ${p.text} _(${p.status}, ${p.scope})_`).join('\n') || '- _none recorded_';
  const decisions = (task.context.decisions || []).map((d) => `- ${d.text}${d.reason ? ` — because ${d.reason}` : ''}`).join('\n') || '- _none recorded_';
  const resources = (task.context.resources || []).map((r) => `- ${r.name} (${r.status}) ${r.url || ''}`).join('\n') || '- _none recorded_';
  const cli = (args) => cliCommand(args);
  return `# Studio task ${task.id}: ${task.title}

Mode: **${task.mode}** — ${modeText}
Route: ${task.route} · Created ${task.createdAt}${task.department ? `\nDepartment: **${task.department.name}**` : ''}

## Request
${task.request}

${rulesSection(ctx.rules)}${inspirationSection(task, ctx.board)}${referencesSection(ctx.refs, { after: !!inspirationSection(task, ctx.board), before: !!ctx.department })}${ctx.department ? `## Department\n${departmentPrompt(ctx.department)}\n\n` : ''}
## Project
- Name: ${project.name} (${project.kind}) · id ${project.id}
- Folder: \`${entry.path}\`
- Manifest: \`atelier.json\` → entry \`${manifest.entry || '?'}\`${manifest.tuning ? `, tuning \`${manifest.tuning}\`` : ''}
- Studio: \`${STUDIO_DIR}\`
- Current source version: ${version ? `#${version.n} "${version.label}" (${version.sha.slice(0, 10)}, state ${version.state})` : 'no checkpoint yet'}
- Purpose: ${project.purpose || '_not set_'}
- Audience: ${project.audience || '_not set_'}
- Direction: ${project.direction || '_not set_'}

## Current piece (context)
The project's current piece and next release, for orientation; they are not this task's acceptance conditions.
- Current piece: ${project.currentPiece?.title || '_not set_'}${project.currentPiece?.why ? ` — ${project.currentPiece.why}` : ''}
${bullet(project.currentPiece?.acceptance, 'no acceptance conditions recorded')}
- Next release: ${project.nextRelease?.title || '_not set_'}
${bullet(project.nextRelease?.definition, 'no release definition recorded')}

## Scope
${task.scope || 'As requested above; keep changes inside this project folder.'}

## Acceptance conditions
${bullet(task.acceptance, 'none stated; verify what the request asks for')}

## Preferences and constraints that apply (explicit vs inferred is marked)
${prefs}

## Accepted decisions
${decisions}

## Relevant files
${bullet(task.context.files, 'start from the entry file')}

## Resources
${resources}

## Unresolved before this task
${bullet(task.unresolved)}

## How to report back (required)
Run these from any folder; they only write records under \`.studio/tasks/${task.id}/\`.

1. Before anything else: \`${cli(`task handover ${task.id}`)}\`
   This sets the task's base to the files as they are now. If the base is already set it changes nothing; if it answers that the brief says so now, read the brief again.
2. Then, before starting: \`${cli(`task start ${task.id}`)}\`
3. Progress notes: \`${cli(`task note ${task.id} "what you did"`)}\`
4. If you need my decision: \`${cli(`task question ${task.id} "the question"`)}\` and stop.
5. When done: \`${cli(`task finish ${task.id} --summary "..." --verification "what you ran and saw" [--unresolved "..."] [--decision "text | reason"]`)}\`
   This checkpoints your changes as a new version (origin claude-code) and marks the task "Ready to try". If no file changed, no version is made and the result says so.

Rules: edit sources, not \`.studio/\`; keep work inside the project folder; a claim of success must name the command or check that showed it.
`;
}

export async function buildContext({ path: projectPath, project, manifest, entry }) {
  const version = await versionAtHead(projectPath);
  const memory = await listMemory({ scope: 'all', projectPath, projectId: project.id, limit: 40 });
  const preferences = memory.filter((m) => ['preference', 'constraint', 'method', 'lesson', 'observation'].includes(m.kind)).map((m) => ({ id: m.id, text: m.text, status: m.status, scope: m.scope, kind: m.kind }));
  const decisions = (await stores(projectPath).decisions.all()).filter((d) => d.status === 'accepted').map((d) => ({ id: d.id, text: d.text, reason: d.reason }));
  const resources = (await stores(projectPath).resources.all()).filter((r) => ['tested', 'used', 'available'].includes(r.status)).map((r) => ({ id: r.id, name: r.name, status: r.status, url: r.url }));
  return {
    version,
    context: {
      workspacePath: entry.path,
      studioPath: STUDIO_DIR,
      baseVersionId: version?.id || null,
      baseSha: version?.sha || (await git.headSha(projectPath)),
      currentPiece: project.currentPiece,
      nextRelease: project.nextRelease,
      preferences,
      decisions,
      constraints: preferences.filter((p) => p.kind === 'constraint').map((p) => p.text),
      resources,
    },
  };
}

/** Text cut at a word boundary to at most max chars, the ellipsis included, so a cut is visible
 *  (hard cut when the first word is longer). */
export function shortLabel(text, max = 80) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max); // max - 1 chars of text, and the char after them to see a word end
  const i = cut.lastIndexOf(' ');
  return `${(i > 0 ? cut.slice(0, i) : t.slice(0, max - 1)).replace(/[\s,;:.\-–—…]+$/, '')}…`;
}

const FILE_RE = /(?:[\w-]+\/)*[\w.-]+\.(?:m?js|css|html?|json|md|ts|txt|png|jpg|svg|wav|mp3)/g;

/** Paths with a known extension named in the request, deduplicated, at most 12. */
export function filesInRequest(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FILE_RE)) {
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= 12) break;
  }
  return out;
}

/** The first sentence when it fits a title; otherwise all of the text, for shortLabel to cut on a word. */
function firstSentence(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const m = t.match(/^(.{12,119}?[.!?])(\s|$)/);
  return m ? m[1] : t;
}

export async function createTask(ctx, input) {
  const { path: projectPath, project } = ctx;
  if (!input.request || !String(input.request).trim()) throw new HttpError(400, 'invalid_input', 'A request is required');
  const mode = MODES.includes(input.mode) ? input.mode : 'handle';
  const route = ROUTES.includes(input.route) ? input.route : 'claude-code';
  const department = await resolveTaskDepartment(input.department);
  const workerModel = checkWorkerModel(input.workerModel); // a 400 naming the choices, before anything is written
  const { version, context } = await buildContext(ctx);
  const given = Array.isArray(input.files) ? input.files.filter((f) => typeof f === 'string' && f.trim()) : [];
  context.files = [...new Set([...filesInRequest(input.request), ...given])];
  const id = newId('t');
  const task = {
    id,
    projectId: project.id,
    title: shortLabel(input.title || firstSentence(input.request), 120),
    request: String(input.request).trim(),
    inspiration: typeof input.inspiration === 'string' ? input.inspiration.trim() : '', // only what the person typed
    ...(department ? { department } : {}), // { id, name } of a studio skill department (server/lib/departments.mjs)
    ...(workerModel ? { workerModel } : {}), // this task's own worker model; absent: the project's, else the studio default
    mode,
    route,
    status: 'ready',
    context,
    scope: input.scope || '',
    acceptance: Array.isArray(input.acceptance) ? input.acceptance.map((x) => String(typeof x === 'string' ? x : x?.text ?? '').trim()).filter(Boolean) : [], // the task's own; the current piece is context in the brief
    unresolved: Array.isArray(input.unresolved) ? input.unresolved : (project.unresolved || []).map((u) => u.text),
    result: null,
    question: null,
    startedAt: null,
    heartbeatAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await ensureDir(taskDir(projectPath, id));
  await saveTask(projectPath, task);
  await writeText(path.join(taskDir(projectPath, id), 'brief.md'), renderBrief(task, { ...ctx, version, department: await briefDepartment(projectPath, task), board: await briefBoard(projectPath), rules: await briefRules(projectPath), refs: await briefRefs(projectPath, taskWords(task)) }));
  await appendEvent(projectPath, id, 'created', 'studio', { mode, route, ...(workerModel ? { workerModel } : {}) });
  await appendEvent(projectPath, id, 'ready', 'studio', {});
  return task;
}

/**
 * A task's own worker model (server/lib/workers.mjs reads it at every launch): a CONSOLE_MODELS id or a Codex value
 * (codex:<model>[@<effort>], server/lib/models.mjs) is stored, null or 'default' removes it, anything else is a 400
 * that writes nothing. A change is recorded as a worker_model event.
 */
export async function setTaskWorkerModel(projectPath, tid, value, actor = 'studio') {
  const model = checkWorkerModel(value);
  const task = await readTask(projectPath, tid);
  const before = ownWorkerModel(task);
  if (model === before && (model || !('workerModel' in task))) return { task, changed: false };
  if (model) task.workerModel = model; else delete task.workerModel;
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'worker_model', actor, { model, before, text: model ? `workers of this task start on ${workerWords(model)}` :'no model of its own now: its project\'s, else the studio default' });
  return { task, changed: true };
}

const CLOSED = ['done', 'cancelled', 'review'];

/** A session's work is not a base: a task that started and is not closed keeps its base while HEAD is its own
 *  version, or has no version (a hand commit the finish will adopt, or edits no one has kept). One case moves
 *  on: an explore task with no base version, still clean on its base commit, has no work to mistake for a base.
 *  It is how a session that ran task start first still gets one: a command copied before the handover came first, or the two run out of order. */
async function baseStays(dir, task, version) {
  if (!task.startedAt || CLOSED.includes(task.status)) return false;
  if (version) return isTasksVersion(dir, version, task, task.context?.baseSha || null, version.sha);
  if (task.mode !== 'explore' || task.context?.baseVersionId) return true;
  const { dirty, headSha } = await changes(dir);
  return dirty || headSha !== task.context?.baseSha;
}

/** HEAD with no version record, kept by the studio so an explore session has something to restore to.
 *  Origin studio and no taskId, so it is never an option. A clean tree adopts HEAD: a checkpoint would be an empty commit. */
async function keepBase(ctx, task) {
  const words = String(task.title || '').trim().split(/\s+/).slice(0, 6).join(' ').replace(/[\s,;:.\-–—…]+$/, '');
  const record = { label: `Base for ${words}`, note: `Kept by the studio as the base of task ${task.id}`, origin: 'studio', state: 'experiment' };
  const { dirty, headSha } = await changes(ctx.path);
  return !dirty && headSha ? adoptHead(ctx, record) : checkpoint(ctx, record);
}

/** The base is what the session will find: HEAD now, not HEAD when the task was written down. The brief is
 *  written again with any answers it has collected, also when the same commit only gained a version: the brief
 *  then has a version to name, though nothing moved and no event says so. True when the base changed. A bare
 *  base that stays at a handover moves nothing, but the brief must stop sending the session to the handover. */
async function moveBase(ctx, task, { keep = false } = {}) {
  let version = await versionAtHead(ctx.path);
  if (await baseStays(ctx.path, task, version)) {
    if (keep && task.mode === 'explore' && !task.context?.baseVersionId) await rewriteBrief(ctx, task, version);
    return false;
  }
  if (!version && keep && task.mode === 'explore') version = await keepBase(ctx, task);
  const sha = version?.sha || (await git.headSha(ctx.path));
  const sameCommit = sha === task.context?.baseSha;
  if (sameCommit && (task.context?.baseVersionId || !version)) return false; // one commit can have two records
  task.context = { ...task.context, baseVersionId: version?.id || null, baseSha: sha };
  await saveTask(ctx.path, task);
  if (!sameCommit) await appendEvent(ctx.path, task.id, 'base_moved', 'studio', { text: `to ${version ? `#${version.n}, the version` : `commit ${String(sha).slice(0, 8)}, the commit`} at ${keep ? 'handover' : 'reopen'}`, baseVersionId: task.context.baseVersionId, baseSha: sha });
  await rewriteBrief(ctx, task, version);
  return true;
}

/** The brief's Department section: what the task's department holds when the brief is written (at create and at
 *  every handover), or null. A skill listing that fails leaves the section out rather than the brief unwritten. */
async function briefDepartment(projectPath, task) {
  if (!task.department) return null;
  try { return await departmentSkills(projectPath, task.department); } catch { return null; }
}

/** The worker's and the Chat session's paragraph naming the task's department and its skills ('' without one). */
export async function departmentParagraph(projectPath, task) {
  const facts = await briefDepartment(projectPath, task);
  return facts ? departmentPrompt(facts) : '';
}

/** The brief written again from the records, with the answers it has collected, which live only in the file.
 *  The file is read and written in one turn of the queue answerTask also waits in, so an answer cannot fall between. */
async function rewriteBrief(ctx, task, version) {
  const baseKept = task.mode === 'explore' && !task.context?.baseVersionId && await baseStays(ctx.path, task, version);
  const file = path.join(taskDir(ctx.path, task.id), 'brief.md');
  return withProjectRecord(ctx.path, async () => {
    const brief = await fsp.readFile(file, 'utf8').catch(() => '');
    const answers = brief.indexOf('\n## Answer from the user (', brief.indexOf('## How to report back'));
    const text = renderBrief(task, { ...ctx, version, baseKept, department: await briefDepartment(ctx.path, task), board: await briefBoard(ctx.path), rules: await briefRules(ctx.path), refs: await briefRefs(ctx.path, taskWords(task)) }) + (answers < 0 ? '' : brief.slice(answers));
    if (text !== brief) await writeText(file, text);
    return text;
  });
}

/** A brief from before the handover step lists no such command, though every prompt says to run the one it lists.
 *  An open task's brief catches up when it is read. The command with the id, because a request may mention the words.
 *  A read must still answer if the catch-up cannot be done, so it then gets the brief as it was. */
async function caughtUpBrief(projectPath, task, brief) {
  if (!brief || ['done', 'cancelled'].includes(task.status) || brief.includes(`task handover ${task.id}`)) return brief;
  try {
    const project = await readJson(studioPath(projectPath, 'project.json'), null);
    if (!project) return brief;
    const ctx = { path: projectPath, project, manifest: await readManifest(projectPath), entry: { path: projectPath } };
    return await rewriteBrief(ctx, task, await versionAtHead(projectPath));
  } catch {
    return brief;
  }
}

/** Before a session gets the task: Run with Claude Code here, Open in Claude Code, or `task handover`.
 *  reason: 'closed' (handed to no one), 'moved' (the base changed) or 'kept' (it stayed). */
export async function handOverTask(ctx, tid) {
  const task = await readTask(ctx.path, tid);
  if (CLOSED.includes(task.status)) return { task, moved: false, reason: 'closed' };
  const moved = await moveBase(ctx, task, { keep: true });
  return { task, moved, reason: moved ? 'moved' : 'kept' };
}

export async function startTask(projectPath, tid, actor = 'claude-code') {
  const task = await readTask(projectPath, tid);
  if (['done', 'cancelled'].includes(task.status)) throw new HttpError(409, 'task_closed', `Task is ${task.status}`);
  task.status = 'working';
  task.startedAt = task.startedAt || nowIso();
  task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'started', actor, { sha: await git.headSha(projectPath) });
  return task;
}

export async function heartbeat(projectPath, tid, actor = 'claude-code') {
  const task = await readTask(projectPath, tid);
  task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'heartbeat', actor, {});
  return task;
}

export async function noteTask(projectPath, tid, text, actor = 'claude-code') {
  const task = await readTask(projectPath, tid);
  task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'note', actor, { text });
  return task;
}

export async function questionTask(projectPath, tid, text, actor = 'claude-code') {
  const task = await readTask(projectPath, tid);
  task.status = 'needs-input';
  task.question = { text, askedAt: nowIso() };
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'question', actor, { text });
  return task;
}

export async function answerTask(projectPath, tid, text) {
  const task = await readTask(projectPath, tid);
  if (task.question) task.question = { ...task.question, answer: text, answeredAt: nowIso() };
  // A task that was already started goes back to working (the same session usually continues);
  // one that was never started waits for Claude Code again.
  task.status = task.startedAt ? 'working' : 'ready';
  if (task.status === 'working') task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'answer', 'user', { text });
  // The answer becomes part of the brief so a fresh Claude Code session sees it.
  const briefFile = path.join(taskDir(projectPath, tid), 'brief.md');
  await withProjectRecord(projectPath, async () => {
    const existing = await fsp.readFile(briefFile, 'utf8').catch(() => '');
    await writeText(briefFile, `${existing}\n## Answer from the user (${nowIso()})\nQ: ${task.question?.text || ''}\nA: ${text}\n`);
  });
  return task;
}

/** Who a CLI call speaks for: a Codex session's commands carry ATELIER_ACTOR=codex (server/lib/codex.mjs), every
 *  other caller is Claude Code, as it always was. */
export const ACTORS = ['claude-code', 'codex'];
export const actorOf = (env = process.env) => (env.ATELIER_ACTOR === 'codex' ? 'codex' : 'claude-code');

/** Called by the CLI when Claude Code finishes: checkpoint + result record. */
export async function finishTask(ctx, tid, { summary, verification = [], unresolved = [], decisions = [], filesChanged = [], actor = 'claude-code' }) {
  const { path: projectPath, project } = ctx;
  const task = await readTask(projectPath, tid);
  if (!summary || !String(summary).trim()) throw new HttpError(400, 'invalid_input', 'A summary is required');
  const state = await changes(projectPath);
  let version = await versionAtHead(projectPath);
  const baseSha = task.context?.baseSha || null;
  const record = {
    label: shortLabel(task.title || summary, 80), // the version is named after the task; the summary goes in the note
    note: `Task ${tid}: ${summary}`,
    origin: actor === 'codex' ? 'codex' : 'claude-code', // whose work the version holds; the tag (taskId) is what ties it to the task
    state: 'experiment',
    taskId: tid,
    role: 'finish', // what is left at the finish is not one of the options: the release notes draft reads this
    baseSha, // the task's base at this moment: a reopen moves the task's on to this very version
  };
  let noVersionNote = NO_CHANGE_NOTE;
  if (state.dirty) version = await checkpoint({ path: projectPath, project }, record);
  else if (!version) {
    version = await versionFromHandCommits({ path: projectPath, project }, record, baseSha, state.headSha);
    if (!version) noVersionNote = await movedHeadNote(projectPath, baseSha, state.headSha);
  } else if (!(await isTasksVersion(projectPath, version, task, baseSha, state.headSha))) { // HEAD's version is someone else's result, or the base the options came back to
    noVersionNote = await otherVersionNote(projectPath, version, baseSha);
    version = null;
  }
  // Every version of this task; the last is the one Try it opens, even when HEAD itself is not this task's.
  const made = await versionsMadeDuringTask(projectPath, task, baseSha);
  version = made.at(-1) || version;
  const result = {
    summary: String(summary).trim(),
    resultSha: version?.sha || null,
    versionId: version?.id || null,
    versionIds: made.map((v) => v.id),
    verification: verification.filter(Boolean),
    unresolved: unresolved.filter(Boolean),
    decisions: decisions.filter(Boolean),
    filesChanged: !version ? [] : filesChanged.length ? filesChanged : version.filesChanged || [],
    ...(version ? {} : { note: noVersionNote }),
    finishedAt: nowIso(),
  };
  await writeJson(path.join(taskDir(projectPath, tid), 'result.json'), result);
  task.result = result;
  task.status = 'review';
  task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'finished', actor, version ? { versionId: version.id, versionIds: result.versionIds, sha: version.sha } : { versionId: null, versionIds: [], sha: null, text: noVersionNote });
  await dropFinishRequest(projectPath, tid); // this finish is the one that counts: a recorded request (this one's, or an earlier round's) is spent
  return { task, version, result };
}

export const NO_CHANGE_NOTE = 'No file changed, so nothing was kept and this task has no version.';

// ----- A finish the session records and the studio completes (docs/ARCHITECTURE.md section 17) -----
// A sandboxed session can write the project's files and its .studio records but not its .git: the Codex CLI's
// workspace-write refused `git add` with "Unable to create '…/.git/index.lock': Permission denied" (2026-11-14). Its
// `task finish` then records what it would have said, and the studio, which runs outside the sandbox, keeps the
// version when the worker's turn ends (server/lib/workers.mjs onTurnEnd). The task stays working until then: it has
// no version yet, and status comes from evidence.
export const FINISH_REQUEST = 'finish-request.json';
const finishRequestFile = (projectPath, tid) => path.join(taskDir(projectPath, tid), FINISH_REQUEST);
const lines = (list) => (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string' && v.trim());

export async function requestFinish(projectPath, tid, { summary, verification = [], unresolved = [], decisions = [] } = {}, actor = 'claude-code') {
  const task = await readTask(projectPath, tid);
  if (['done', 'cancelled'].includes(task.status)) throw new HttpError(409, 'task_closed', `Task is ${task.status}`);
  if (!summary || !String(summary).trim()) throw new HttpError(400, 'invalid_input', 'A summary is required');
  const request = { summary: String(summary).trim(), verification: lines(verification), unresolved: lines(unresolved), decisions: lines(decisions), actor: ACTORS.includes(actor) ? actor : 'claude-code', requestedAt: nowIso() };
  await writeJson(finishRequestFile(projectPath, tid), request);
  task.heartbeatAt = nowIso();
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'finish_requested', request.actor, { text: `${request.summary} (recorded; the studio keeps the version when the worker's turn ends)` });
  return request;
}

/** The recorded finish, or null: none, or a file that does not hold one. */
export async function readFinishRequest(projectPath, tid) {
  const r = await readJson(finishRequestFile(projectPath, tid), null).catch(() => null);
  return r && typeof r === 'object' && typeof r.summary === 'string' && r.summary.trim() ? r : null;
}

export async function dropFinishRequest(projectPath, tid) {
  await fsp.rm(finishRequestFile(projectPath, tid), { force: true });
}

/** The studio's half: the recorded finish becomes the task's finish (checkpoint and result) and the record goes.
 *  null when there is none. A failure leaves the record where it is, so the report can say why and a retry finds it. */
export async function completeFinishRequest(ctx, tid) {
  const request = await readFinishRequest(ctx.path, tid);
  if (!request) return null;
  return finishTask(ctx, tid, { summary: request.summary, verification: lines(request.verification), unresolved: lines(request.unresolved), decisions: lines(request.decisions), actor: ACTORS.includes(request.actor) ? request.actor : 'claude-code' });
}

/**
 * `task finish` as the CLI runs it: the finish itself where this process can write the repository, else the recorded
 * request. -> { deferred: false, task, version, result } or { deferred: true, request }.
 */
export async function finishOrRequest(ctx, tid, input, { canWrite = git.canWrite } = {}) {
  if (await canWrite(ctx.path)) return { deferred: false, ...(await finishTask(ctx, tid, input)) };
  return { deferred: true, request: await requestFinish(ctx.path, tid, input, input.actor) };
}

/** A clean tree whose HEAD moved holds commits made by hand: they become the version as they are,
 *  because a checkpoint here would be an empty commit. Commits that net to no change, or a HEAD
 *  that cannot be compared with the base, leave the task with no version. */
async function versionFromHandCommits(ctx, record, baseSha, headSha) {
  if (!baseSha || !headSha || headSha === baseSha) return null;
  const commits = await git.log(ctx.path, { from: baseSha, to: headSha, max: 1 });
  const filesChanged = await git.changedFilesBetween(ctx.path, baseSha, headSha);
  return commits.length && filesChanged.length ? adoptHead(ctx, { ...record, filesChanged }) : null;
}

/** What is true of a clean tree that got no version from its hand commits: HEAD may have moved
 *  anyway, by commits that net to no change or by a reset to an older commit. A HEAD that cannot be
 *  compared with the base stays the plain note. */
async function movedHeadNote(dir, baseSha, headSha) {
  if (!baseSha || !headSha || headSha === baseSha) return NO_CHANGE_NOTE;
  const apart = await git.commitsApart(dir, baseSha, headSha);
  if (apart === null) return NO_CHANGE_NOTE;
  const moved = `HEAD moved from ${baseSha.slice(0, 8)} to ${headSha.slice(0, 8)} (${apart} ${apart === 1 ? 'commit' : 'commits'} apart)`;
  const differs = (await git.changedFilesBetween(dir, baseSha, headSha)).length > 0;
  return differs
    ? `The files on disk differ from the task's base: ${moved}; nothing was kept as a version.`
    : `The files on disk match the task's base, though ${moved}; nothing was kept as a version.`;
}

/** What is true of a clean tree on a version that is not this task's. Still at the base, nothing
 *  changed. A HEAD that went back behind the base is on an earlier version whoever made it; a HEAD
 *  that went elsewhere is on another task's, on one the person kept while the task ran, or, with
 *  neither named, on one from before this task. */
async function otherVersionNote(dir, version, baseSha) {
  if (version.sha === baseSha) return NO_CHANGE_NOTE;
  const wentBack = baseSha && await git.isAncestor(dir, version.sha, baseSha);
  const elsewhere = version.taskId ? "another task's" : version.origin === 'user' ? 'kept by you' : 'an earlier version';
  return `The files on disk are those of version #${version.n} (${wentBack ? 'an earlier version' : elsewhere}); nothing was kept for this task.`;
}

/** A tag decides alone: another task's is not this one's, and this task's counts whatever HEAD is,
 *  because options restored away from are not ancestors of it. An untagged version is the CLI without
 *  --task only when it came from a session (Keep version, a safety copy and an import never do), is
 *  still in HEAD's history, is newer than the start and holds files other than the base's. */
async function isTasksVersion(dir, version, task, baseSha, head) {
  if (version.taskId) return version.taskId === task.id;
  if (version.origin !== 'claude-code' || !head) return false;
  if (Date.parse(version.createdAt) < Date.parse(task.startedAt || task.createdAt)) return false;
  if (!(await git.isAncestor(dir, version.sha, head))) return false;
  if (!baseSha) return true;
  if (await git.isAncestor(dir, version.sha, baseSha)) return false;
  return (await git.changedFilesBetween(dir, baseSha, version.sha)).length > 0;
}

/** The task's versions in n order. A version the finish itself just made or adopted comes last. */
async function versionsMadeDuringTask(dir, task, baseSha) {
  const head = await git.headSha(dir);
  const made = [];
  for (const v of await listVersions(dir)) {
    if (await isTasksVersion(dir, v, task, baseSha, head)) made.push(v);
  }
  return made;
}

/** Studio-side ingest: cross-check the result against git, record decisions, close the loop. */
export async function ingestTask(ctx, tid) {
  const { path: projectPath } = ctx;
  const task = await readTask(projectPath, tid);
  if (task.status === 'done') { // already recorded: nothing is added and nothing is rewritten
    const known = task.result?.versionId ? (await listVersions(projectPath)).find((v) => v.id === task.result.versionId) : null;
    const named = task.result ? { ...task, result: withVersionFacts(task.result, await listVersions(projectPath)) } : task;
    return { task: named, version: known || null, evidence: task.ingest?.evidence ?? null, decisions: [], unresolved: [] };
  }
  const result = await readJson(path.join(taskDir(projectPath, tid), 'result.json'), null);
  if (!result) throw new HttpError(409, 'no_result', 'Claude Code has not reported a result for this task yet');
  const versions = await listVersions(projectPath);
  const version = versions.find((v) => v.id === result.versionId) || versions.find((v) => v.sha === result.resultSha) || null;
  // A result with no version names no commit: HEAD may have moved through other work, none of it this task's.
  const noVersion = !result.versionId && !result.resultSha;
  const own = (result.versionIds || []).map((id) => versions.find((v) => v.id === id)).filter((v) => v?.sha);
  const evidence = {
    versionFound: Boolean(version),
    ...(own.length && task.context.baseSha
      ? await workOfVersions(projectPath, task.context.baseSha, own, task.mode)
      : {
        commitsSinceBase: !noVersion && task.context.baseSha ? await git.log(projectPath, { from: task.context.baseSha, to: result.resultSha || 'HEAD', max: 50 }) : [],
        filesChanged: task.context.baseSha && result.resultSha ? await git.changedFilesBetween(projectPath, task.context.baseSha, result.resultSha) : [],
      }),
  };
  const recorded = [];
  // Same text within one task is one decision: a repeat in the result, or a reopened task ingested again.
  const seenDecisions = new Set((await readJson(studioPath(projectPath, 'decisions.json'), [])).filter((d) => d.taskId === tid).map((d) => d.text));
  for (const d of result.decisions || []) {
    const [text, reason = ''] = String(d).split('|').map((s) => s.trim());
    if (!text || seenDecisions.has(text)) continue;
    seenDecisions.add(text);
    recorded.push(await stores(projectPath).decisions.add({ text, reason, status: 'accepted', versionId: version?.id || null, taskId: tid, supersedes: null }));
  }
  const carried = await carryUnresolved(projectPath, task, result.unresolved);
  // Every option becomes this task's, so a later task cannot count an untagged one as its own. Only a
  // session's: a result written before the origin rule can still name a version the person kept. An explore
  // task's also gets its role, so the release notes draft can ask git about every pair the task made.
  const untagged = versions.filter((v) => !v.taskId && v.origin === 'claude-code' && (v.id === version?.id || result.versionIds?.includes(v.id)));
  if (untagged.length) {
    for (const v of untagged) {
      v.taskId = tid;
      if (task.mode === 'explore' && !v.role) v.role = 'option';
    }
    await writeJson(studioPath(projectPath, 'versions.json'), versions);
  }
  task.status = 'done';
  task.ingest = { at: nowIso(), evidence, decisionIds: recorded.map((d) => d.id), unresolvedIds: carried.map((u) => u.id) };
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'ingested', 'studio', { versionId: version?.id || null, versionIds: result.versionIds || [], commits: evidence.commitsSinceBase.length, files: evidence.filesChanged.length });
  const named = task.result ? { ...task, result: withVersionFacts(task.result, versions) } : task;
  return { task: named, version, evidence, decisions: recorded, unresolved: carried };
}

/** A task's own work: branched options are not in one line, so base..HEAD would miss them. Each version counts
 *  from its own base, because a reopen moves the task's past its earlier rounds. A record with none (from before
 *  the field), and an explore task's finish beside other versions, which is a leftover rather than the work, count
 *  from where they left the task's base, so one that is now the base adds nothing. Each commit and each file counts
 *  once, however many of the versions share it. */
async function workOfVersions(dir, taskBase, own, mode) {
  const commits = new Map();
  const files = new Set();
  for (const { sha, baseSha, role } of own) {
    const leftover = mode === 'explore' && role === 'finish' && own.length > 1;
    const from = (!leftover && baseSha) || (await git.mergeBase(dir, taskBase, sha)) || taskBase;
    for (const c of await git.log(dir, { from, to: sha, max: 1000 })) commits.set(c.sha, c);
    for (const f of await git.changedFilesBetween(dir, from, sha)) files.add(f);
  }
  return { commitsSinceBase: [...commits.values()], filesChanged: [...files] };
}

/** Append a result's unresolved texts to the project's list, skipping text already there. Each item says
 *  which task left it, in the task's words of that moment, so it reads the same if the task folder goes.
 *  Reads project.json afresh: the caller's copy may predate an edit made in the Focus panel. */
function carryUnresolved(projectPath, task, texts) {
  return withProjectRecord(projectPath, async () => {
    const project = await readJson(studioPath(projectPath, 'project.json'), null);
    if (!project) return [];
    const list = Array.isArray(project.unresolved) ? project.unresolved : [];
    const seen = new Set(list.map((u) => String(u?.text ?? u).trim()));
    const added = [];
    for (const raw of texts || []) {
      const text = String(raw).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const at = nowIso();
      added.push({ id: newId('u'), text, createdAt: at, taskId: task.id, taskTitle: task.title, at });
    }
    if (added.length) await saveProject(projectPath, { ...project, unresolved: [...list, ...added] });
    return added;
  });
}

export async function cancelTask(projectPath, tid) {
  const task = await readTask(projectPath, tid);
  task.status = 'cancelled';
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'cancelled', 'user', {});
  return task;
}

export async function reopenTask(ctx, tid) {
  const { path: projectPath } = ctx;
  const task = await readTask(projectPath, tid);
  await moveBase(ctx, task); // the handover keeps a base that has no version: a reopen writes nothing to git
  task.status = 'ready';
  await saveTask(projectPath, task);
  await appendEvent(projectPath, tid, 'ready', 'user', { reopened: true });
  return task;
}

export function openPrompt(tid) {
  return `Studio task ${tid}: read .studio/tasks/${tid}/brief.md and carry it out. Begin by running the "task handover" command it lists, then the "task start" command; finish with the "task finish" command.`;
}

/** A stuck session asks and stops: the manager or the person only hears of a block through task question. */
export const STUCK_WORDS = 'The same when you are stuck: a command you need is denied, a check fails and you cannot fix it, or you lack access to a file, a folder, a tool or a service. Then run task question saying what blocks you, what you tried and what you need, and stop; do not guess, work around the block or run on.';

/** First message of a studio Chat session that runs a task (POST …/tasks/:tid/console). */
export function consolePrompt(tid, mode, baseVersionId = null, keptSha = null) {
  const cli = `node "${CLI}"`;
  const explore = mode === 'explore' ? `This is an explore task. ${exploreSteps(tid, baseVersionId, keptSha)} Put the tradeoffs in task notes, and do not pick one; the choice is the person's. ` : `${VERSION_WORDS} `;
  return `Work on studio task ${tid} in this folder. Read .studio/tasks/${tid}/brief.md and follow it. Report progress through the studio CLI: start with \`${cli} task handover ${tid}\`, then \`${cli} task start ${tid}\`, leave short notes with \`${cli} task note ${tid} "…"\`, and when done run \`${cli} task finish ${tid} --summary "…" --verification "…"\` (it checkpoints the project). ${explore}If you need a decision from the person, run \`${cli} task question ${tid} "…"\` and stop; do not guess and do not finish with the question unanswered. ${STUCK_WORDS} Keep every change inside this project folder; do not commit by hand. Stay inside this project folder and the folders named for this task; do not read files elsewhere. Run one simple command per call in this folder: no cd, no ; or && chains, no shell variables; when a step needs more than one command, write a small script file under the project folder, run it with node <file>, and delete it before you finish, because the finish checkpoint commits every file. Run git without -C: the allowed rules match git status, git diff, git log and git show as typed, so git -C <path> is refused.`;
}

/** Launch the user's own Claude Code in a terminal at the project folder.
 * The prompt goes to the clipboard and the interactive session starts without
 * it, so the person stays in control of what is sent (paste + Enter). */
export async function openInClaudeCode(projectPath, tid, { launcher = spawn } = {}) {
  await readTask(projectPath, tid);
  const prompt = openPrompt(tid);
  const isWin = process.platform === 'win32';
  let command;
  let launched = false;
  let detail = '';
  try {
    if (isWin) {
      const banner = `echo Atelier task ${tid} - the prompt is on your clipboard: paste it into Claude Code and press Enter. & echo Brief: .studio\tasks\${tid}\brief.md & claude`;
      command = `wt.exe -d "${projectPath}" cmd /k "${banner}"`;
      const clip = launcher('cmd.exe', ['/c', 'clip'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      clip.stdin.end(prompt);
      const child = launcher('cmd.exe', ['/c', 'start', '""', 'wt.exe', '-d', projectPath, 'cmd', '/k', banner], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      launched = true;
      detail = 'A Windows Terminal window opened in the project folder with Claude Code; the task prompt is on the clipboard.';
    } else {
      command = `cd "${projectPath}" && claude`;
      detail = 'Run this in your terminal, then paste the prompt.';
    }
  } catch (err) {
    launched = false;
    detail = err.message;
  }
  await appendEvent(projectPath, tid, 'opened', 'studio', { launched, command });
  return { launched, command, prompt, detail };
}
