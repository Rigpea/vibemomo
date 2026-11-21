// The Claude Code models the studio offers, and the worker model at its three levels: a task's own, its project's, the
// studio default (docs/ARCHITECTURE.md section 17). A module of its own so projects.mjs can check a worker model
// without importing console.mjs, which imports tasks.mjs, which imports projects.mjs. Pure: the stored studio default
// is read and written in worker-model.mjs.
//
// A worker model is one string wherever it is kept (task.json, project.json, the registry's settings): a Claude Code
// model id for a Claude Code worker, or `codex:<model>` / `codex:<model>@<effort>` for a worker on the person's Codex
// CLI (decision row 182). This module checks the form only; whether Codex offers that model and effort on this
// machine is asked where ~/.codex can be read (worker-model.mjs checkCodexWorker, and again when a worker starts).
import { HttpError } from './paths.mjs';

export const CONSOLE_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

/** The built-in studio default: used when the registry's settings store no workerModel (worker-model.mjs). */
export const WORKER_MODEL = 'claude-fable-5-2';

export const WORKER_BACKENDS = ['claude-code', 'codex'];
export const CODEX_WORKER_PREFIX = 'codex:';
const CODEX_MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/; // as server/lib/codex.mjs MODEL_RE: never an "@", so the effort splits off cleanly
const CODEX_EFFORT_RE = /^[a-z]{2,12}$/;
export const CODEX_WORKER_FORM = 'codex:<model> or codex:<model>@<effort> for a worker on the Codex CLI';

/**
 * A stored worker model read apart: { backend: 'claude-code', model } for a Claude Code model the studio offers,
 * { backend: 'codex', model, effort } (effort null: Codex's configured one) for a well-formed Codex value, else null.
 */
export function parseWorkerModel(value) {
  if (typeof value !== 'string') return null;
  if (CONSOLE_MODELS.includes(value)) return { backend: 'claude-code', model: value };
  if (!value.startsWith(CODEX_WORKER_PREFIX)) return null;
  const rest = value.slice(CODEX_WORKER_PREFIX.length);
  const at = rest.lastIndexOf('@');
  const model = at < 0 ? rest : rest.slice(0, at);
  const effort = at < 0 ? null : rest.slice(at + 1);
  if (!CODEX_MODEL_RE.test(model) || (effort !== null && !CODEX_EFFORT_RE.test(effort))) return null;
  return { backend: 'codex', model, effort };
}

/** The one string a Codex worker choice is kept as. */
export const codexWorkerValue = (model, effort = null) => `${CODEX_WORKER_PREFIX}${model}${effort ? `@${effort}` : ''}`;

/**
 * A worker model as a record keeps it (a task's, a project's, the studio's): null (or 'default', or '') means the
 * level above and removes the field; any other value must be one of CONSOLE_MODELS or a well-formed Codex value,
 * else a 400 that names the choices.
 */
export function checkWorkerModel(value) {
  if (value === null || value === undefined || value === '' || value === 'default') return null;
  if (!parseWorkerModel(value)) {
    throw new HttpError(400, 'invalid_input', `workerModel must be one of ${CONSOLE_MODELS.join(', ')}, or default (got ${JSON.stringify(value)}); or ${CODEX_WORKER_FORM}`);
  }
  return value;
}

/** A record's own worker model when it is one the studio takes, else null (a value edited in by hand counts as none). */
export const ownWorkerModel = (record) => (parseWorkerModel(record?.workerModel) ? record.workerModel : null);

/** The model a worker of this project starts on when its task names none: the project's own valid setting, else the fallback. */
export function workerModelOf(project, fallback = WORKER_MODEL) {
  return ownWorkerModel(project) || fallback;
}

export const WORKER_MODEL_SOURCES = { task: 'set for this task', project: 'set for this project', studio: 'studio default' };

/**
 * The model the next worker starts on and where it comes from: the task's own, else the project's, else the studio
 * default (studioDefault: the stored one, else the built-in WORKER_MODEL). -> { model, source: task|project|studio }.
 */
export function resolveWorkerModel({ task = null, project = null, studioDefault = WORKER_MODEL } = {}) {
  const own = ownWorkerModel(task);
  if (own) return { model: own, source: 'task' };
  const projects = ownWorkerModel(project);
  if (projects) return { model: projects, source: 'project' };
  return { model: parseWorkerModel(studioDefault) ? studioDefault : WORKER_MODEL, source: 'studio' };
}

/**
 * A worker in words, naming the backend whenever it is not Claude Code: a stored value ("codex:gpt-6-astra@xhigh")
 * or what a worker ran on ({ backend, model, effort }). A Claude Code model reads as its id, as it always did.
 */
export function workerWords(worker) {
  const w = typeof worker === 'string' ? parseWorkerModel(worker) || { backend: 'claude-code', model: worker } : worker;
  if (!w || !w.model) return 'a model that was not recorded';
  if (w.backend !== 'codex') return w.model;
  return `Codex ${w.model} at ${w.effort ? `${w.effort} effort` : 'the effort Codex is configured with'}`;
}

/** The worker model in words, for the briefing and the CLI: the model and where it comes from. */
export function workerModelWords(project, fallback = WORKER_MODEL) {
  const { model, source } = resolveWorkerModel({ project, studioDefault: fallback });
  return `${workerWords(model)} (${WORKER_MODEL_SOURCES[source]})`;
}
