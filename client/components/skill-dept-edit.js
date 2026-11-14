// The Skills tab's Departments dialog: rename, add and remove the studio's skill departments (studio-wide, every project
// shares them: server/lib/departments.mjs). Each change is one POST /api/skills/departments and the rows redraw from its
// answer. Removing a department that holds skills asks first; the skills stay installed.
import { el, clear, button, input, dialog, confirmDialog } from './ui.js';
import { NAME_MAX } from './skill-departments.js';

/** departments: the list as the tab has it. onChange(list) runs after every kept change. olderServer(err) says whether an error means the server predates the route. */
export function openDepartments(app, { departments, onChange, olderServer }) {
  let list = departments;
  let busy = false;
  const rows = el('ul.sk-dept-rows');
  const status = el('p.sk-dept-status', { role: 'status', 'aria-live': 'polite' });
  const addName = input({ placeholder: 'New department, e.g. Sound', maxLength: NAME_MAX, 'aria-label': 'Name of a new department' });
  const addBtn = button('Add department', { small: true, onclick: () => add() });
  addName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  async function change(op, said) {
    if (busy) return false;
    busy = true;
    rows.setAttribute('aria-busy', 'true');
    try {
      const out = await app.api.skillDepartments(op);
      list = out.departments || list;
      onChange?.(list);
      clear(status, said);
      draw();
      return true;
    } catch (err) {
      clear(status, olderServer?.(err) ? 'This studio server is older than the tab and cannot keep departments yet. Restart the studio to load them: Ctrl+Alt+R.' : err.message);
      status.classList.add('warn');
      return false;
    } finally {
      busy = false;
      rows.setAttribute('aria-busy', 'false');
    }
  }

  function draw() {
    clear(rows, ...list.map((d) => {
      const name = input({ value: d.name, maxLength: NAME_MAX, 'aria-label': `Name of the ${d.name} department` });
      const rename = async () => {
        const v = name.value.trim();
        if (!v || v === d.name) { name.value = d.name; return; }
        if (!(await change({ action: 'rename', id: d.id, name: v }, `${d.name} is now ${v}.`))) name.value = d.name;
      };
      name.addEventListener('change', rename);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } if (e.key === 'Escape' && name.value !== d.name) { e.preventDefault(); e.stopPropagation(); name.value = d.name; } });
      const held = d.skills.length;
      const remove = button('Remove', { small: true, variant: 'quiet', title: `Remove the ${d.name} department${held ? `; its ${held} skill${held === 1 ? '' : 's'} stay installed` : ''}`, onclick: async () => {
        if (held && !(await confirmDialog({ title: `Remove ${d.name}?`, message: `${held} skill${held === 1 ? '' : 's'} leave${held === 1 ? 's' : ''} this department and stay installed; a skill no other department holds goes back to Not placed yet. Tasks that named ${d.name} keep the name, and their workers are told it was removed.`, confirm: 'Remove', variant: 'danger' }))) return;
        await change({ action: 'remove', id: d.id }, `${d.name} removed.`);
        addName.focus();
      } });
      return el('li.sk-dept-row', name, el('span.meta', `${held} skill${held === 1 ? '' : 's'}`), remove);
    }));
    if (!list.length) rows.append(el('li.sk-empty', 'No departments. Add one below.'));
  }

  async function add() {
    const v = addName.value.trim();
    if (!v) { addName.focus(); return; }
    if (await change({ action: 'add', name: v }, `${v} added.`)) { addName.value = ''; addName.focus(); }
  }

  draw();
  return dialog({
    title: 'Departments',
    body: el('div.sk-dept-edit',
      el('p', 'Departments are the studio\'s, shared by every project. A skill can sit in several; tick them on the skill\'s card. A renamed department keeps its skills.'),
      rows,
      el('div.sk-dept-add', addName, addBtn),
      status),
    actions: [{ label: 'Close', value: false }],
  }).done;
}
