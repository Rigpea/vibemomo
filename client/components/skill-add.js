// Add skill (the Skills tab's button): pick a folder holding SKILL.md or a .zip of one, let the server check it
// (POST /api/skills/install with dryRun), show where it would go (this project's .claude/skills by default, or the
// person's own skills folder), ask before replacing one of the same name, then install. Nothing is written before
// the person presses Add.
import { el, clear, button, dialog, toast, bytes } from './ui.js';

export const PICK_MAX_FILES = 1000;
export const PICK_MAX_BYTES = 20 * 1024 * 1024;

/** Bytes to base64 without one huge String.fromCharCode call. */
export function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A picked folder (an <input webkitdirectory> FileList) as the install body's files; folders the person would not mean are left out. */
export async function folderBody(fileList) {
  const files = [...fileList].filter((f) => !/(^|\/)(\.git|node_modules)\//.test(f.webkitRelativePath || f.name));
  if (files.length > PICK_MAX_FILES) throw new Error(`That folder holds ${files.length} files; a skill is at most ${PICK_MAX_FILES}`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > PICK_MAX_BYTES) throw new Error(`That folder is ${bytes(total)}; a skill is at most ${bytes(PICK_MAX_BYTES)}`);
  return { files: await Promise.all(files.map(async (f) => ({ path: f.webkitRelativePath || f.name, data: toBase64(new Uint8Array(await f.arrayBuffer())) }))) };
}

export async function zipBody(file) {
  if (file.size > PICK_MAX_BYTES) throw new Error(`That .zip is ${bytes(file.size)}; a skill is at most ${bytes(PICK_MAX_BYTES)}`);
  return { zip: toBase64(new Uint8Array(await file.arrayBuffer())) };
}

/** The words for a destination: this project's folder or the person's. */
export const TARGET_WORDS = {
  project: (name) => `This project${name ? ` (${name})` : ''}: only sessions in this project's folder use it, and it is versioned with the project`,
  user: () => 'Your skills: every project\'s sessions use it',
};

/** Open the dialog; resolves to the install answer, or undefined when the person closes it. */
export function openAddSkill(app, { projectName = null } = {}) {
  const projectId = app.state.activeProjectId || null;
  let picked = null; // the body to send again with the target
  let check = null; // the dryRun answer
  let target = projectId ? 'project' : 'user';
  let busy = false;
  const folderIn = el('input', { type: 'file', webkitdirectory: true, hidden: true, onchange: () => pick(() => folderBody(folderIn.files)) });
  folderIn.setAttribute('webkitdirectory', '');
  const zipIn = el('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => pick(() => zipBody(zipIn.files[0])) });
  const status = el('div.sk-add-status', { role: 'status' });
  const plan = el('div.sk-add-plan');
  const replace = el('input', { type: 'checkbox', id: 'sk-replace', onchange: () => drawPlan() });
  const addBtn = button('Add', { variant: 'primary', disabled: true, onclick: () => install() });
  let closeFn = null;

  const body = (close) => {
    closeFn = close;
    return el('div.sk-add',
      el('p', 'A skill is a folder with a SKILL.md at its top: a few lines of frontmatter with name: and description:, then the instructions. Pick the folder, or a .zip of it.'),
      el('div.sk-add-pick', button('Pick a folder…', { onclick: () => folderIn.click() }), button('Pick a .zip…', { onclick: () => zipIn.click() }), folderIn, zipIn),
      status, plan,
      el('div.dialog-actions', button('Cancel', { variant: 'quiet', onclick: () => close(undefined) }), addBtn));
  };

  async function pick(read) {
    if (busy) return;
    busy = true;
    check = null; picked = null; replace.checked = false;
    clear(plan);
    clear(status, el('span.meta', 'Reading and checking…'));
    addBtn.disabled = true;
    try {
      picked = await read();
      check = await app.api.installSkill({ ...picked, projectId, dryRun: true });
      clear(status);
    } catch (err) {
      picked = null;
      clear(status, el('p.sk-problem', { role: 'alert' }, `Cannot add this: ${err.message}`));
    } finally {
      busy = false;
      folderIn.value = ''; zipIn.value = '';
    }
    drawPlan(); // after busy is cleared, or Add would stay disabled
  }

  function drawPlan() {
    if (!check) return;
    const dest = check.destinations[target];
    const radio = (key) => {
      const d = check.destinations[key];
      if (!d) return null;
      return el('label.sk-target', el('input', { type: 'radio', name: 'sk-target', value: key, checked: target === key, onchange: () => { target = key; replace.checked = false; drawPlan(); } }),
        el('span', el('strong', TARGET_WORDS[key](projectName)), el('code', d.path), d.exists ? el('span.sk-problem', ' A skill of this name is there now.') : null));
    };
    clear(plan,
      el('div.sk-add-found', el('strong', check.name), el('span.meta', ` · ${check.category === 'Other' ? 'its words suggest no department' : `its words suggest ${check.category}`} · ${check.fileCount} file${check.fileCount === 1 ? '' : 's'}, ${bytes(check.bytes)}`), el('p', check.description)),
      el('fieldset.sk-targets', el('legend', 'Where it goes'), radio('project'), radio('user')),
      dest.exists ? el('label.sk-replace', replace, ` Replace the ${check.name} that is in ${dest.path}`) : null,
      el('p.hint', 'New Claude Code sessions use it; a session that is open now sees it from its next session.'));
    addBtn.disabled = busy || (dest.exists && !replace.checked);
    clear(addBtn, el('span', dest.exists ? 'Replace' : target === 'project' ? 'Add to this project' : 'Add to your skills'));
  }

  async function install() {
    if (!check || !picked || busy) return;
    busy = true;
    addBtn.disabled = true;
    try {
      const out = await app.api.installSkill({ ...picked, projectId, target, replace: replace.checked });
      toast(`${out.replaced ? 'Replaced' : 'Added'} ${out.name} in ${out.path}. New sessions use it; open ones from their next session.`, { tone: 'ok', timeout: 6000 });
      closeFn?.(out);
    } catch (err) {
      busy = false;
      clear(status, el('p.sk-problem', { role: 'alert' }, `Not added: ${err.message}`));
      drawPlan();
    }
  }

  const d = dialog({ title: 'Add a skill', body, wide: true }); // two full paths side by side need the room
  d.node.querySelector('.sk-add-pick button')?.focus(); // not the hidden file inputs dialog() would try first
  return d.done;
}
