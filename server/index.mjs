// Atelier local companion: static UI, JSON API, SSE, previews.
// One process, no framework. Start with `npm start` (http://127.0.0.1:4747).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { STUDIO_DIR, DATA_DIR, PROJECTS_DIR, PORT, HttpError, nowIso, folderKey } from './lib/paths.mjs';
import { readJson, ensureDir, exists } from './lib/fsutil.mjs';
import { loadRegistry, updateRegistry } from './lib/registry.mjs';
import * as projects from './lib/projects.mjs';
import * as versions from './lib/versions.mjs';
import * as memory from './lib/memory.mjs';
import * as tasks from './lib/tasks.mjs';
import { createWatchListener } from './lib/watch-events.mjs';
import { createWorkers } from './lib/workers.mjs';
import { loadStudioWorkerModel, saveStudioWorkerModel, workerModelLevels } from './lib/worker-model.mjs';
import { tallyUsage } from './lib/usage.mjs';
import * as briefing from './lib/briefing.mjs';
import { servePreview, mimeFor } from './lib/preview.mjs';
import { buildProject, releaseNotesDraftData } from './lib/build.mjs';
import { templateDrift, templateDriftDiff } from './lib/template-drift.mjs';
import { saveRender, listRenders, readRender, MAX_RENDER_BODY } from './lib/audio-render.mjs';
import { modelEvidence } from './lib/evidence.mjs';
import { getApiKey, keySource, setApiKey, redact, getClaudeToken, claudeTokenInfo, claudeTokenProblem, setClaudeToken } from './lib/secrets.mjs';
import { subscribe, emit, clientCount } from './lib/events.mjs';
import { checkShow } from './lib/mcp/show.mjs';
import { createUtility, readApiKey } from './api-utility/index.mjs';
import { createConsole, CONSOLE_DEFAULTS, CONSOLE_MODELS } from './lib/console.mjs';
import { createTerminals } from './lib/terminal.mjs';
import { runs } from './lib/runs.mjs';
import { createLive, serveLiveFrame } from './lib/live.mjs';
import { readFileSync, rmSync, watch } from 'node:fs';
import { pidFileContent } from './lib/proc.mjs';
import { machineInfo } from './lib/machine.mjs';
import { devicesFor, providersFor } from './lib/devices/index.mjs';
import { listPins, addPin, removePin, contextPack, phoneLineOf, saveAttachment } from './lib/companion.mjs';
import { siblingPages, pageInspect } from './lib/page.mjs';
import * as skills from './lib/skills.mjs';
import * as departments from './lib/departments.mjs';
import * as lessons from './lib/lessons.mjs';
import * as inspiration from './lib/inspiration.mjs';
import * as rules from './lib/rules.mjs';
import * as references from './lib/references.mjs';
import { visualizerAnswer } from './lib/visualizer.mjs';
import { appearanceFacts, saveAppearance } from './lib/appearance.mjs';
import { resolveTools, publicTools, TOOL_KEYS } from './lib/devices/android-config.mjs';
import { intentLine } from '../client/components/companion-words.js'; // a task summary's intent line (no request rides the bundle)

// Optional .env beside the studio (gitignored): ATELIER_PORT, ATELIER_DATA_DIR, STUDIO_ANTHROPIC_API_KEY ...
try {
  if (await exists(path.join(STUDIO_DIR, '.env'))) process.loadEnvFile(path.join(STUDIO_DIR, '.env'));
} catch (err) {
  console.error('[atelier] .env not loaded:', err.message);
}
const pkg = await readJson(path.join(STUDIO_DIR, 'package.json'));
const CLIENT_DIR = path.join(STUDIO_DIR, 'client');
const WORKBENCH_DIR = path.join(STUDIO_DIR, 'workbenches');
let studioGitSha = null;
try {
  const { git } = await import('./lib/git.mjs');
  studioGitSha = (await git(STUDIO_DIR, ['rev-parse', '--short', 'HEAD'], { allowFail: true }))?.trim() || null;
} catch {
  studioGitSha = null;
}

// ---------- runs (server/lib/runs.mjs; docs/ARCHITECTURE.md section 16): every hook below reports to this one registry ----------
runs.setEmit(emit);

// ---------- utility (bounded API) ----------
let utilityModel = (await loadRegistry()).settings?.apiUtility?.model || 'claude-haiku-5-5';
const utility = createUtility({
  dataDir: DATA_DIR,
  getApiKey: () => readApiKey(DATA_DIR),
  getModel: () => utilityModel,
  emit,
  runs,
});

// ---------- the companion's context pack (server/lib/companion.mjs; docs/ARCHITECTURE.md section 12) ----------
/** The phone in one line, bounded: adb can be slow or missing, and the first message must not wait on it long. */
async function phoneLine(ctx, id) {
  const read = (async () => {
    const list = await providersFor(ctx.path, ctx.manifest, (await loadRegistry()).settings || {}, { projectId: id });
    return phoneLineOf(await Promise.all(list.map((p) => p.status())));
  })();
  const late = new Promise((resolve) => { const t = setTimeout(() => resolve('Phone: not read (no answer within 4 s)'), 4000); t.unref?.(); });
  return Promise.race([read, late]);
}
const companionContext = async (rec) => {
  const ctx = await projects.loadProject(rec.projectId);
  return contextPack(ctx, { phoneLine: () => phoneLine(ctx, rec.projectId) });
};

// ---------- console (claude-code CLI / api utility / local command) ----------
const consoleSvc = createConsole({
  companionContext,
  dataDir: DATA_DIR,
  studioDir: STUDIO_DIR,
  studioOrigin: `http://127.0.0.1:${PORT}`, // what a Studio tools session's MCP server talks to
  projectsDir: PROJECTS_DIR,
  projectFolders: async () => (await loadRegistry()).projects.map((p) => p.path),
  studioProjectId: async () => (await loadRegistry()).projects.find((p) => p.kind === 'studio')?.id || null, // named to companion sessions for their checkpoint command
  claudeToken: getClaudeToken, // the studio's own Claude Code sign-in, for its claude runs only (decision row 129)
  claudeTokenInfo,
  loadProject: (id) => projects.loadProject(id),
  getSettings: async () => (await loadRegistry()).settings,
  utility,
  emit,
  runs,
  onTurnEnd: (rec, turn) => workers.onTurnEnd(rec, turn), // the manager's workers (server/lib/workers.mjs)
});

// ---------- terminal (node-pty shells; docs/ARCHITECTURE.md section 8) ----------
const terminals = createTerminals({ studioDir: STUDIO_DIR, loadProject: (id) => projects.loadProject(id), emit, runs });

// ---------- live (a project's own server in the preview; server/lib/live.mjs, docs/ARCHITECTURE.md section 20) ----------
const live = createLive({ loadProject: (id) => projects.loadProject(id), emit, runs, consentFile: path.join(DATA_DIR, 'live-consent.json'), port: PORT, studioDir: STUDIO_DIR });

// ---------- helpers ----------
const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
};
const fail = (res, err) => {
  const status = err.status || 500;
  const body = { error: { code: err.code || 'internal', message: redact(err.message || String(err)) } };
  if (err.existing) body.existing = err.existing;
  if (err.details) Object.assign(body, err.details, { message: body.error.message }); // beside error, whose shape the client reads
  if (status >= 500) console.error('[atelier]', err);
  json(res, status, body);
};
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  // Over the limit the rest is read and dropped: leaving the loop early would destroy the socket,
  // and the client would see a connection reset instead of the 413 below.
  for await (const c of req) {
    size += c.length;
    if (size <= limit) chunks.push(c);
  }
  if (size > limit) throw new HttpError(413, 'too_large', `Request body too large (over ${Math.round(limit / (1024 * 1024))} MB)`);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be JSON');
  }
}

// The manager's workers: the Companion session hands tasks to worker sessions and hears back (server/lib/workers.mjs).
// The queue, held reports and notes survive a restart in <data>/workers.json; reconcile() runs once the server listens.
const workers = createWorkers({
  consoleSvc, tasks, emit, runs,
  loadProject: (id) => projects.loadProject(id),
  listProjects: async () => (await loadRegistry()).projects.map((p) => p.id),
  dirty: async (dir) => (await versions.changes(dir)).dirty, // after a restart, a queue waits over a cut-off worker's files
  stateFile: path.join(DATA_DIR, 'workers.json'),
  afterChange: (id, what) => afterProjectChange(id, what),
  studioModel: async () => (await loadStudioWorkerModel()).model, // the stored studio default, read at every launch
});

async function afterProjectChange(projectId, what = {}) {
  try {
    await briefing.regenerate(projectId);
  } catch (err) {
    console.error('[atelier] briefing regenerate failed', err.message);
  }
  emit('project.changed', { projectId, ...what });
}

async function projectBundle(id) {
  const ctx = await projects.loadProject(id);
  const s = projects.stores(ctx.path);
  const [vers, decisions, feedback, releases, resources, taskList, changes] = await Promise.all([
    versions.listVersions(ctx.path),
    s.decisions.all(),
    s.feedback.all(),
    s.releases.all(),
    s.resources.all(),
    tasks.listTasks(ctx.path),
    versions.changes(ctx.path),
  ]);
  return {
    entry: ctx.entry,
    project: ctx.project,
    // devices is inferred, like the entry of a folder without atelier.json: a key per provider that applies.
    manifest: { ...ctx.manifest, devices: await devicesFor(ctx.path, ctx.manifest) },
    versions: vers,
    decisions,
    feedback,
    releases,
    resources,
    tasks: await Promise.all(taskList.map(async (t) => ({ id: t.id, title: t.title, intent: intentLine(t), status: t.status, mode: t.mode, department: t.department || null, route: t.route, createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, finishedAt: t.finishedAt, question: t.question, result: t.result ? { summary: t.result.summary, versionId: t.result.versionId, versionIds: t.result.versionIds, versionNumbers: t.result.versionNumbers, versionRoles: t.result.versionRoles, finishedAt: t.result.finishedAt || null } : null, lastEvent: await tasks.lastEvent(ctx.path, t.id) }))),
    changes,
  };
}

const versionDeps = {
  checkpoint: (ctx, opts) => versions.checkpoint(ctx, opts),
  adoptHead: (ctx, opts) => versions.adoptHead(ctx, opts),
  versionAtHead: (projectPath) => versions.versionAtHead(projectPath),
  regenerate: (id) => briefing.regenerate(id),
};

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, { bodyLimit } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, bodyLimit });
};

route('GET', '/api/state', async () => {
  const reg = await loadRegistry();
  const utilityStatus = await utility.status();
  return {
    studio: { name: 'Atelier', version: pkg.version, gitSha: studioGitSha, dir: STUDIO_DIR, dataDir: DATA_DIR, projectsDir: PROJECTS_DIR, port: PORT, node: process.version, platform: process.platform, startedAt: STARTED_AT },
    projects: reg.projects,
    activeProjectId: reg.activeProjectId,
    settings: withConsoleDefaults(reg.settings),
    appearance: await appearanceFacts(reg), // the look in effect once the studio project's locked tokens are taken out (section 24)
    apiUtility: { configured: utilityStatus.configured, keySource: await keySource(), model: utilityStatus.model, paused: utilityStatus.paused, pausedReason: utilityStatus.pausedReason, spentUsd: utilityStatus.spentUsd, liveCeilingUsd: utilityStatus.liveCeilingUsd, remainingUsd: utilityStatus.remainingUsd },
    templates: await projects.listTemplates(),
  };
});

route('GET', '/api/projects', async () => (await loadRegistry()).projects);
route('POST', '/api/projects', async ({ body }) => {
  const created = await projects.createProject(body, versionDeps);
  await watchProjects();
  emit('project.changed', { projectId: created.project.id, created: true });
  return created;
});
route('POST', '/api/projects/import', async ({ body }) => {
  const imported = await projects.importProject(body, versionDeps);
  await watchProjects();
  emit('project.changed', { projectId: imported.project.id, imported: true });
  return imported;
});
route('GET', '/api/projects/:id', async ({ params }) => projectBundle(params.id));
route('PATCH', '/api/projects/:id', async ({ params, body }) => {
  const project = await projects.patchProject(params.id, body);
  await afterProjectChange(params.id, { records: true });
  return project;
});
route('POST', '/api/projects/:id/activate', async ({ params }) => {
  await projects.setActive(params.id);
  live.stopOthers(params.id); // the preview left the other projects: their live servers close with them
  emit('status', { activeProjectId: params.id });
  return { activeProjectId: params.id };
});
route('DELETE', '/api/projects/:id', async ({ params }) => {
  live.stopNow(params.id, 'the project was removed from the studio');
  await projects.unregisterProject(params.id);
  await watchProjects(); // closes its watcher, after any scan already under way that could have attached one
  emit('project.changed', { projectId: params.id, removed: true });
  return { removed: params.id, note: 'Folder left on disk' };
});
route('GET', '/api/projects/:id/changes', async ({ params }) => versions.changes((await projects.loadProject(params.id)).path));
route('GET', '/api/projects/:id/versions', async ({ params }) => versions.listVersions((await projects.loadProject(params.id)).path));
route('POST', '/api/projects/:id/versions', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  // Keep version, by the person: only the CLI's --task can tag a version, and it checks the task's status and mode.
  const { label, note, state } = body;
  const v = await versions.checkpoint(ctx, { label, note, state, origin: 'user' });
  await afterProjectChange(params.id, { versionId: v.id });
  return v;
});
route('PATCH', '/api/projects/:id/versions/:vid', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const v = await versions.patchVersion(ctx.path, params.vid, body);
  await afterProjectChange(params.id, { versionId: v.id });
  return v;
});
route('POST', '/api/projects/:id/restore', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const out = await versions.restore(ctx, body.versionId);
  await afterProjectChange(params.id, { restored: body.versionId });
  return out;
});
route('GET', '/api/projects/:id/compare', async ({ params, query }) => versions.compare(await projects.loadProject(params.id), query.get('a'), query.get('b') || 'head'));
// ?max=<bytes>: the Source tab's cut (a longer file answers its first bytes with truncated: true instead of 413).
route('GET', '/api/projects/:id/files', async ({ params, query }) => projects.readProjectPath((await projects.loadProject(params.id)).path, query.get('path') || '', { max: query.get('max') ? Number(query.get('max')) : null }));
route('PUT', '/api/projects/:id/files', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const out = await projects.writeProjectPath(ctx.path, body.path, body.content);
  emit('project.changed', { projectId: params.id, file: body.path });
  return out;
});
route('GET', '/api/projects/:id/release-notes-draft', async ({ params, query }) => releaseNotesDraftData(await projects.loadProject(params.id), query.get('version')));
route('GET', '/api/projects/:id/template-drift', async ({ params }) => templateDrift(await projects.loadProject(params.id)));
route('GET', '/api/projects/:id/template-drift/diff', async ({ params, query }) => templateDriftDiff(await projects.loadProject(params.id), query.get('path') || ''));
route('POST', '/api/projects/:id/build', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const out = await buildProject(ctx, body || {});
  await afterProjectChange(params.id, { releaseId: out.release.id });
  return out;
});
route('POST', '/api/projects/:id/audio/render', async ({ params, body }) => {
  const { path: projectPath, manifest } = await projects.loadProject(params.id);
  return saveRender(projectPath, body, manifest);
}, { bodyLimit: MAX_RENDER_BODY });
route('GET', '/api/projects/:id/audio/renders', async ({ params }) => {
  const { path: projectPath, manifest } = await projects.loadProject(params.id);
  return listRenders(projectPath, manifest);
});
route('GET', '/api/projects/:id/audio/renders/:cue', async ({ params, res }) => {
  const buf = await readRender((await projects.loadProject(params.id)).path, params.cue);
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
});
route('GET', '/api/projects/:id/releases', async ({ params }) => projects.stores((await projects.loadProject(params.id)).path).releases.all());
route('PATCH', '/api/projects/:id/releases/:rid', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const out = await projects.stores(ctx.path).releases.patch(params.rid, body);
  await afterProjectChange(params.id, { releaseId: params.rid });
  return out;
});

for (const name of ['decisions', 'feedback', 'resources']) {
  route('GET', `/api/projects/:id/${name}`, async ({ params }) => projects.stores((await projects.loadProject(params.id)).path)[name].all());
  route('POST', `/api/projects/:id/${name}`, async ({ params, body }) => {
    const ctx = await projects.loadProject(params.id);
    const defaults = name === 'decisions' ? { status: 'accepted' } : name === 'feedback' ? { status: 'new', source: 'user' } : { status: 'discovered' };
    const out = await projects.stores(ctx.path)[name].add({ ...defaults, ...body });
    await afterProjectChange(params.id, { [name]: out.id });
    return out;
  });
  route('PATCH', `/api/projects/:id/${name}/:rid`, async ({ params, body }) => {
    const ctx = await projects.loadProject(params.id);
    const out = await projects.stores(ctx.path)[name].patch(params.rid, body);
    await afterProjectChange(params.id, { [name]: out.id });
    return out;
  });
}

route('GET', '/api/projects/:id/tasks', async ({ params }) => tasks.listTasks((await projects.loadProject(params.id)).path));
// Every project's tasks in one list (the Tasks view's "All projects" scope), newest first.
route('GET', '/api/tasks', async () => {
  const reg = await loadRegistry();
  const out = [];
  for (const p of reg.projects || []) {
    const list = await tasks.listTasks(p.path).catch(() => []);
    for (const t of list) out.push({ ...t, projectId: p.id, projectName: p.name, projectSlug: p.slug });
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { tasks: out };
});
route('POST', '/api/projects/:id/tasks', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const task = await tasks.createTask(ctx, body);
  await afterProjectChange(params.id, { taskId: task.id });
  emit('task.changed', { projectId: params.id, taskId: task.id, status: task.status });
  return task;
});
route('GET', '/api/projects/:id/tasks/:tid', async ({ params }) => tasks.getTask((await projects.loadProject(params.id)).path, params.tid));
route('GET', '/api/projects/:id/tasks/:tid/command', async ({ params }) => {
  const ctx = await projects.loadProject(params.id);
  await tasks.getTask(ctx.path, params.tid);
  const prompt = tasks.openPrompt(params.tid);
  return { prompt, command: `cd "${ctx.path}" && claude`, note: 'Start Claude Code in the project folder, then paste the prompt.' };
});
route('GET', '/api/projects/:id/history', async ({ params }) => {
  const ctx = await projects.loadProject(params.id);
  const { readJsonl } = await import('./lib/fsutil.mjs');
  return readJsonl(path.join(ctx.path, '.studio', 'history.jsonl'));
});
// Run a task in a studio Chat session (claude-code, acceptEdits, studio CLI allowed).
route('POST', '/api/projects/:id/tasks/:tid/console', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const { task } = await tasks.getTask(ctx.path, params.tid);
  if (!['ready', 'working', 'interrupted', 'needs-input'].includes(task.status)) throw new HttpError(409, 'task_closed', `Task is ${task.status}`);
  const model = CONSOLE_MODELS.includes(body?.model) ? body.model : 'claude-opus-5-5';
  const handed = await tasks.handOverTask(ctx, task.id);
  if (handed.moved) await afterProjectChange(params.id, { taskId: task.id });
  const session = await consoleSvc.createSession({
    backend: 'claude-code', projectId: params.id, model, permissionMode: 'acceptEdits', allowStudioCli: true, addDirs: body?.addDirs ?? [],
    title: `Task · ${tasks.shortLabel(task.title, 70)}`, taskId: task.id, department: task.department?.name || null,
  });
  await tasks.appendEvent(ctx.path, task.id, 'handed_to_console', 'studio', { sessionId: session.id });
  emit('task.changed', { projectId: params.id, taskId: task.id, sessionId: session.id });
  const prompt = tasks.consolePrompt(task.id, task.mode, handed.task.context?.baseVersionId, handed.reason === 'kept' ? handed.task.context?.baseSha : null);
  const department = await tasks.departmentParagraph(ctx.path, task); // '' without a department
  const { runId } = await consoleSvc.send(session.id, { text: department ? `${prompt}\n\n${department}` : prompt });
  return { sessionId: session.id, runId };
});
route('POST', '/api/projects/:id/tasks/:tid/open', async ({ params }) => {
  const ctx = await projects.loadProject(params.id);
  if ((await tasks.handOverTask(ctx, params.tid)).moved) await afterProjectChange(params.id, { taskId: params.tid });
  const out = await tasks.openInClaudeCode(ctx.path, params.tid);
  emit('task.changed', { projectId: params.id, taskId: params.tid, opened: true });
  return out;
});
route('POST', '/api/projects/:id/tasks/:tid/ingest', async ({ params }) => {
  const ctx = await projects.loadProject(params.id);
  const out = await tasks.ingestTask(ctx, params.tid);
  await afterProjectChange(params.id, { taskId: params.tid });
  emit('task.changed', { projectId: params.id, taskId: params.tid, status: 'done' });
  return out;
});
route('PATCH', '/api/projects/:id/tasks/:tid', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  let task;
  if (body.action === 'cancel') task = await tasks.cancelTask(ctx.path, params.tid);
  else if (body.action === 'ready') task = await tasks.reopenTask(ctx, params.tid);
  else if (body.action === 'answer') task = await tasks.answerTask(ctx.path, params.tid, body.text || '');
  else if (body.action === 'note') task = await tasks.noteTask(ctx.path, params.tid, body.text || '', 'user');
  else throw new HttpError(400, 'invalid_action', 'action must be cancel, ready, answer or note');
  await afterProjectChange(params.id, { taskId: params.tid });
  emit('task.changed', { projectId: params.id, taskId: params.tid, status: task.status });
  return task;
});

// Restart the studio (components/restart.js, the tray): scripts/restart.mjs runs detached, so it outlives this server,
// stops it after proving it is this studio's, and starts a fresh one. The answer goes out before the stop.
route('POST', '/api/studio/restart', async () => {
  // restart.mjs ends this process without its exit handlers on Windows: the live servers go first.
  live.stopAll('the studio restarted');
  await fsp.mkdir(path.join(STUDIO_DIR, '.local'), { recursive: true });
  const log = fs.openSync(path.join(STUDIO_DIR, '.local', 'restart.log'), 'a');
  // The request itself is logged first: a request whose script never wrote a line is then told apart from no request.
  fs.writeSync(log, `[restart] ${nowIso()} requested through POST /api/studio/restart; server pid ${process.pid}, started ${STARTED_AT}
`);
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(STUDIO_DIR, 'scripts', 'restart.mjs')], { cwd: STUDIO_DIR, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
  }, 300);
  return { restarting: true, pid: process.pid };
});

// The manager's workers: start a task in a worker (or queue it), review a finished one, and what runs and waits.
// managerSessionId: the console session that asked (its MCP server's ATELIER_SESSION_ID); the worker reports to it.
const managerOf = (body) => {
  const id = body?.managerSessionId;
  if (id === undefined || id === null || id === '') return null;
  if (typeof id !== 'string' || !/^cs_[a-z0-9]+$/.test(id)) throw new HttpError(400, 'invalid_input', 'managerSessionId must be a console session id (cs_…)');
  return id;
};
// workerModel (optional): the task's own model, set before it starts and kept for its later rounds (section 17).
route('POST', '/api/projects/:id/workers', async ({ params, body }) => {
  if (!/^t_[a-z0-9]+$/.test(String(body?.taskId || ''))) throw new HttpError(400, 'invalid_input', 'taskId is required');
  return workers.start(params.id, body.taskId, { managerSessionId: managerOf(body), ...('workerModel' in body ? { workerModel: body.workerModel } : {}) });
});
route('GET', '/api/projects/:id/workers', async ({ params }) => workers.status(params.id));
route('GET', '/api/workers', async () => workers.overview()); // the restart confirmation counts the workers mid-task
// Worker and companion runs per model over the last 24 h and 7 days, from the console's session records (server/lib/usage.mjs).
route('GET', '/api/workers/usage', async ({ query }) => {
  const projectId = query.get('projectId') || null;
  if (projectId) await projects.loadProject(projectId); // an unregistered id is a 404, not an empty tally
  return tallyUsage(await consoleSvc.sessionRecords(), { projectId });
});

// ----- worker models (section 17): a task's own, else its project's, else the studio default kept in the registry -----
const needsWorkerModel = (body) => {
  if (!body || typeof body !== 'object' || !('workerModel' in body)) throw new HttpError(400, 'invalid_input', `workerModel is required: one of ${CONSOLE_MODELS.join(', ')}, or default`);
  return body.workerModel;
};
/** Store or clear the studio default. Every briefing names the worker model, so each is written again after a change. */
async function setStudioWorkerModel(value) {
  const before = await loadStudioWorkerModel();
  const studio = await saveStudioWorkerModel(value); // a 400 naming the choices for an unknown model; nothing written
  if (studio.stored !== before.stored) {
    for (const p of (await loadRegistry()).projects) {
      try { await briefing.regenerate(p.id); } catch (err) { console.error('[atelier] briefing regenerate failed', p.id, err.message); }
    }
    emit('status', { settings: true, workerModel: studio.model });
  }
  return studio;
}
async function workerModelFacts(projectId, taskId = null) {
  if (taskId != null && !/^t_[a-z0-9]+$/.test(String(taskId))) throw new HttpError(400, 'invalid_input', 'task must be a task id');
  const ctx = await projects.loadProject(projectId);
  const task = taskId ? (await tasks.getTask(ctx.path, taskId)).task : null;
  return workerModelLevels({ studio: await loadStudioWorkerModel(), project: { id: ctx.project.id, name: ctx.project.name, record: ctx.project }, task });
}
route('GET', '/api/settings/worker-model', async () => ({ models: [...CONSOLE_MODELS], studio: await loadStudioWorkerModel() }));
route('PUT', '/api/settings/worker-model', async ({ body }) => ({ models: [...CONSOLE_MODELS], studio: await setStudioWorkerModel(needsWorkerModel(body)) }));
route('GET', '/api/projects/:id/worker-model', async ({ params, query }) => workerModelFacts(params.id, query.get('task')));
route('PUT', '/api/projects/:id/tasks/:tid/worker-model', async ({ params, body }) => {
  const ctx = await projects.loadProject(params.id);
  const { changed } = await tasks.setTaskWorkerModel(ctx.path, params.tid, needsWorkerModel(body), body.actor === 'companion' ? 'companion' : 'user');
  if (changed) emit('task.changed', { projectId: params.id, taskId: params.tid, workerModel: true });
  return { changed, ...(await workerModelFacts(params.id, params.tid)) };
});
route('POST', '/api/projects/:id/tasks/:tid/review', async ({ params, body }) => workers.review(params.id, params.tid, { verdict: body?.verdict, note: String(body?.note || ''), managerSessionId: managerOf(body) }));

// ----- companion pins (.studio/pins.json): the Phone panel's Pin, the Companion tab's list and Remove -----
route('GET', '/api/projects/:id/companion/pins', async ({ params }) => ({ pins: await listPins((await projects.loadProject(params.id)).path) }));
route('POST', '/api/projects/:id/companion/attachments', async ({ params, body }) => saveAttachment((await projects.loadProject(params.id)).path, body || {}), { bodyLimit: 24 * 1024 * 1024 });
route('POST', '/api/projects/:id/companion/pins', async ({ params, body }) => {
  const pin = await addPin((await projects.loadProject(params.id)).path, body);
  emit('pins.changed', { projectId: params.id, added: pin.id });
  return pin;
});
route('DELETE', '/api/projects/:id/companion/pins/:pid', async ({ params }) => {
  const out = await removePin((await projects.loadProject(params.id)).path, params.pid);
  emit('pins.changed', { projectId: params.id, removed: params.pid });
  return out;
});

// ----- lessons (.studio/lessons/<id>.json; server/lib/lessons.mjs): the Learning view's shelf and display -----
route('GET', '/api/projects/:id/lessons', async ({ params }) => ({ lessons: await lessons.listLessons((await projects.loadProject(params.id)).path) }));
route('GET', '/api/projects/:id/lessons/:lid', async ({ params }) => lessons.getLesson((await projects.loadProject(params.id)).path, params.lid));
// The companion's atelier_show_lesson: create, or replace by id. The body may carry up to the html limit plus JSON escaping.
route('POST', '/api/projects/:id/lessons', async ({ params, body }) => {
  const out = await lessons.saveLesson((await projects.loadProject(params.id)).path, body);
  emit('lessons.changed', { projectId: params.id, lessonId: out.id, action: out.replaced ? 'replaced' : 'created' });
  return out;
}, { bodyLimit: 2 * 1024 * 1024 });
route('DELETE', '/api/projects/:id/lessons/:lid', async ({ params }) => {
  const out = await lessons.deleteLesson((await projects.loadProject(params.id)).path, params.lid);
  emit('lessons.changed', { projectId: params.id, lessonId: params.lid, action: 'deleted' });
  return out;
});

// ----- the inspiration board (.studio/inspiration.json and .studio/inspiration/; server/lib/inspiration.mjs, section 22) -----
const boardPath = async (id) => (await projects.loadProject(id)).path;
/** A card came or went: the briefing names the count, so it is written again; every change reaches the open views. */
async function boardChanged(projectId, what, { count = false } = {}) {
  if (count) { try { await briefing.regenerate(projectId); } catch (err) { console.error('[atelier] briefing regenerate failed', err.message); } }
  emit('inspiration.changed', { projectId, ...what });
}
route('GET', '/api/projects/:id/inspiration', async ({ params }) => inspiration.boardAnswer(await boardPath(params.id)));
// An image rides as base64 and a link waits for its preview (a timeout and a byte cap in server/lib/link-preview.mjs).
route('POST', '/api/projects/:id/inspiration', async ({ params, body }) => {
  const card = await inspiration.addCard(await boardPath(params.id), body);
  await boardChanged(params.id, { cardId: card.id, action: 'added' }, { count: true });
  return card;
}, { bodyLimit: inspiration.BODY_LIMIT });
route('POST', '/api/projects/:id/inspiration/move', async ({ params, body }) => {
  const out = await inspiration.moveCard(await boardPath(params.id), body);
  await boardChanged(params.id, { cardId: body?.id, action: 'moved' });
  return out;
});
route('PATCH', '/api/projects/:id/inspiration/:cid', async ({ params, body }) => {
  const card = await inspiration.patchCard(await boardPath(params.id), params.cid, body);
  await boardChanged(params.id, { cardId: card.id, action: 'changed' });
  return card;
});
route('DELETE', '/api/projects/:id/inspiration/:cid', async ({ params }) => {
  const out = await inspiration.removeCard(await boardPath(params.id), params.cid);
  await boardChanged(params.id, { cardId: params.cid, action: 'removed' }, { count: true });
  return out;
});
route('GET', '/api/projects/:id/inspiration/files/:name', async ({ params, res }) => {
  const f = await inspiration.readCardFile(await boardPath(params.id), params.name);
  res.writeHead(200, inspiration.fileHeaders(f));
  res.end(f.buf);
});

// ----- fixed rules (.studio/rules.json; server/lib/rules.mjs, section 23): what must stay the same in the project's design -----
/** A rule came, changed or went: the briefing lists the rules, so it is written again; the change reaches the open views. */
async function rulesChanged(projectId, what) {
  try { await briefing.regenerate(projectId); } catch (err) { console.error('[atelier] briefing regenerate failed', err.message); }
  emit('rules.changed', { projectId, ...what });
}
route('GET', '/api/projects/:id/rules', async ({ params }) => rules.rulesAnswer(await boardPath(params.id)));
route('POST', '/api/projects/:id/rules', async ({ params, body }) => {
  const rule = await rules.addRule(await boardPath(params.id), body);
  await rulesChanged(params.id, { ruleId: rule.id, action: 'added' });
  return rule;
});
route('PATCH', '/api/projects/:id/rules/:rid', async ({ params, body }) => {
  const rule = await rules.patchRule(await boardPath(params.id), params.rid, body);
  await rulesChanged(params.id, { ruleId: rule.id, action: 'changed' });
  return rule;
});
route('DELETE', '/api/projects/:id/rules/:rid', async ({ params }) => {
  const out = await rules.removeRule(await boardPath(params.id), params.rid);
  await rulesChanged(params.id, { ruleId: params.rid, action: 'removed' });
  return out;
});

// ----- references (.studio/references.json; server/lib/references.mjs, section 25): what the project keeps to build from -----
/** An entry came, changed or went: the briefing names the count, so it is written again when that moved. */
async function referencesChanged(projectId, what, { count = false } = {}) {
  if (count) { try { await briefing.regenerate(projectId); } catch (err) { console.error('[atelier] briefing regenerate failed', err.message); } }
  emit('references.changed', { projectId, ...what });
}
route('GET', '/api/projects/:id/references', async ({ params }) => references.refsAnswer(await boardPath(params.id)));
// A link waits for its page's title (a timeout and a byte cap in server/lib/link-preview.mjs).
route('POST', '/api/projects/:id/references', async ({ params, body }) => {
  const entry = await references.addRef(await boardPath(params.id), body);
  await referencesChanged(params.id, { refId: entry.id, action: 'added' }, { count: true });
  return entry;
});
route('PATCH', '/api/projects/:id/references/:rid', async ({ params, body }) => {
  const entry = await references.patchRef(await boardPath(params.id), params.rid, body);
  await referencesChanged(params.id, { refId: entry.id, action: 'changed' });
  return entry;
});
route('DELETE', '/api/projects/:id/references/:rid', async ({ params }) => {
  const out = await references.removeRef(await boardPath(params.id), params.rid);
  await referencesChanged(params.id, { refId: params.rid, action: 'removed' }, { count: true });
  return out;
});

// ----- the Visualizer (server/lib/visualizer.mjs, section 26): the design the web entry's stylesheets hold, beside the
// fixed rules and the board's colours. It reads the files as they are now and writes nothing. -----
route('GET', '/api/projects/:id/visualizer', async ({ params }) => visualizerAnswer(await projects.loadProject(params.id)));

// ----- the Page tab (server/lib/page.mjs): the entry's sibling pages, and the files an element on the preview is in -----
route('GET', '/api/projects/:id/page/files', async ({ params }) => {
  const ctx = await projects.loadProject(params.id);
  return { entry: ctx.manifest?.entry || null, siblings: await siblingPages(ctx.path, ctx.manifest?.entry) };
});
route('POST', '/api/projects/:id/page/inspect', async ({ params, body }) => pageInspect(await projects.loadProject(params.id), body));

// ----- the Skills tab (server/lib/skills.mjs): Claude Code skills of the project, the person and installed plugins -----
const skillsCtx = async (projectId) => ({ projectPath: projectId ? (await projects.loadProject(projectId)).path : null });
// departments: the studio-wide many-to-many map (server/lib/departments.mjs); the tab reads its absence as an older server.
route('GET', '/api/skills', async ({ query }) => ({ ...(await skills.listSkills(await skillsCtx(query.get('projectId')))), departments: await departments.loadDepartments() }));
route('POST', '/api/skills/departments', async ({ body }) => {
  const list = await departments.changeDepartments(body || {});
  emit('skills.changed', { departments: true, action: body?.action || null });
  return { departments: list };
});
route('GET', '/api/skills/file', async ({ query }) => skills.readSkill(await skillsCtx(query.get('projectId')), query.get('path') || ''));
// Open a listed skill's folder (or a place the listing looked in) in the system's file manager; any other path is refused.
route('POST', '/api/skills/reveal', async ({ body }) => skills.revealFolder(await skillsCtx(body?.projectId || null), body?.path || ''));
route('POST', '/api/skills/install', async ({ body }) => {
  const out = await skills.installSkill(await skillsCtx(body?.projectId || null), body || {});
  if (out.installed) emit('skills.changed', { projectId: body.projectId || null, name: out.name, target: out.target });
  return out;
}, { bodyLimit: skills.INSTALL_BODY_LIMIT });

// ----- memory -----
async function projectPathOf(query) {
  const id = query.get('projectId');
  if (!id) return { projectPath: null, projectId: null };
  const ctx = await projects.loadProject(id);
  return { projectPath: ctx.path, projectId: id };
}
route('GET', '/api/memory', async ({ query }) => {
  const { projectPath, projectId } = await projectPathOf(query);
  return memory.listMemory({ scope: query.get('scope') || 'all', projectPath, projectId, q: query.get('q') || '', kind: query.get('kind') || null, includeRetracted: query.get('includeRetracted') === '1', limit: Number(query.get('limit') || 50) });
});
route('GET', '/api/memory/export', async ({ query }) => memory.exportMemory(await projectPathOf(query)));
route('POST', '/api/memory', async ({ body, query }) => {
  const projectId = body.projectId || query.get('projectId');
  const ctx = projectId ? await projects.loadProject(projectId) : null;
  const rec = await memory.addMemory({ ...body, provenance: { source: 'user', ...(body.provenance || {}) } }, { projectPath: ctx?.path || null, projectId });
  emit('memory.changed', { id: rec.id, scope: rec.scope });
  await regenerateAll(ctx ? [projectId] : null);
  return rec;
});
route('PATCH', '/api/memory/:id', async ({ params, body, query }) => {
  const { projectPath } = await projectPathOf(query);
  const out = await memory.correctMemory(params.id, body, { projectPath, actor: 'user' });
  emit('memory.changed', { id: params.id, replacedBy: out.record.id });
  await regenerateAll(null);
  return out;
});
route('DELETE', '/api/memory/:id', async ({ params, query }) => {
  const { projectPath } = await projectPathOf(query);
  const out = await memory.deleteMemory(params.id, { projectPath });
  emit('memory.changed', { id: params.id, deleted: true });
  await regenerateAll(null);
  return out;
});
async function regenerateAll(ids) {
  const reg = await loadRegistry();
  const list = ids || reg.projects.map((p) => p.id);
  for (const id of list) {
    try {
      await briefing.regenerate(id);
    } catch (err) {
      console.error('[atelier] regenerate', id, err.message);
    }
  }
}
route('GET', '/api/briefing', async ({ query }) => {
  const id = query.get('projectId');
  if (!id) throw new HttpError(400, 'invalid_input', 'projectId is required');
  const { markdown, sources } = await briefing.composeBriefing(id);
  return { markdown, sources };
});

// ----- user-wide resources (capability catalogue) -----
const userResources = (await import('./lib/stores.mjs')).listStore(path.join(DATA_DIR, 'resources.json'), 'r');
route('GET', '/api/resources', async () => userResources.all());
route('POST', '/api/resources', async ({ body }) => {
  const out = await userResources.add({ status: 'discovered', ...body });
  emit('memory.changed', { resource: out.id });
  return out;
});
route('PATCH', '/api/resources/:rid', async ({ params, body }) => userResources.patch(params.rid, body));

// ----- budget / usage / utility -----
route('GET', '/api/budget', async () => ({ ...(await utility.budget.get()), status: await utility.status() }));
route('PATCH', '/api/budget', async ({ body }) => {
  const out = await utility.budget.patch(body);
  emit('budget.changed', {});
  return out;
});
route('GET', '/api/usage', async ({ query }) => ({ ...(await utility.usage.summary({ projectId: query.get('projectId') || null })), recent: await utility.usage.recent(Number(query.get('limit') || 50)) }));
route('GET', '/api/utility', async () => utility.status());
route('POST', '/api/utility/cancel', async ({ body }) => ({ cancelled: utility.cancel(body.runId) }));
route('POST', '/api/utility/:task', async ({ params, body }) => utility.run(params.task, { projectId: body.projectId || null, taskId: body.taskId || null, input: body.input || {} }, { runId: typeof body.runId === 'string' ? body.runId : undefined }));
route('POST', '/api/secrets/api-key', async ({ body }) => {
  const out = await setApiKey(body.key || '');
  emit('budget.changed', { keyChanged: true });
  return out;
});
// The studio's Claude Code sign-in: a token from claude setup-token, kept server-side; empty removes it.
route('POST', '/api/secrets/claude-token', async ({ body }) => {
  const token = typeof body.token === 'string' ? body.token : '';
  const problem = claudeTokenProblem(token);
  if (problem) throw new HttpError(400, 'invalid_token', problem);
  const saved = await setClaudeToken(token);
  const status = await consoleSvc.authStatus({ fresh: true });
  emit('console.auth', { saved: saved.saved });
  return { ...saved, status };
});

// ----- console -----
route('GET', '/api/console/backends', async () => consoleSvc.backends());
route('GET', '/api/console/auth', async ({ query }) => consoleSvc.authStatus({ fresh: query.get('fresh') === '1' }));
// Codex as the Codex tab needs it before a run: the CLI, `codex login status`, the models and config.toml's defaults.
route('GET', '/api/console/codex', async ({ query }) => consoleSvc.codexStatus({ fresh: query.get('fresh') === '1' }));
route('GET', '/api/console/sessions', async ({ query }) => consoleSvc.listSessions({ projectId: query.get('projectId') || null }));
route('POST', '/api/console/sessions', async ({ body }) => consoleSvc.createSession(body || {}));
route('GET', '/api/console/sessions/:id', async ({ params }) => consoleSvc.getSession(params.id));
route('PATCH', '/api/console/sessions/:id', async ({ params, body }) => consoleSvc.patchSession(params.id, body || {}));
route('DELETE', '/api/console/sessions/:id', async ({ params }) => consoleSvc.deleteSession(params.id));
route('POST', '/api/console/sessions/:id/send', async ({ params, body, res }) => {
  json(res, 202, await consoleSvc.send(params.id, { text: body.text, context: body.context }));
});
route('POST', '/api/console/sessions/:id/cancel', async ({ params }) => consoleSvc.cancel(params.id));

function checkConsoleSettings(c) {
  if (c == null) return;
  if (typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, 'invalid_input', 'console must be an object');
  for (const k of ['command', 'claudePath', 'codexPath']) if (k in c && typeof c[k] !== 'string') throw new HttpError(400, 'invalid_input', `console.${k} must be a string`);
  if ('commandMode' in c && !['stdin', 'arg'].includes(c.commandMode)) throw new HttpError(400, 'invalid_input', 'console.commandMode must be stdin or arg');
  if ('terminalFont' in c && !(typeof c.terminalFont === 'string' && c.terminalFont.length <= 120)) throw new HttpError(400, 'invalid_input', 'console.terminalFont must be a string of at most 120 characters');
  if ('timeoutMs' in c && !(Number.isFinite(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 6 * 3600 * 1000)) throw new HttpError(400, 'invalid_input', 'console.timeoutMs must be 1000..21600000');
}

/** devices.android { sdkRoot, javaHome, nodeRoot }: folders as typed, each a string of at most 400 characters on one line. */
function checkDevicesSettings(d) {
  if (d == null) return;
  if (typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'invalid_input', 'devices must be an object');
  for (const k of Object.keys(d)) if (k !== 'android') throw new HttpError(400, 'invalid_input', `devices.${k} is not a setting`);
  const a = d.android;
  if (a == null) return;
  if (typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'invalid_input', 'devices.android must be an object');
  for (const [k, v] of Object.entries(a)) {
    if (!TOOL_KEYS.includes(k)) throw new HttpError(400, 'invalid_input', `devices.android.${k} is not a setting (${TOOL_KEYS.join(', ')})`);
    if (typeof v !== 'string' || v.length > 400 || /[\r\n]/.test(v)) throw new HttpError(400, 'invalid_input', `devices.android.${k} must be a string of at most 400 characters with no newline`);
  }
}

// ----- evidence, settings, templates -----
// ----- live: status (masked), the person's allowance, start and stop. Only GET /live/<id> hands the full URL on. -----
route('GET', '/api/projects/:id/live', async ({ params }) => live.status(params.id));
route('POST', '/api/projects/:id/live/consent', async ({ params, body }) => live.allow(params.id, { command: body?.command, cwd: body?.cwd }));
route('DELETE', '/api/projects/:id/live/consent', async ({ params }) => live.forget(params.id));
route('POST', '/api/projects/:id/live/start', async ({ params, body }) => live.start(params.id, { origin: typeof body?.origin === 'string' ? body.origin : null }));
route('POST', '/api/projects/:id/live/stop', async ({ params }) => live.stop(params.id, 'you switched Live off'));

// ----- terminal -----
const intIn = (n) => Number.isInteger(n) && n >= 2 && n <= 500;
route('GET', '/api/terminal', async () => terminals.list());
route('POST', '/api/terminal', async ({ body }) => terminals.open({ projectId: body.projectId || null, cols: body.cols ?? 100, rows: body.rows ?? 30, shell: body.shell ?? null }));
route('GET', '/api/terminal/:id/stream', async ({ params, res }) => terminals.attach(params.id, res));
route('POST', '/api/terminal/:id/input', async ({ params, body }) => terminals.write(params.id, body.data));
route('POST', '/api/terminal/:id/resize', async ({ params, body }) => {
  if (!intIn(body.cols) || !intIn(body.rows)) throw new HttpError(400, 'invalid_input', 'cols and rows must be integers 2..500');
  return terminals.resize(params.id, body.cols, body.rows);
});
route('DELETE', '/api/terminal/:id', async ({ params }) => terminals.close(params.id));

// ----- runs: what runs now and what ended in the last 24 h this process remembers (section 16) -----
route('GET', '/api/runs', async ({ query }) => {
  const projectId = query.get('projectId') || 'all';
  if (projectId !== 'all' && !/^p_[a-z0-9]+$/.test(projectId)) throw new HttpError(400, 'invalid_input', 'projectId must be a project id or all');
  return runs.list({ projectId });
});

route('GET', '/api/evidence/models', async ({ query }) => modelEvidence({ days: Number(query.get('days') || 7) }));
const DEVICES_DEFAULTS = { android: { sdkRoot: '', javaHome: '', nodeRoot: '' } };
const withConsoleDefaults = (settings) => ({ ...settings, console: { ...CONSOLE_DEFAULTS, ...(settings?.console || {}) }, devices: { ...(settings?.devices || {}), android: { ...DEVICES_DEFAULTS.android, ...(settings?.devices?.android || {}) } } });
route('GET', '/api/settings', async () => withConsoleDefaults((await loadRegistry()).settings));
// Where the Android tools were looked for and found, from the settings (and a project's tool file with ?projectId).
route('GET', '/api/settings/devices', async ({ query }) => {
  const id = query.get('projectId');
  const projectPath = id ? (await projects.loadProject(id)).path : null;
  return { android: publicTools(await resolveTools({ projectPath, settings: (await loadRegistry()).settings })) };
});
route('PATCH', '/api/settings', async ({ body }) => {
  checkConsoleSettings(body.console);
  checkDevicesSettings(body.devices);
  // The studio's default worker model goes through its own check and write (null or default clears it), not the spread below.
  let workerModel;
  let appearance;
  ({ workerModel, appearance, ...body } = body);
  if (workerModel !== undefined) await setStudioWorkerModel(workerModel);
  // The look has its own check and write too (server/lib/appearance.mjs): an option that does not exist, an accent
  // under AA contrast or a control a fixed rule locks is refused there and nothing is written.
  if (appearance !== undefined) await saveAppearance(appearance);
  const settings = await updateRegistry((reg) => {
    const devices = body.devices ? { ...(reg.settings.devices || {}), ...body.devices, android: { ...(reg.settings.devices?.android || {}), ...(body.devices.android || {}) } } : reg.settings.devices;
    reg.settings = { ...reg.settings, ...body, ui: { ...(reg.settings.ui || {}), ...(body.ui || {}) }, apiUtility: { ...(reg.settings.apiUtility || {}), ...(body.apiUtility || {}) }, console: { ...CONSOLE_DEFAULTS, ...(reg.settings.console || {}), ...(body.console || {}) }, ...(devices ? { devices } : {}) };
    return reg.settings;
  });
  utilityModel = settings.apiUtility?.model || utilityModel;
  emit('status', { settings: true });
  return settings;
});
// The look alone, with what a fixed rule locks: { stored, effective, locks, rulesProject, rulesUnread } (section 24).
route('GET', '/api/settings/appearance', async () => appearanceFacts());
route('GET', '/api/templates', async () => projects.listTemplates());
// The companion's atelier_studio_show (docs/ARCHITECTURE.md section 11): the open windows move, nothing is stored.
// delivered counts the event streams open now, so the tool can say when no window received it.
route('POST', '/api/studio/show', async ({ body }) => {
  const { show, error } = checkShow(body);
  if (error) throw new HttpError(400, 'invalid_input', error);
  if (show.projectId) await projects.loadProject(show.projectId); // 404 for an id that is not registered
  const delivered = clientCount();
  emit('studio.show', show);
  return { ...show, delivered };
});
// Health names this process so `npm run restart` can verify what it stops (pid + platform + port).
route('GET', '/api/health', async () => ({ ok: true, ts: nowIso(), pid: process.pid, platform: process.platform, port: PORT, startedAt: STARTED_AT, version: pkg.version }));
// The studio guide (docs/GUIDE.md) as markdown text, for the in-app help.
route('GET', '/api/guide', async ({ res }) => {
  const text = await fsp.readFile(path.join(STUDIO_DIR, 'docs', 'GUIDE.md'), 'utf8').catch(() => null);
  const body = text ?? 'The guide (docs/GUIDE.md) is not in this studio folder.';
  res.writeHead(text == null ? 404 : 200, { 'Content-Type': `${text == null ? 'text/plain' : 'text/markdown'}; charset=utf-8`, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
  res.end(body);
});
// What this computer is (CPU, memory, OS, GPU names); cached per process, ?refresh=1 collects again.
route('GET', '/api/machine', async ({ query }) => machineInfo({ refresh: query.get('refresh') === '1' }));

// ----- workbench routes (workbenches/README.md): a server.mjs that exports routes(route, deps) owns its routes -----
for (const e of await fsp.readdir(WORKBENCH_DIR, { withFileTypes: true }).catch(() => [])) {
  const file = path.join(WORKBENCH_DIR, e.name, 'server.mjs');
  if (!e.isDirectory() || !(await exists(file))) continue;
  try {
    const mod = await import(`file://${file.replace(/\\/g, '/')}`);
    const register = mod.routes || mod.default?.routes;
    if (typeof register === 'function') register(route, { loadProject: (id) => projects.loadProject(id), loadRegistry, HttpError, emit });
  } catch (err) {
    console.error(`[atelier] workbench ${e.name} routes not loaded:`, err.message);
  }
}

// ---------- static + dispatch ----------
async function serveStatic(res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root))) throw new HttpError(403, 'forbidden', 'Nope');
  let stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new HttpError(404, 'not_found', `Not found: ${rel}`);
  const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
  const buf = await fsp.readFile(target);
  res.writeHead(200, { 'Content-Type': mimeFor(target), 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

// xterm.js for the Terminal mode, from node_modules: an explicit allowlist, nothing else there is reachable.
const VENDOR_XTERM = {
  '/vendor/xterm/xterm.js': path.join(STUDIO_DIR, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/xterm/xterm.css': path.join(STUDIO_DIR, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/xterm/addon-fit.js': path.join(STUDIO_DIR, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};
async function serveVendor(res, p) {
  const file = Object.hasOwn(VENDOR_XTERM, p) ? VENDOR_XTERM[p] : null;
  if (!file) throw new HttpError(404, 'not_found', `Not found: ${p}`);
  const buf = await fsp.readFile(file).catch(() => null);
  if (!buf) throw new HttpError(404, 'not_found', `Not installed: ${p} (run npm install)`);
  res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

const STARTED_AT = nowIso();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/events') return subscribe(res);
    if (p.startsWith('/live/')) {
      const projectId = p.split('/')[2] || '';
      await projects.loadProject(projectId); // 404 for an id that is not registered
      return serveLiveFrame(res, live.frameUrl(projectId));
    }
    if (p.startsWith('/preview/')) {
      const [, , projectId, ref, ...rest] = p.split('/');
      if (!projectId || !ref) throw new HttpError(404, 'not_found', 'Preview path');
      return await servePreview(req, res, { projectId, ref, rel: rest.join('/') });
    }
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, r.bodyLimit) : {};
        const out = await r.handler({ params, query: url.searchParams, body, req, res });
        if (!res.headersSent) json(res, 200, out ?? {});
        return;
      }
      throw new HttpError(404, 'not_found', `No route ${req.method} ${p}`);
    }
    if (p.startsWith('/vendor/')) return await serveVendor(res, p);
    if (p.startsWith('/workbenches/')) return await serveStatic(res, WORKBENCH_DIR, p.slice('/workbenches/'.length));
    return await serveStatic(res, CLIENT_DIR, p === '/' ? 'index.html' : p.slice(1));
  } catch (err) {
    if (res.headersSent) return res.end();
    fail(res, err);
  }
});

// ---------- startup ----------
// A new data folder starts with no memory: a preference is something the person said, so none is written for them.
await ensureDir(DATA_DIR);
await updateRegistry(() => {});
if (!(await exists(path.join(DATA_DIR, 'usage')))) await ensureDir(path.join(DATA_DIR, 'usage'));

// Watch task folders so Claude Code's CLI writes show up live.
// The create and import routes call this too: until the next tick a new project's CLI notes reach no one.
const watchers = new Map(); // .studio folder -> { watcher, projectId }; by folder, because one folder can come back under another id
const watchKey = (projectPath) => folderKey(path.join(projectPath, '.studio'));
function closeWatcher(key) {
  const record = watchers.get(key);
  watchers.delete(key);
  record?.watcher.close();
}
let watchScan = Promise.resolve();
/** One scan at a time, or two at once could both find a project unwatched and watch it twice. Never rejects. */
function watchProjects() {
  watchScan = watchScan.then(attachWatchers).catch((err) => console.error('[atelier] watch scan failed:', err.message));
  return watchScan;
}
async function attachWatchers() {
  const reg = await loadRegistry();
  const wanted = new Map();
  for (const p of reg.projects) if (!wanted.has(watchKey(p.path))) wanted.set(watchKey(p.path), p);
  for (const [key, record] of watchers) if (wanted.get(key)?.id !== record.projectId) closeWatcher(key);
  for (const [key, p] of wanted) {
    if (watchers.has(key)) continue;
    const dir = path.join(p.path, '.studio');
    if (!(await exists(dir))) continue;
    try {
      const record = { projectId: p.id };
      // The listener holds reports back for a moment: one still waiting when the watcher closes says nothing.
      record.watcher = watch(dir, { recursive: true }, createWatchListener((type, data) => { if (watchers.get(key) === record) emit(type, { projectId: p.id, ...data }); }));
      record.watcher.on('error', () => { if (watchers.get(key) === record) closeWatcher(key); });
      watchers.set(key, record);
    } catch (err) {
      console.error('[atelier] watch failed for', p.path, err.message);
    }
  }
}
await watchProjects();
setInterval(watchProjects, 15000).unref();

// Pid file: {pid, platform, port, startedAt}. ATELIER_PID_FILE moves it (the tests use a temp path so a
// test server never overwrites the real studio's file, which is what made `npm run restart` find stale pids).
const PID_FILE = process.env.ATELIER_PID_FILE || path.join(STUDIO_DIR, '.local', 'server.pid');
await ensureDir(path.dirname(PID_FILE));
await fsp.writeFile(PID_FILE, pidFileContent({ pid: process.pid, port: PORT, startedAt: STARTED_AT }));
// Drop the pid file on a clean exit, but only if it still names this process.
const dropPidFile = () => {
  try { if (JSON.parse(readFileSync(PID_FILE, 'utf8')).pid === process.pid) rmSync(PID_FILE); } catch { /* already gone or not ours */ }
};
process.on('exit', dropPidFile);
// Terminals are not persisted: end every shell this process started before it goes.
process.on('exit', () => terminals.closeAll());
// Live servers too: their process trees end with the studio (killTree is synchronous, so it runs in the exit handler).
process.on('exit', () => live.stopAll());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { terminals.closeAll(); live.stopAll(); process.exit(0); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[atelier] v${pkg.version}${studioGitSha ? ` (${studioGitSha})` : ''} on http://127.0.0.1:${PORT}`);
  console.log(`[atelier] data ${DATA_DIR} · projects ${PROJECTS_DIR}`);
  // After a restart: tell the managers of the workers it cut off, start the kept queues, deliver the held reports.
  // Once listening, because a manager's turn runs the studio's MCP server, which talks to this port.
  workers.reconcile().then((out) => {
    if (out.interrupted.length || out.started.length || out.waiting.length || out.delivered || out.dropped.length) console.log(`[atelier] workers after the restart: ${out.interrupted.length} interrupted (${out.interrupted.join(', ') || 'none'}), ${out.started.length} queued started, ${out.waiting.length} waiting for their manager, ${out.delivered} reports delivered${out.dropped.length ? `, ${out.dropped.length} queue entries dropped (${out.dropped.join(', ')})` : ''}`);
  }).catch((err) => console.error('[atelier] workers reconcile failed', err.message));
});
