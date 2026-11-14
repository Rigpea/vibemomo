// The studio's default worker model, stored (docs/ARCHITECTURE.md section 17): ~/.atelier/registry.json
// settings.workerModel, as the skill departments are kept. Nothing stored means the built-in WORKER_MODEL. Read at
// every worker launch, so a change reaches the next worker without a restart.
import { loadRegistry, updateRegistry } from './registry.mjs';
import { CONSOLE_MODELS, WORKER_MODEL, checkWorkerModel, ownWorkerModel, resolveWorkerModel, WORKER_MODEL_SOURCES } from './models.mjs';

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
 * The three levels as a route answers them and the tools word them: what each holds, and the model the next worker
 * of this project (and task, when given) starts on with its source.
 */
export function workerModelLevels({ studio, project = null, task = null }) {
  const effective = resolveWorkerModel({ task, project: project?.record || null, studioDefault: studio.model });
  return {
    models: [...CONSOLE_MODELS],
    studio,
    project: project ? { id: project.id, name: project.name, model: ownWorkerModel(project.record) } : null,
    task: task ? { id: task.id, title: task.title, status: task.status, model: ownWorkerModel(task) } : null,
    effective: { ...effective, words: WORKER_MODEL_SOURCES[effective.source] },
  };
}
