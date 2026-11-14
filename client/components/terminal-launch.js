// The Start Claude Code dialog of a terminal pane (client/components/terminal.js): composes a claude command line and
// hands it to the pane to type into its active shell. Nothing here runs anything; the pane only types.
import { el, clear, select, dialog, field, input, shortLabel } from './ui.js';

const MODELS = [['', 'default (your Claude Code setting)'], ['claude-fable-5-2', 'claude-fable-5-2'], ['claude-fable-5-1', 'claude-fable-5-1'], ['claude-opus-5-5', 'claude-opus-5-5']];
const PERMS = [['', 'default (ask as usual)'], ['plan', 'plan: read only'], ['acceptEdits', 'acceptEdits: may edit files'], ['bypassPermissions', 'bypassPermissions: runs anything']];
const SESSIONS = [['new', 'New session'], ['continue', 'Continue the most recent (--continue)'], ['resume', 'Pick one to resume (--resume opens Claude Code\'s picker)']];
const LAUNCH_KEY = 'atelier.terminalLauncher';
/** Tasks a Claude Code session can start on: the ones still waiting for, or in, work. */
const STARTABLE = ['ready', 'working', 'needs-input'];

function loadChoices() { try { return { model: '', perm: '', session: 'new', dirs: '', flags: '', enter: true, ...JSON.parse(sessionStorage.getItem(LAUNCH_KEY) || '{}') }; } catch { return { model: '', perm: '', session: 'new', dirs: '', flags: '', enter: true }; } }
const quote = (s) => (/[\s"'&|<>^`$;()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
export function composeClaude({ model, perm, session, dirs, flags, task }) {
  const parts = ['claude'];
  if (model) parts.push('--model', model);
  if (perm) parts.push('--permission-mode', perm);
  if (session === 'continue') parts.push('--continue');
  else if (session === 'resume') parts.push('--resume');
  const ds = String(dirs || '').split(',').map((d) => d.trim()).filter(Boolean);
  if (ds.length) parts.push('--add-dir', ...ds.map(quote));
  if (String(flags || '').trim()) parts.push(String(flags).trim());
  if (task) parts.push(`"Work on studio task ${task}: read .studio/tasks/${task}/brief.md and follow it"`);
  return parts.join(' ');
}

/**
 * Open the dialog. term: the pane's active terminal (or null); folderName(t): its folder's name; newLabel: the pane's
 * word for opening a shell; typeLine(text, { enter }) → true when typed; focus(): back to the pane's xterm.
 */
export function openLauncher({ app, term: t, folderName, newLabel, typeLine, focus }) {
  const c = loadChoices();
  const model = select(MODELS, c.model);
  const perm = select(PERMS, c.perm);
  const session = select(SESSIONS, c.session);
  const dirs = input({ value: c.dirs, placeholder: 'optional, comma-separated folders' });
  const flags = input({ value: c.flags, placeholder: 'optional, typed as written' });
  const enter = el('input', { type: 'checkbox', checked: c.enter !== false });
  const warn = el('div');
  const preview = el('code.term-preview.mono');
  const where = el('p.meta', t && !t.exited ? `Types the command into terminal "${folderName(t)}" (${t.cwd}).` : `No active terminal: open one first with ${newLabel}.`);
  // Open tasks of the terminal's project (the bundle is the active project's).
  const pid = app.state.bundle?.project?.id;
  const tasks = ((t ? t.projectId : pid) === pid && pid ? app.state.bundle?.tasks || [] : []).filter((x) => STARTABLE.includes(x.status));
  const task = select([['', tasks.length ? 'No task' : 'No open task in this folder'], ...tasks.map((x) => [x.id, `${x.id} · ${shortLabel(x.title, 48)}`])], '', { disabled: !tasks.length });
  const choices = () => ({ model: model.value, perm: perm.value, session: session.value, dirs: dirs.value, flags: flags.value, enter: enter.checked, task: task.value });
  const sync = () => {
    preview.textContent = composeClaude(choices());
    clear(warn, perm.value === 'bypassPermissions' ? el('div.note.warn', 'bypassPermissions lets Claude Code run any command and edit any file in the folder without asking.') : null);
  };
  for (const ctl of [model, perm, session, dirs, flags, enter, task]) { ctl.addEventListener('input', sync); ctl.addEventListener('change', sync); }
  sync();
  dialog({
    title: 'Start Claude Code',
    body: el('div.term-launch', where,
      el('div.fields-2', field('Model', model), field('Permission mode', perm)), warn, field('Session', session),
      field('Start with task', task, 'Adds the prompt that points Claude Code at the task brief.'),
      field('Extra folders (--add-dir)', dirs), field('Extra flags', flags),
      el('label.check', enter, el('span', 'Press Enter after typing (untick to edit the line in the terminal first)')),
      el('div.field', el('label', 'Command'), preview),
      el('p.meta', 'The first time Claude Code runs in a folder it asks whether you trust that folder; answer it in the terminal.')),
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Start', variant: 'primary', run: async (close) => {
        const ch = choices();
        const { task: _t, ...keep } = ch; // the task is chosen per launch, not remembered
        sessionStorage.setItem(LAUNCH_KEY, JSON.stringify(keep));
        if (await typeLine(composeClaude(ch), { enter: ch.enter })) { close(true); focus(); }
      } },
    ],
  });
}
