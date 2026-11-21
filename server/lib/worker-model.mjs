// The studio's default worker model, stored (docs/ARCHITECTURE.md section 17): ~/.atelier/registry.json
// settings.workerModel, as the skill departments are kept. Nothing stored means the built-in WORKER_MODEL. Read at
// every worker launch, so a change reaches the next worker without a restart.
import { loadRegistry, updateRegistry } from './registry.mjs';
import { CONSOLE_MODELS, WORKER_MODEL, checkWorkerModel, ownWorkerModel, parseWorkerModel, resolveWorkerModel, workerWords, WORKER_MODEL_SOURCES } from './models.mjs';
import { codexChoices, codexHome, checkCodexChoice } from './codex.mjs';

/** { stored, fallback, model }: what the registry holds (null: nothing, or a value the studio does not offer), the built-in, and the one in effect. */
export function studioWorkerModelOf(settings) {
  const stored = ownWorkerModel(settings);
  return { stored, fallback: WORKER_MODEL, model: stored || WORKER_MODEL };
}

export async function loadStudioWorkerModel() {
  return studioWorkerModelOf((await loadRegistry()).settings);
}

/** Store the studio default, or clear it with null or 'default'; an unknown model is a 400 and writes nothing. */
export async function saveStudioWorkerModel(value) {
  const model = checkWorkerModel(value);
  return updateRegistry((reg) => {
    const settings = { ...(reg.settings || {}) };
    if (model) settings.workerModel = model; else delete settings.workerModel;
    reg.settings = settings;
    return studioWorkerModelOf(settings);
  });
}

/**
 * A Codex worker value checked against what Codex offers on this machine (~/.codex/models_cache.json, else the
 * built-in list): a model it does not list, or an effort that model does not take, is the Codex tab's own 400. Any
 * other value passes through: checkWorkerModel is the check of its form. choices: codexChoices' answer, for tests.
 */
export async function checkCodexWorker(value, { env = process.env, choices = null } = {}) {
  const w = parseWorkerModel(value);
  if (w?.backend !== 'codex') return value;
  checkCodexChoice(choices || await codexChoices(codexHome(env)), { model: w.model, effort: w.effort });
  return value;
}

/** What Codex offers a worker, as the tools and the Focus panel list it: [{ id, name, efforts }] and config.toml's defaults. */
export async function codexWorkerChoices({ env = process.env } = {}) {
  const { models, source, defaults } = await codexChoices(codexHome(env));
  return { models: models.map((m) => ({ id: m.id, name: m.name, efforts: m.efforts })), source, defaults };
}

/**
 * The three levels as a route answers them and the tools word them: what each holds, and the model the next worker
 * of this project (and task, when given) starts on with its source. Every model is the stored string; effective also
 * says it apart (backend, and for Codex the model and effort) and in words (label).
 */
export function workerModelLevels({ studio, project = null, task = null }) {
  const effective = resolveWorkerModel({ task, project: project?.record || null, studioDefault: studio.model });
  const parsed = parseWorkerModel(effective.model) || { backend: 'claude-code', model: effective.model };
  return {
    models: [...CONSOLE_MODELS],
    studio,
    project: project ? { id: project.id, name: project.name, model: ownWorkerModel(project.record) } : null,
    task: task ? { id: task.id, title: task.title, status: task.status, model: ownWorkerModel(task) } : null,
    effective: { ...effective, words: WORKER_MODEL_SOURCES[effective.source], backend: parsed.backend, label: workerWords(effective.model), ...(parsed.backend === 'codex' ? { codexModel: parsed.model, effort: parsed.effort } : {}) },
  };
}
