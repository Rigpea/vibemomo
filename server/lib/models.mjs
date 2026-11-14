// The Claude Code models the studio offers, and the worker model at its three levels: a task's own, its project's, the
// studio default (docs/ARCHITECTURE.md section 17). A module of its own so projects.mjs can check a worker model
// without importing console.mjs, which imports tasks.mjs, which imports projects.mjs. Pure: the stored studio default
// is read and written in worker-model.mjs.
import { HttpError } from './paths.mjs';

export const CONSOLE_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

/** The built-in studio default: used when the registry's settings store no workerModel (worker-model.mjs). */
export const WORKER_MODEL = 'claude-fable-5-2';

/**
 * A worker model as a record keeps it (a task's, a project's, the studio's): null (or 'default', or '') means the
 * level above and removes the field; any other value must be one of CONSOLE_MODELS, else a 400 that names the choices.
 */
export function checkWorkerModel(value) {
  if (value === null || value === undefined || value === '' || value === 'default') return null;
  if (typeof value !== 'string' || !CONSOLE_MODELS.includes(value)) {
    throw new HttpError(400, 'invalid_input', `workerModel must be one of ${CONSOLE_MODELS.join(', ')}, or default (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** A record's own worker model when it is one the studio offers, else null (a value edited in by hand counts as none). */
export const ownWorkerModel = (record) => (typeof record?.workerModel === 'string' && CONSOLE_MODELS.includes(record.workerModel) ? record.workerModel : null);

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
  return { model: CONSOLE_MODELS.includes(studioDefault) ? studioDefault : WORKER_MODEL, source: 'studio' };
}

/** The worker model in words, for the briefing and the CLI: the model and where it comes from. */
export function workerModelWords(project, fallback = WORKER_MODEL) {
  const { model, source } = resolveWorkerModel({ project, studioDefault: fallback });
  return `${model} (${WORKER_MODEL_SOURCES[source]})`;
}
