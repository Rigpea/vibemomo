// Skills by department (docs/ARCHITECTURE.md section 18): the pure parts shared by the server (server/lib/departments.mjs,
// the worker's first message) and the Skills tab (components/skills-panel.js). Departments are studio-wide, kept in the
// registry's settings as skillDepartments: an ordered list of { id, name, skills: [skill names] }, so one skill can sit
// in several departments (many-to-many). The keyword category of skill-words.js only suggests a department for a skill
// no department holds yet. No DOM, no file access.

/** The departments a studio starts with; the person renames, adds and removes them. */
export const DEFAULT_DEPARTMENTS = [
  { id: 'design', name: 'Design' },
  { id: 'ux', name: 'UX' },
  { id: 'frontend', name: 'Frontend' },
  { id: 'backend', name: 'Backend' },
  { id: 'qa', name: 'QA and review' },
  { id: 'docs', name: 'Docs and writing' },
];

/** The keyword category (skill-words.js CATEGORIES) a starting department answers for, by the department's id. */
export const CATEGORY_DEPARTMENT = { Design: 'design', UX: 'ux', 'Frontend/Code': 'frontend', Backend: 'backend', 'Testing & review': 'qa', 'Docs & writing': 'docs' };

export const NAME_MAX = 40;
export const SKILL_NAME_MAX = 100;

const fault = (code, message) => Object.assign(new Error(message), { code });
const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const same = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

/** The stored value as a clean list; nothing stored yet gives the starting six with no skills. Bad entries are dropped. */
export function normalizeDepartments(raw) {
  if (!Array.isArray(raw)) return DEFAULT_DEPARTMENTS.map((d) => ({ ...d, skills: [] }));
  const out = [];
  for (const d of raw) {
    const id = typeof d?.id === 'string' ? d.id.trim() : '';
    const name = cleanName(d?.name).slice(0, NAME_MAX);
    if (!id || !name || out.some((x) => x.id === id)) continue;
    const skills = [];
    for (const s of Array.isArray(d.skills) ? d.skills : []) {
      const n = cleanName(s).slice(0, SKILL_NAME_MAX);
      if (n && !skills.includes(n)) skills.push(n);
    }
    out.push({ id, name, skills });
  }
  return out;
}

/** A department by its id, else by its name (any case); null when none. */
export function findDepartment(departments, ref) {
  if (ref && typeof ref === 'object') ref = ref.id || ref.name;
  if (typeof ref !== 'string' || !ref.trim()) return null;
  return departments.find((d) => d.id === ref.trim()) || departments.find((d) => same(d.name, ref)) || null;
}

/** The departments that hold a skill name, in the list's order. */
export const departmentsOf = (departments, skillName) => departments.filter((d) => d.skills.includes(skillName));

/** An id for a new department from its name: lowercase words joined by dashes, with -2, -3… when taken. */
export function departmentId(name, departments) {
  const base = cleanName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'department';
  let id = base;
  for (let i = 2; departments.some((d) => d.id === id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * One change to the list, answered as a new list (the old one is not touched). Ops:
 * { action: 'add', name } · { action: 'rename', id, name } · { action: 'remove', id } ·
 * { action: 'place', id, skill | skills: [names], member: true|false }. A refusal throws an Error whose code is invalid_input,
 * not_found or name_taken.
 */
export function applyDepartmentOp(departments, op = {}) {
  const list = normalizeDepartments(departments).map((d) => ({ ...d, skills: [...d.skills] }));
  const byId = () => {
    const d = list.find((x) => x.id === op.id);
    if (!d) throw fault('not_found', `No department with the id ${String(op.id ?? '').slice(0, 60)}`);
    return d;
  };
  const checkName = (name, self = null) => {
    const n = cleanName(name);
    if (!n) throw fault('invalid_input', 'A department needs a name');
    if (n.length > NAME_MAX) throw fault('invalid_input', `A department's name is at most ${NAME_MAX} characters`);
    if (list.some((d) => d !== self && same(d.name, n))) throw fault('name_taken', `There is already a department named ${n}`);
    return n;
  };
  switch (op.action) {
    case 'add': {
      const name = checkName(op.name);
      list.push({ id: departmentId(name, list), name, skills: [] });
      return list;
    }
    case 'rename': {
      const d = byId();
      d.name = checkName(op.name, d);
      return list;
    }
    case 'remove': {
      const d = byId();
      return list.filter((x) => x !== d);
    }
    case 'place': {
      // One skill (skill) or several at once (skills: the Unplaced group's "Place all n" confirming a suggestion).
      const d = byId();
      const given = Array.isArray(op.skills) ? op.skills : [op.skill];
      if (!given.length || given.length > 500) throw fault('invalid_input', 'place needs the skill\'s name, or skills: a list of names');
      const names = given.map(cleanName);
      if (names.some((n) => !n || n.length > SKILL_NAME_MAX)) throw fault('invalid_input', 'place needs the skill\'s name');
      if (typeof op.member !== 'boolean') throw fault('invalid_input', 'place needs member: true or false');
      d.skills = op.member ? [...d.skills, ...names.filter((n, i) => !d.skills.includes(n) && names.indexOf(n) === i)] : d.skills.filter((s) => !names.includes(s));
      return list;
    }
    default:
      throw fault('invalid_input', 'action must be add, rename, remove or place');
  }
}

/**
 * The department a skill no department holds would go to, as a suggestion only: a department named like the skill's
 * own category (its category field, its tags or its keywords, skill-words.js), else the starting department for that
 * category while it still exists. null for Other, or when that department was removed.
 */
export function suggestDepartment(skill, departments) {
  if (!skill?.category || skill.category === 'Other') return null;
  const byName = departments.find((d) => same(d.name, skill.category));
  if (byName) return byName;
  const id = CATEGORY_DEPARTMENT[skill.category];
  return (id && departments.find((d) => d.id === id)) || null;
}

const byName = (a, b) => a.name.localeCompare(b.name) || String(a.path || '').localeCompare(String(b.path || ''));

/**
 * The Skills tab's groups: [{ department, skills }] in the list's order (a skill under every department that holds it,
 * a department with none kept, so it can be seen and filled), then { unplaced: [{ skill, suggested }] }.
 */
export function groupByDepartment(skills, departments) {
  const groups = departments.map((department) => ({ department, skills: skills.filter((s) => department.skills.includes(s.name)).sort(byName) }));
  const unplaced = skills.filter((s) => !departments.some((d) => d.skills.includes(s.name))).sort(byName).map((skill) => ({ skill, suggested: suggestDepartment(skill, departments) }));
  return { groups, unplaced };
}

/**
 * The Unplaced group sorted by its suggestions: [{ department (null: no suggestion), skills }], one entry per suggested
 * department in the list's order, then the skills with none. A suggestion is still only shown, never stored.
 */
export function unplacedBySuggestion(unplaced, departments) {
  const out = departments.map((department) => ({ department, skills: unplaced.filter((u) => u.suggested?.id === department.id).map((u) => u.skill) })).filter((g) => g.skills.length);
  const none = unplaced.filter((u) => !u.suggested || !departments.some((d) => d.id === u.suggested.id)).map((u) => u.skill);
  if (none.length) out.push({ department: null, skills: none });
  return out;
}

/** Skills whose name, description, source, departments or suggested department hold every word of the filter. */
export function filterByWords(skills, departments, query, sourceChip = () => '') {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return skills;
  return skills.filter((s) => {
    const placed = departmentsOf(departments, s.name).map((d) => d.name);
    const hay = `${s.name} ${s.description} ${sourceChip(s)} ${placed.join(' ')} ${placed.length ? '' : suggestDepartment(s, departments)?.name || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The worker's paragraph for a task that carries a department: the department, its skills with their descriptions,
 * and the instruction to use them. found: the department's skills a session in the project can see ({ name,
 * description }); missing: names the department holds that no listed skill has; gone: the department was removed.
 */
export function departmentPrompt({ name, found = [], missing = [], gone = false }) {
  if (gone) return `Department: this task was given the department ${name}, which has since been removed from the studio, so no department skills apply; work as the brief says.`;
  const lines = found.map((s) => `- ${s.name}: ${cut(s.description, 300) || 'no description written.'}`);
  const head = `Department: ${name}. This task belongs to the studio's ${name} department.`;
  const none = found.length ? '' : ` The ${name} department has no skills placed${missing.length ? ' that this project\'s sessions can see' : ' yet'} (Skills tab), so work as the brief says.`;
  const list = found.length ? ` Its skills are:\n${lines.join('\n')}\nUse these skills for this work: when a step matches one, invoke it with the Skill tool. Every installed skill stays available; these are the ones the ${name} department works with.` : '';
  const gap = missing.length ? `${found.length ? '\n' : ' '}Placed in ${name} but not installed where this project's sessions can see them: ${missing.join(', ')}.` : '';
  return `${head}${none}${list}${gap}`;
}
