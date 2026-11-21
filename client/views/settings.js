// Settings: Appearance (the person's look: components/appearance-panel.js) · Layout (scoped layout preferences +
// Undo) · Claude Code sign-in · API key · Console · This machine · Data locations. Each section is a short form under
// an overline.
import { el, clear, button, input, select, field, toast, toastError, loading, errorBox, ago, bytes, confirmDialog } from '../components/ui.js';
import { LAYOUT_KEYS, SCOPES } from '../components/layout.js';
import { mountAppearance } from '../components/appearance-panel.js';

const MODELS = [['claude-haiku-5-5', 'Claude Haiku 5.5 (default, cheapest)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5']];
let v = null;

const sec = (title, id) => el('section.set-sec', { id, 'aria-label': title });

export function mount(host, app) {
  v = { app, undo: [], auth: null, boxes: { look: sec('Appearance', 'appearance'), layout: sec('Layout', 'layout-settings'), login: sec('Connected accounts', 'claude-login'), key: sec('API key'), console: sec('Console', 'console-settings'), devices: sec('Devices', 'devices-settings'), machine: sec('This machine'), info: sec('Data locations') }, offs: [] };
  clear(host, el('div.page', el('div.page-inner.narrow',
    el('div.page-head', el('h1', 'Settings')),
    v.boxes.login, v.boxes.look, v.boxes.layout, v.boxes.key, v.boxes.console, v.boxes.devices, v.boxes.machine, v.boxes.info)));
  const lookBody = el('div');
  clear(v.boxes.look, over('Appearance'), lookBody);
  v.look = mountAppearance(lookBody, app); // built once and updated in place: it listens for itself
  v.offs.push(app.on('studio', () => {
    renderInfo(); renderKey(); renderLayout();
    if (!v.consoleDirty) renderConsole(); // keep unsaved edits
    if (!v.devicesDirty) renderDevices();
  }), app.on('layout', renderLayout), app.on('bundle', renderLayout));
  renderInfo(); renderKey(); renderLayout(); renderConsole(); renderDevices(); renderMachine(); renderLogin(); loadLogin(false);
  const refreshAccounts = () => loadLogin(true);
  window.addEventListener('focus', refreshAccounts);
  v.offs.push(() => window.removeEventListener('focus', refreshAccounts));
}

export function unmount() { v?.look?.unmount(); v?.offs.forEach((off) => off()); v = null; }

const over = (text) => el('h2.overline', text);
const kv = (rows) => el('dl.kv', rows.filter(([, val]) => val !== null && val !== undefined && val !== '').flatMap(([k, val, mono]) => [el('dt', k), el('dd', { class: mono ? 'mono' : '' }, val)]));

// ---------- Layout: layout preferences with scope ----------
const scopeName = (s) => (SCOPES.find(([k]) => k === s) || [s, s])[1].toLowerCase();
function valueControl(key, value) {
  if (LAYOUT_KEYS[key].type === 'number') return input({ type: 'number', value: value ?? '', placeholder: 'default', min: 0, step: 1, 'aria-label': `${LAYOUT_KEYS[key].label} value` });
  if (LAYOUT_KEYS[key].type === 'theme') return select([['dark', 'Dark'], ['light', 'Light']], value, { 'aria-label': `${LAYOUT_KEYS[key].label} value` });
  return select([['true', 'Yes'], ['false', 'No']], String(!!value), { 'aria-label': `${LAYOUT_KEYS[key].label} value` });
}
const parse = (key, raw) => (LAYOUT_KEYS[key].type === 'theme' ? raw : LAYOUT_KEYS[key].type === 'number' ? (String(raw).trim() === '' ? undefined : Number(raw)) : raw === 'true');
const fmt = (x) => (typeof x === 'boolean' ? (x ? 'Yes' : 'No') : x === null || x === undefined ? 'default' : String(x));

function renderLayout() {
  if (!v) return;
  const eff = v.app.layout();
  const hasProject = !!v.app.state.bundle?.project;
  const body = el('tbody', Object.entries(LAYOUT_KEYS).map(([key, meta]) => {
    const val = valueControl(key, eff[key].value);
    const scope = select(SCOPES.filter(([s]) => s !== 'project' || hasProject), 'studio', { 'aria-label': `${meta.label} scope` });
    return el('tr',
      el('td', meta.label, el('div.meta', `${fmt(eff[key].value)} · ${eff[key].scope === 'built-in' ? 'built-in' : scopeName(eff[key].scope)}`)),
      el('td', val), el('td', scope),
      el('td', button('Apply', { small: true, variant: 'quiet', 'aria-label': `Apply ${meta.label.toLowerCase()}`, onclick: () => apply(scope.value, key, parse(key, val.value)) })));
  }));
  const last = v.undo[v.undo.length - 1];
  clear(v.boxes.layout,
    over('Layout'),
    el('p.meta', 'The theme, the panels and their sizes. The most specific scope wins: this session, then this project, then the studio default.'),
    el('table.table', el('thead', el('tr', ['Preference', 'Value', 'Scope', ''].map((h) => el('th', h)))), body),
    el('div.row', { style: { marginTop: '12px' } },
      button(last ? `Undo ${LAYOUT_KEYS[last.key].label.toLowerCase()} (${scopeName(last.scope)})` : 'Undo', { small: true, disabled: !last, title: last ? `Restores the previous ${scopeName(last.scope)} value: ${last.prev === undefined ? 'unset' : fmt(last.prev)}` : 'Nothing to undo yet', onclick: undo })));
}

async function apply(scope, key, value) {
  try {
    const change = await v.app.setLayoutPref(scope, key, value);
    v.undo.push(change);
    toast(`${LAYOUT_KEYS[key].label}: ${fmt(value)} (${scopeName(scope)})`, { tone: 'ok', action: { label: 'Undo', run: undo } });
    renderLayout();
  } catch (err) { toastError(err, 'Layout'); }
}
async function undo() {
  const last = v?.undo.pop();
  if (!last) return;
  try {
    await v.app.setLayoutPref(last.scope, last.key, last.prev);
    toast(`Undone: ${LAYOUT_KEYS[last.key].label} ${scopeName(last.scope)} value restored`, { tone: 'ok', timeout: 2500 });
    renderLayout();
  } catch (err) { v.undo.push(last); toastError(err, 'Undo'); }
}

// Subscription credentials are managed by the official CLIs. Only status appears in Settings.
async function loadLogin(fresh) {
  const me = v;
  if (!me) return;
  const request = me.accountRequest = (me.accountRequest || 0) + 1;
  const results = await Promise.allSettled([me.app.api.consoleAuth(fresh), me.app.api.codexStatus(fresh), me.app.api.accountSignIn()]);
  if (v !== me || request !== me.accountRequest) return;
  [me.auth, me.codexAuth, me.signIn] = results.map(r => r.status === 'fulfilled' ? r.value : null);
  me.accountsChecked = true;
  renderLogin();
}

function accountRow(provider, name, status, installUrl, command) {
  let label = 'Checking account…';
  if (v.accountsChecked) {
    if (!status) label = 'Status unavailable';
    else if (!status.cli) label = 'CLI not installed or not found';
    else if (status.loggedIn === false) label = 'Signed out';
    else if (status.loggedIn !== true) label = 'Sign-in could not be verified';
    else if (provider === 'codex') label = { chatgpt: 'Signed in with ChatGPT', 'api-key': 'Codex is using a saved API key' }[status.login] || 'Signed in · account type unknown';
    else label = { 'claude.ai': 'Signed in with Claude', oauth_token: 'Signed in with OAuth', api_key: 'Claude Code is using an API key', apiKey: 'Claude Code is using an API key', console: 'Signed in to Claude Console' }[status.authMethod] || 'Signed in · account type unconfirmed';
  }
  const title = provider === 'codex' ? 'ChatGPT' : 'Claude Code';
  const link = (text, href) => el('a.btn', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  return el('div', el('h3', name), el('p.login-line', { 'aria-live': 'polite' }, label),
    status?.cli === false ? link('Install ' + (provider === 'codex' ? 'Codex CLI' : 'Claude Code'), installUrl) :
      v.signIn?.origin ? link('Sign in with ' + title, v.signIn.origin + '/' + provider) : null,
    v.accountsChecked && !v.signIn && status?.cli !== false ? el('p.meta', 'In your own terminal, run ', el('code', command), ' and then check accounts.') : null);
}

function renderLogin() {
  if (!v) return;
  clear(v.boxes.login, over('Connected accounts'),
    el('p.meta', 'Use Claude Code for the Companion and workers, or ChatGPT for the Codex tab. Finish sign-in with the provider in your browser.'),
    accountRow('claude', 'Claude Code', v.auth, 'https://code.claude.com/docs/en/quickstart', 'claude auth login --claudeai'),
    accountRow('codex', 'ChatGPT via Codex', v.codexAuth, 'https://developers.openai.com/codex/cli/', 'codex login'),
    el('div.row', button('Check accounts', { variant: 'quiet', onclick: () => loadLogin(true) })),
    v.auth?.studioToken?.saved ? el('div.note', el('p', 'An older version saved a Claude token here. The studio now uses the CLI login.'),
      button('Remove old token', { variant: 'danger', onclick: removeLogin })) : null);
}

async function removeLogin() {
  const me = v;
  const ok = await confirmDialog({ title: 'Remove old Claude token?', message: 'Delete the old token from this studio’s storage. To revoke the token itself, use your Claude account settings.', confirm: 'Remove token', variant: 'danger' });
  if (!ok || v !== me) return;
  try { await me.app.api.removeLegacyClaudeToken(); await loadLogin(true); toast('Old token removed', { tone: 'ok' }); }
  catch (err) { toastError(err, 'Remove token'); }
}

// ---------- API key + utility model ----------
function renderKey() {
  const u = v.app.state.apiUtility || {};
  const source = u.keySource === 'env' ? 'Set by the STUDIO_ANTHROPIC_API_KEY environment variable, which wins over a saved key.' : u.keySource === 'secrets.json' ? 'Saved in ~/.atelier/secrets.json.' : 'No key yet.';
  const key = input({ type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'sk-ant-…' });
  const model = select(MODELS, u.model || 'claude-haiku-5-5');
  clear(v.boxes.key,
    over('API key'),
    el('p.meta', `${source} Used only by the bounded utility runs on the Budget page; the key stays on the server and is never shown again.`),
    el('form', { style: { marginTop: '12px' }, onsubmit: async (e) => {
      e.preventDefault();
      if (!key.value.trim()) return key.focus();
      try { await v.app.api.setApiKey(key.value.trim()); key.value = ''; toast('API key saved to secrets.json', { tone: 'ok' }); v.app.loadStudio(); } catch (err) { toastError(err, 'API key'); }
    } }, field('Studio API key', key),
    el('div.row', button('Save key', { type: 'submit' }),
      u.keySource === 'secrets.json' ? button('Remove saved key', { variant: 'danger', onclick: removeKey }) : null)),
    el('form', { style: { marginTop: '24px' }, onsubmit: async (e) => {
      e.preventDefault();
      try { await v.app.api.patchSettings({ apiUtility: { model: model.value } }); toast(`Utility model: ${model.value}`, { tone: 'ok' }); v.app.loadStudio(); } catch (err) { toastError(err); }
    } }, field('Utility model', model, 'Claude Code sessions choose their own model.'), button('Save model', { type: 'submit' })));
}

async function removeKey() {
  const ok = await confirmDialog({
    title: 'Remove the saved API key?',
    message: 'The key is deleted from ~/.atelier/secrets.json. API utilities stop working until you add a key again; Claude Code sessions are not affected.',
    confirm: 'Remove key', variant: 'danger', cancel: 'Keep it',
  });
  if (!ok || !v) return;
  try { await v.app.api.setApiKey(''); toast('Saved key removed', { tone: 'ok' }); v.app.loadStudio(); } catch (err) { toastError(err); }
}

// ---------- Console (docs/ARCHITECTURE.md section 7) ----------
function renderConsole() {
  const c = v.app.state.settings?.console || {};
  v.consoleDirty = false;
  const dirty = () => { v.consoleDirty = true; };
  const command = input({ value: c.command || '', placeholder: 'e.g. ollama run llama3.2', spellcheck: false, class: 'mono', oninput: dirty });
  const mode = select([['stdin', 'On standard input'], ['arg', 'In place of {prompt} in the command']], c.commandMode || 'stdin', { onchange: dirty });
  const timeout = input({ type: 'number', min: 1000, step: 1000, value: String(c.timeoutMs ?? 600000), oninput: dirty });
  const claudePath = input({ value: c.claudePath || '', placeholder: 'claude', spellcheck: false, class: 'mono', oninput: dirty });
  const codexPath = input({ value: c.codexPath || '', placeholder: 'codex', spellcheck: false, class: 'mono', oninput: dirty });
  const font = input({ value: c.terminalFont || '', placeholder: 'e.g. CaskaydiaCove Nerd Font Mono', spellcheck: false, oninput: dirty });
  const evidence = el('div');
  const details = el('details.more', { style: { marginTop: '24px' } }, el('summary', 'Models that answered in Claude Code on this machine, from its logs'), evidence);
  details.addEventListener('toggle', () => { if (details.open && !evidence.firstChild) loadEvidence(evidence); });
  clear(v.boxes.console,
    over('Console'),
    el('form', { onsubmit: async (e) => {
      e.preventDefault();
      const ms = Number(timeout.value);
      if (!Number.isFinite(ms) || ms < 1000) { toast('Timeout must be at least 1000 ms', { tone: 'warn' }); return timeout.focus(); }
      try {
        await v.app.api.patchSettings({ console: { command: command.value.trim(), commandMode: mode.value, timeoutMs: Math.round(ms), claudePath: claudePath.value.trim(), codexPath: codexPath.value.trim(), terminalFont: font.value.trim() } });
        v.consoleDirty = false;
        toast('Console settings saved', { tone: 'ok' });
        v.app.loadStudio();
      } catch (err) { toastError(err, 'Console settings'); }
    } },
    field('Claude path', claudePath, 'Path to the claude command; empty uses the one on PATH'),
    field('Codex path', codexPath, 'Path to the codex command, for the Workbench\'s Codex tab; empty uses the one on PATH'),
    field('Command', command, 'For the Command backend; leave empty to turn it off.'),
    el('div.fields-2', field('Command mode', mode, 'How the message is passed: on standard input, or in place of {prompt}'), field('Timeout (ms)', timeout, 'Default 600000 (10 min).')),
    field('Terminal font', font, 'Empty uses Cascadia Code, then Consolas; prompt glyphs need a Nerd Font'),
    button('Save console settings', { type: 'submit' })),
    details);
}

async function loadEvidence(box) {
  clear(box, loading('Reading local session logs…'));
  try {
    const ev = await v.app.api.evidence();
    if (!v) return;
    const sessions = ev.sessions || [];
    const totals = ev.totals || sessions.reduce((acc, s) => { for (const [m, n] of Object.entries(s.models || {})) acc[m] = (acc[m] || 0) + n; return acc; }, {});
    clear(box,
      el('p.meta', `Assistant messages per model in the last ${ev.days || 7} days, read from disk; no model is called.`),
      Object.keys(totals).length ? kv(Object.entries(totals).map(([m, n]) => [m, `${n} messages`])) : el('p.meta', ev.note || 'No sessions found.'),
      el('h4', { style: { margin: '12px 0 4px' } }, `Probes · ${ev.probes?.length || 0}`),
      ev.probes?.length ? el('pre.json', JSON.stringify(ev.probes, null, 2)) : el('p.meta', 'No probe results recorded.'),
      sessions.length ? el('table.table', { style: { marginTop: '12px' } }, el('tbody', sessions.slice(0, 15).map((s) => el('tr', el('td.small.mono', { style: { wordBreak: 'break-all' } }, s.file), el('td.small', Object.entries(s.models || {}).map(([m, n]) => `${m} ×${n}`).join(', ') || s.skipped || '—'), el('td.small.muted', bytes(s.bytes)))))) : null,
      button('Read again', { small: true, variant: 'quiet', onclick: () => loadEvidence(box) }));
  } catch (err) { if (v) clear(box, errorBox(err, () => loadEvidence(box))); }
}

// ---------- Devices (docs/ARCHITECTURE.md section 10) ----------
const DEVICE_FIELDS = [
  ['sdkRoot', 'Android SDK folder', 'Holds platform-tools (adb) and emulator; e.g. C:\\Users\\you\\AppData\\Local\\Android\\Sdk'],
  ['javaHome', 'Java folder (JAVA_HOME)', 'The JDK the Gradle build uses'],
  ['nodeRoot', 'Node folder', 'For npx cap sync; empty uses the Node running the studio'],
];
const SOURCE_WORDS = { settings: 'from these settings', project: "from the project's .local/android-tools.json", env: 'from the environment' };

function renderDevices() {
  const a = v.app.state.settings?.devices?.android || {};
  v.devicesDirty = false;
  const dirty = () => { v.devicesDirty = true; };
  const inputs = Object.fromEntries(DEVICE_FIELDS.map(([k]) => [k, input({ value: a[k] || '', spellcheck: false, class: 'mono', maxLength: 400, oninput: dirty })]));
  const found = el('p.meta', 'Looking for adb…');
  clear(v.boxes.devices,
    over('Devices'),
    el('p.meta', 'Folders for the Phone panel. A project\'s own .local/android-tools.json fills any left empty here.'),
    el('form', { style: { marginTop: '12px' }, onsubmit: async (e) => {
      e.preventDefault();
      try {
        await v.app.api.patchSettings({ devices: { android: Object.fromEntries(DEVICE_FIELDS.map(([k]) => [k, inputs[k].value.trim()])) } });
        v.devicesDirty = false;
        toast('Device settings saved', { tone: 'ok' });
        v.app.loadStudio();
        loadToolsFound(found);
      } catch (err) { toastError(err, 'Device settings'); }
    } },
    DEVICE_FIELDS.map(([k, label, hint]) => field(label, inputs[k], hint)),
    found,
    button('Save device settings', { type: 'submit' })));
  loadToolsFound(found);
}

async function loadToolsFound(line) {
  let text;
  try {
    const res = await fetch('/api/settings/devices'); // plain fetch: an older companion answers 404, which is a line here, not a toast
    if (!res.ok) text = res.status === 404 ? 'Not available in this studio yet.' : `Could not ask where adb is (status ${res.status}).`;
    else {
      const { adb } = (await res.json()).android || {};
      text = adb?.found ? `adb found at ${adb.path} (${SOURCE_WORDS[adb.source] || adb.source}).` : adb?.reason || 'adb not found.';
    }
  } catch (err) { text = `Could not ask where adb is: ${err.message}`; }
  if (v && line.isConnected) line.textContent = text;
}

// ---------- This machine ----------
async function renderMachine() {
  const box = v.boxes.machine;
  clear(box, over('This machine'), loading('Reading this machine…'));
  let m = null;
  let note = null;
  try {
    const res = await fetch('/api/machine'); // plain fetch: a 404 here is expected on older companions, not an error toast
    if (res.status === 404) note = 'Not available in this studio yet.';
    else if (!res.ok) note = `Could not read it (status ${res.status}).`;
    else m = await res.json();
  } catch (err) { note = `Could not read it: ${err.message}`; }
  const desk = window.atelierDesktop;
  let specs = null;
  if (desk?.specs) { try { specs = await desk.specs(); } catch { specs = null; } }
  if (!v) return;
  const gpuText = (g) => (typeof g === 'string' ? g : [g.vendor, g.device].filter(Boolean).join(' ') + (g.active ? ' (active)' : ''));
  const gpus = specs?.gpus?.length ? specs.gpus.map(gpuText) : m?.gpus || [];
  const rows = m ? [
    ['Processor', [m.cpu?.model, m.cpu?.cores ? `${m.cpu.cores} cores` : null, m.cpu?.threads ? `${m.cpu.threads} threads` : null].filter(Boolean).join(' · ')],
    ['Memory', typeof m.memoryGb === 'number' ? `${m.memoryGb} GB` : null],
    ['System', [m.os?.name, m.os?.version, m.arch].filter(Boolean).join(' · ')],
    ['Graphics', gpus.length ? gpus.join(', ') : 'not reported'],
    ['Node', m.node],
  ] : gpus.length ? [['Graphics', gpus.join(', ')]] : [];
  if (desk) rows.push(['Desktop app', [desk.version ? `vibeMomo ${desk.version}` : null, desk.electron || specs?.electron ? `Electron ${desk.electron || specs.electron}` : null, desk.chrome ? `Chrome ${desk.chrome}` : null].filter(Boolean).join(' · ')]);
  clear(box, over('This machine'), note ? el('p.meta', note) : null, rows.length ? kv(rows) : null,
    !desk ? el('p.meta', { style: { marginTop: '8px' } }, 'Running in a browser; the desktop app adds the graphics details it reads itself.') : null);
}

// ---------- Data locations ----------
function renderInfo() {
  const s = v.app.state.studio;
  if (!s) return clear(v.boxes.info, over('Data locations'), v.app.state.bootError ? errorBox(v.app.state.bootError) : loading());
  clear(v.boxes.info, over('Data locations'), kv([
    ['Studio folder', s.dir, true], ['Data folder', s.dataDir, true], ['Projects folder', s.projectsDir, true],
    ['Version', `${s.version}${s.gitSha ? ` (${s.gitSha})` : ''}`], ['Server', `127.0.0.1:${s.port} · up since ${ago(s.startedAt)} · ${s.platform}`],
    ['Live updates', v.app.state.sse === 'open' ? 'connected' : v.app.state.sse === 'down' ? 'disconnected (refreshing every 30 s)' : 'connecting'],
  ]));
}
