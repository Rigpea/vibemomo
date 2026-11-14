// The Skills tab (beside Task inspector, Processes and Focus): the Claude Code skills a session in this project can use,
// from the project's .claude/skills, the person's own skills folder and installed plugins (server/lib/skills.mjs),
// filed in the studio's departments (components/skill-departments.js). Each department is a folder that opens and
// closes on a click or Enter, its count on its head; a skill shows in every department that holds it, marked when shared,
// with a box per department on its card. Skills no department holds wait in the Unplaced folder, sorted by the
// department their words suggest, with Place all to confirm a suggestion. A name opens its SKILL.md read-only in a
// dialog; its folder line opens the folder in the system's file manager (POST /api/skills/reveal), as do the places the
// studio looked in. Add skill installs a picked folder or .zip (components/skill-add.js); Departments renames, adds and
// removes them (components/skill-dept-edit.js). A server older than this tab gets a plain restart line.
import { el, clear, button, input, dialog, toast, toastError, loading, errorBox, tag, bytes, icon } from './ui.js';
import { oneLine, sourceWords } from './skill-words.js';
import { groupByDepartment, departmentsOf, filterByWords, unplacedBySuggestion } from './skill-departments.js';
import { openAddSkill } from './skill-add.js';
import { openDepartments } from './skill-dept-edit.js';

const FILTER_KEY = 'atelier.skillsFilter';
const OPEN_KEY = 'atelier.skillsOpen'; // the folders the person left open, by group id
const RESTART_WORDS = 'Restart the studio to load skills: Ctrl+Alt+R.';
const UNPLACED = 'unplaced';

/** An error that means the server predates a skills route ("No route GET /api/skills"). */
export const olderServer = (err) => err?.status === 404 && /^No route /.test(String(err.message || ''));

/** A long folder path as its last three parts, the full path kept for the title. */
export function shortPath(p) {
  const sep = String(p).includes('\\') ? '\\' : '/';
  const parts = String(p).split(sep).filter(Boolean);
  return parts.length > 3 ? `…${sep}${parts.slice(-3).join(sep)}` : String(p);
}

// Before the person opens or closes any folder, Unplaced starts open: on a first visit it is where every skill waits.
const readOpen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || `["sk-dept--${UNPLACED}"]`)); } catch { return new Set(); } };

export function createSkillsPanel(app, { onDepartments } = {}) {
  let data = null; // { projectId, skills, places, departments (null: the server predates departments) } of the last answer
  let error = null;
  let loadingFor = undefined; // the projectId a request is out for
  let seq = 0;
  const open = new Set(); // the department boxes left open, per group and skill, across redraws
  const folders = readOpen(); // the folders open without a filter
  let shut = new Set(); // with a filter every folder with a match opens; these the person closed while filtering
  const count = el('span.tab-count');
  const summary = el('span.sk-count');
  const said = el('p.sk-said', { role: 'status', 'aria-live': 'polite' });
  const addBtn = button('Add skill', { small: true, title: 'Install a skill from a folder holding SKILL.md, or a .zip of one', onclick: () => add() });
  const deptBtn = button('Departments', { small: true, variant: 'quiet', title: 'Rename, add or remove the studio\'s departments (every project shares them)', onclick: () => editDepartments() });
  const filter = input({ type: 'search', placeholder: 'Filter by name, words, department or source', 'aria-label': 'Filter skills', value: sessionStorage.getItem(FILTER_KEY) || '' });
  filter.addEventListener('input', () => { sessionStorage.setItem(FILTER_KEY, filter.value); shut = new Set(); draw(); });
  filter.addEventListener('keydown', (e) => { if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); filter.value = ''; sessionStorage.removeItem(FILTER_KEY); shut = new Set(); draw(); } });
  const intro = el('p.sk-intro', 'Skills sit in departments, and one skill can sit in several. A task given a department tells its worker to use that department\'s skills. Claude Code still loads every installed skill and uses one on its own when the work matches its description, so a department guides the worker; it hides nothing. A skill added now reaches the next session, not one already open.');
  const notice = el('div.sk-notice', { role: 'status', hidden: true });
  const list = el('div.sk-list', { 'aria-busy': 'false' });
  const places = el('details.sk-places');
  const node = el('div.skills-panel', { role: 'region', 'aria-label': 'Skills' },
    el('div.sk-head', el('span.overline', 'Skills'), summary, el('span.spacer'), deptBtn, addBtn), intro, notice, filter, said, list, places);

  const restartLine = (words) => clear(notice, el('p', words), button('Restart the studio', { small: true, onclick: () => app.restart?.() }));
  const filtering = () => !!filter.value.trim();
  const isOpen = (gid) => (filtering() ? !shut.has(gid) : folders.has(gid));

  async function load({ force = false } = {}) {
    const pid = app.state.activeProjectId || null;
    if (!force && ((!error && data?.projectId === pid) || loadingFor === pid)) return; // an error is tried again
    const mine = ++seq;
    loadingFor = pid;
    list.setAttribute('aria-busy', 'true');
    if (!data || data.projectId !== pid) clear(list, loading('Looking for skills…'));
    try {
      const out = await app.api.skills(pid);
      if (mine !== seq) return;
      data = { projectId: pid, skills: out.skills || [], places: out.places || [], departments: Array.isArray(out.departments) ? out.departments : null };
      error = null;
      if (data.departments) onDepartments?.(data.departments);
    } catch (err) {
      if (mine !== seq) return;
      error = err;
    } finally {
      if (mine === seq) { loadingFor = undefined; list.setAttribute('aria-busy', 'false'); }
    }
    draw();
  }

  function draw() {
    const n = data?.skills.length;
    clear(count, n ? String(n) : '');
    notice.hidden = true;
    deptBtn.disabled = !!error || !data?.departments;
    addBtn.disabled = !!error && olderServer(error);
    if (error && olderServer(error)) {
      // The tab's code is newer than the server (the server loads routes only when it starts): say so, offer the restart.
      clear(summary); clear(list); clear(places); notice.hidden = false;
      return restartLine(`This studio server is older than the Skills tab: it has no skills routes yet. ${RESTART_WORDS}`);
    }
    if (error) { clear(summary); return clear(list, errorBox(error, () => load({ force: true }))); }
    if (!data) return;
    if (!data.departments) { notice.hidden = false; restartLine(`This studio server lists skills but keeps no departments yet. ${RESTART_WORDS}`); }
    const depts = data.departments || [];
    const shown = filterByWords(data.skills, depts, filter.value, (s) => sourceWords(s.source).chip);
    clear(summary, !n ? 'none found' : shown.length === n ? `${n} found` : `${shown.length} of ${n} shown`);
    drawPlaces();
    if (!n && !depts.length) return clear(list, el('p.sk-empty', 'No skills found in the places below. Add skill installs one from a folder or a .zip.'));
    if (n && !shown.length) return clear(list, el('p.sk-empty', `No skill matches “${filter.value.trim()}”. Esc clears the filter.`));
    const { groups, unplaced } = groupByDepartment(shown, depts);
    const sections = groups.filter((g) => g.skills.length || !filtering()).map(({ department: d, skills }) =>
      folder(`sk-dept-${d.id}`, d.name, skills.length, () => (skills.length ? cards(skills, d.id) : [el('p.sk-hint', 'None placed here yet: tick this department on a skill\'s card, or confirm a suggestion in Unplaced.')])));
    if (unplaced.length) {
      sections.push(data.departments
        ? folder(`sk-dept--${UNPLACED}`, 'Unplaced', unplaced.length, () => unplacedBody(unplaced, depts), 'unplaced')
        : folder(`sk-dept--${UNPLACED}`, 'All skills', unplaced.length, () => cards(unplaced.map((u) => u.skill), '')));
    }
    if (!n) sections.push(el('p.sk-empty', 'No skills found in the places below. Add skill installs one from a folder or a .zip.'));
    const kept = focusSpot();
    clear(list, ...sections);
    if (kept) refocus(kept);
  }

  /** The Unplaced folder: a line on what a suggestion is, then the skills sorted by suggested department, each with Place all. */
  function unplacedBody(unplaced, depts) {
    return [el('p.sk-hint', 'No department holds these. A suggestion comes from the skill\'s own words and stays one until you confirm it.'),
      ...unplacedBySuggestion(unplaced, depts).map(({ department: d, skills }) => el('div.sk-sub',
        el('div.sk-sub-head', el('h4', d ? `Suggested for ${d.name}` : 'No suggestion', el('span.meta', ` · ${skills.length}`)),
          d ? button(skills.length === 1 ? `Place in ${d.name}` : `Place all ${skills.length} in ${d.name}`, { small: true, variant: 'quiet', title: `Confirm the suggestion: put ${skills.map((s) => s.name).join(', ')} in ${d.name}`, onclick: (e) => place(skills, d, true, e.currentTarget) }) : null),
        cards(skills, '', d)))];
  }

  // A department as a folder: the head is a button (Enter and Space toggle it, as a click does) holding its count; the
  // body is built when it opens, so forty closed cards cost nothing. Toggling does not redraw the list.
  function folder(gid, title, n, body, kind = 'dept') {
    const isUnplaced = kind === 'unplaced';
    const box = el('div.sk-folder-body', { id: `${gid}-body`, role: 'group', 'aria-labelledby': gid });
    const head = el('button.sk-folder-head', { type: 'button', id: gid, 'aria-controls': `${gid}-body`, 'aria-expanded': 'false',
      title: `${title}: ${n} skill${n === 1 ? '' : 's'}. Open or close this folder` },
      el('span.sk-chev', icon('chevron')), el('span.sk-folder-icon', icon('folder')), el('span.sk-folder-name', title), el('span.sk-folder-count', String(n)));
    const section = el(`section.sk-group.sk-folder${isUnplaced ? '.sk-unplaced' : ''}`, { 'aria-labelledby': gid }, el('h3.sk-cat', head), box);
    const set = (on) => {
      head.setAttribute('aria-expanded', String(on));
      section.classList.toggle('open', on);
      box.hidden = !on;
      if (on && !box.firstChild) box.append(...body());
    };
    head.addEventListener('click', () => {
      const on = head.getAttribute('aria-expanded') !== 'true';
      if (filtering()) (on ? shut.delete(gid) : shut.add(gid));
      else { on ? folders.add(gid) : folders.delete(gid); sessionStorage.setItem(OPEN_KEY, JSON.stringify([...folders])); }
      set(on);
    });
    set(isOpen(gid));
    return section;
  }

  const cards = (skills, deptId, suggested = null) => [el('ul.sk-cards', skills.map((s) => el('li', card(s, deptId, suggested))))];

  // Every change redraws the list (and the server's skills.changed redraws it again): the focus goes back to the same
  // control on the same skill's card in the same folder, or to the same folder's head, so a person working by keyboard
  // keeps their place.
  function focusSpot() {
    const a = document.activeElement;
    if (!a || !list.contains(a)) return null;
    if (a.matches('.sk-folder-head')) return { head: a.id };
    const c = a.closest('.sk-card');
    if (!c) return null;
    const boxes = [...c.querySelectorAll('.sk-dept-box input')];
    return { path: c.dataset.path, group: c.closest('section')?.getAttribute('aria-labelledby'), what: a.matches('summary') ? 'summary' : a.matches('.sk-where') ? 'where' : boxes.includes(a) ? boxes.indexOf(a) : 'name' };
  }
  function refocus({ head, path, group, what }) {
    let target = head ? document.getElementById(head) : null;
    if (!head) {
      const cards = [...list.querySelectorAll('.sk-card')].filter((c) => c.dataset.path === path && !c.closest('[hidden]'));
      const c = cards.find((x) => x.closest('section')?.getAttribute('aria-labelledby') === group) || cards[0];
      if (c) {
        const details = c.querySelector('details.sk-depts');
        target = (what === 'summary' ? details?.querySelector('summary') : what === 'where' ? c.querySelector('.sk-where') : typeof what === 'number' && details?.open ? c.querySelectorAll('.sk-dept-box input')[what] : null) || c.querySelector('.sk-name');
      } else target = (group && document.getElementById(group)) || null; // its folder is closed: the folder's head
    }
    if (!target || !list.contains(target)) return;
    // A plain focus() also scrolls the panel's outer boxes, pushing the panel's head out of sight: scroll the list only.
    target.focus({ preventScroll: true });
    const r = target.getBoundingClientRect();
    const p = node.getBoundingClientRect();
    if (r.top < p.top || r.bottom > p.bottom) node.scrollTop += r.top - p.top - p.height / 3;
  }

  /** A skill's card in one folder (deptId '' for Unplaced): its name opens SKILL.md, its folder line opens the folder, its boxes place it. */
  function card(s, deptId, suggested = null) {
    const src = sourceWords(s.source);
    const depts = data.departments || [];
    const holders = departmentsOf(depts, s.name);
    const others = holders.filter((d) => d.id !== deptId);
    const key = `${deptId}|${s.path}`;
    const boxes = depts.length ? el('details.sk-depts', { open: open.has(key), ontoggle: (e) => (e.currentTarget.open ? open.add(key) : open.delete(key)) },
      el('summary', holders.length ? `Departments · ${holders.length}` : 'Departments'),
      el('fieldset.sk-dept-boxes', el('legend.sr-only', `Departments of ${s.name}`),
        depts.map((d) => el('label.sk-dept-box', el('input', { type: 'checkbox', checked: holders.includes(d), onchange: (e) => place([s], d, e.currentTarget.checked, e.currentTarget) }), d.name)))) : null;
    return el('div.sk-card', { 'data-path': s.path, 'data-skill': s.name },
      el('span.sk-card-top', el('button.sk-name', { type: 'button', title: `Open ${s.name}'s SKILL.md (read-only)`, onclick: () => openFile(s) }, s.name), tag(src.chip, null, `From ${src.where}`)),
      el('span.sk-desc', s.description ? oneLine(s.description) : 'No description: Claude has nothing to match the work against.'),
      s.problem ? el('span.sk-problem', s.problem) : null,
      whereButton(s.path, `Open ${s.name}'s folder in the file manager: ${s.path}`),
      others.length ? el('span.sk-shared', { title: `${s.name} sits in ${holders.map((d) => d.name).join(', ')}` }, `Shared · also in ${others.map((d) => d.name).join(', ')}`) : null,
      !holders.length && suggested ? el('span.sk-suggest', button(`Place in ${suggested.name}`, { small: true, variant: 'quiet', title: `Confirm the suggestion: put ${s.name} in ${suggested.name}`, onclick: (e) => place([s], suggested, true, e.currentTarget) })) : null,
      boxes);
  }

  /** A folder path as a button that opens it in the system's file manager. */
  function whereButton(folderPath, title, words = shortPath(folderPath)) {
    return el('button.sk-where', { type: 'button', title, onclick: () => reveal(folderPath) }, icon('folder'), el('span', words));
  }

  async function reveal(folderPath) {
    try {
      const out = await app.api.revealSkillFolder(data?.projectId || null, folderPath);
      toast(`Opened ${out.opened} in the file manager.`);
    } catch (err) {
      toastError(err, olderServer(err) ? `This studio server cannot open folders yet. ${RESTART_WORDS}` : 'Could not open the folder');
    }
  }

  /** Put skills in a department, or take them out. A box keeps the focus on its card; Place … sends it to the next card. */
  async function place(skills, d, member, control) {
    const names = skills.map((s) => s.name);
    let spot = control?.matches('input') ? focusSpot() : null;
    if (control && !spot) {
      // A confirmed suggestion: the cards leave Unplaced, so the focus goes to the card after them there, else Unplaced's head.
      const all = [...list.querySelectorAll(`section.sk-unplaced .sk-card`)];
      const next = all.slice(all.indexOf(control.closest('.sk-card')) + 1).find((c) => !names.includes(c.dataset.skill)) || all.find((c) => !names.includes(c.dataset.skill));
      spot = next ? { path: next.dataset.path, group: `sk-dept--${UNPLACED}`, what: 'name' } : { head: `sk-dept-${d.id}` };
    }
    if (control) control.disabled = true;
    try {
      const out = await app.api.skillDepartments(names.length === 1 ? { action: 'place', id: d.id, skill: names[0], member } : { action: 'place', id: d.id, skills: names, member });
      data.departments = out.departments;
      onDepartments?.(data.departments);
      const who = names.length === 1 ? names[0] : `${names.length} skills`;
      clear(said, member ? `${who} ${names.length === 1 ? 'is' : 'are'} now in ${d.name}.` : `${who} left ${d.name}.`);
    } catch (err) {
      if (olderServer(err)) { data.departments = null; } else toastError(err, `Could not ${member ? 'place' : 'take'} ${names.join(', ')} ${member ? 'in' : 'out of'} ${d.name}`);
    }
    draw();
    if (spot) refocus(spot);
  }

  function drawPlaces() {
    const list2 = data?.places || [];
    clear(places, el('summary', `Where the studio looked · ${list2.length} place${list2.length === 1 ? '' : 's'}`),
      el('ul', list2.map((p) => el('li', el('span.meta', sourceWords(p).chip), ' ',
        p.exists === false ? el('span', el('code', p.path), el('span.meta', ' · not there yet')) : whereButton(p.path, `Open ${p.path} in the file manager`, p.path)))));
  }

  async function openFile(s) {
    const src = sourceWords(s.source);
    const body = el('div.sk-file', loading('Reading SKILL.md…'));
    dialog({ title: s.name, wide: true, body, actions: [{ label: 'Close', value: false }] });
    const holders = departmentsOf(data?.departments || [], s.name).map((d) => d.name);
    try {
      const out = await app.api.skillFile(data?.projectId || null, s.path);
      clear(body,
        el('p.sk-file-where', 'Lives in ', whereButton(out.skill.path, `Open ${out.skill.path} in the file manager`, out.skill.path), ` (${src.where}).`),
        el('p.sk-file-use', 'Claude uses it on its own when the work matches this description: ', el('em', s.description || 'none written.')),
        el('p.meta', `${holders.length ? `Departments: ${holders.join(', ')}` : 'In no department yet'} · folder holds ${out.files.join(', ')} · SKILL.md ${bytes(out.bytes)}${out.truncated ? ', the first 400 KB shown' : ''} · read-only here`),
        s.problem ? el('p.sk-problem', s.problem) : null,
        el('pre.sk-text', { tabindex: 0, 'aria-label': `${s.name} SKILL.md, read-only` }, out.content));
    } catch (err) {
      clear(body, errorBox(err));
    }
  }

  async function add() {
    try {
      const out = await openAddSkill(app, { projectName: app.state.bundle?.project?.name || null });
      if (out?.installed) await load({ force: true });
    } catch (err) {
      toastError(err, 'Could not add the skill');
    }
  }

  async function editDepartments() {
    if (!data?.departments) return;
    await openDepartments(app, { departments: data.departments, olderServer, onChange: (next) => { data.departments = next; onDepartments?.(next); draw(); } });
  }

  function render() {
    if (data?.projectId !== (app.state.activeProjectId || null)) load();
    else if (!node.hidden) draw();
  }

  app.on?.('skills', () => load({ force: true }));
  app.on?.('project-switch', () => load());
  return { node, count, render, load, departments: () => data?.departments || null, focus: () => requestAnimationFrame(() => filter.focus()) };
}
