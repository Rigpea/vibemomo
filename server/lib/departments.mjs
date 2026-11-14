// Skill departments, studio-wide (docs/ARCHITECTURE.md section 18): kept in ~/.atelier/registry.json as
// settings.skillDepartments, changed one op at a time through a queue so two quick ticks cannot overwrite each other.
// The pure rules are client/components/skill-departments.js; this file reads and writes the registry, resolves a
// task's department and finds what that department holds for a project (tasks.mjs departmentParagraph words it).
import { HttpError } from './paths.mjs';
import { loadRegistry, updateRegistry } from './registry.mjs';
import { listSkills } from './skills.mjs';
import { normalizeDepartments, applyDepartmentOp, findDepartment } from '../../client/components/skill-departments.js';

const STATUS = { invalid_input: 400, not_found: 404, name_taken: 409 };
let queue = Promise.resolve();

export async function loadDepartments() {
  return normalizeDepartments((await loadRegistry()).settings?.skillDepartments);
}

/** Apply one op (skill-departments.js applyDepartmentOp) and keep the result; answers the new list. */
export function changeDepartments(op) {
  const run = queue.then(() => updateRegistry((reg) => {
    let next;
    try {
      next = applyDepartmentOp(reg.settings?.skillDepartments, op);
    } catch (err) {
      throw new HttpError(STATUS[err.code] || 400, err.code || 'invalid_input', err.message);
    }
    reg.settings = { ...(reg.settings || {}), skillDepartments: next };
    return next;
  }));
  queue = run.catch(() => {});
  return run;
}

/** A task's department from what a caller gave (an id or a name): { id, name }, null when none was given; 400 when unknown. */
export async function resolveTaskDepartment(ref) {
  if (ref == null || ref === '') return null;
  if (typeof ref !== 'string') throw new HttpError(400, 'invalid_input', 'department must be a department\'s id or name');
  const list = await loadDepartments();
  const d = findDepartment(list, ref);
  if (!d) throw new HttpError(400, 'invalid_input', `No department named ${ref.slice(0, 60)}; the studio has ${list.map((x) => x.name).join(', ') || 'none'}`);
  return { id: d.id, name: d.name };
}

/** What a task's department holds now, for this project's sessions: { name, found, missing, gone } (null without one). */
export async function departmentSkills(projectPath, department, { configDir } = {}) {
  if (!department) return null;
  const d = findDepartment(await loadDepartments(), department.id) || null;
  if (!d) return { name: department.name || department.id, found: [], missing: [], gone: true };
  const { skills } = await listSkills({ projectPath, ...(configDir ? { configDir } : {}) });
  const found = [];
  const missing = [];
  for (const name of d.skills) {
    const s = skills.find((x) => x.name === name);
    if (s) found.push({ name: s.name, description: s.description });
    else missing.push(name);
  }
  return { id: d.id, name: d.name, found, missing, gone: false };
}
