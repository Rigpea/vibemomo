// By-eye and by-DOM check of the Codex dock tab (workbenches/codex/panel.js): a private studio (temp data, own port
// and pid file), a temp web project imported into it, the real client in an offscreen Electron window at laptop width
// (1280 x 720).
// Default: Settings › Console › Codex path set to tests/fixtures/fake-codex.mjs and CODEX_HOME to a temp folder with a
// config.toml and a models_cache.json, so nothing here is a real codex. Checks: Codex is the second tab; the head names
// the brain, the model and the login; the defaults are config.toml's and read-only; Start makes a codex session with
// the studio tools; a message is answered with its command in the thread and the trajectory; a second message resumes
// the thread; a reload shows the stored session; workspace-write is chosen and marked; a refused model, signed out and
// no CLI each read as their one sentence; the head fits at 1280 px; a narrow window stacks the trajectory.
// --real: the person's own codex CLI and ~/.codex (read only: its config.toml is hashed before and after). Two short
// turns at low effort on their login: a command, a write the read-only sandbox must stop, a studio tool, a reload.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-codex.cjs [--real]  (writes .local/verify-codex/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = process.argv.includes('--real');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', REAL ? 'verify-codex-real' : 'verify-codex');
const PORT = REAL ? 4913 : 4912;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-codex-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
const codexHome = path.join(tmp, 'codex-home');
const loginFile = path.join(tmp, 'fake-login.txt');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const FAKE_CODEX = path.join(ROOT, 'tests', 'fixtures', 'fake-codex.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs');
const REAL_CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const hashOf = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

let server = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, REAL ? 600000 : 180000);

app.disableHardwareAcceleration();

async function main() {
  const configBefore = REAL ? hashOf(REAL_CONFIG) : null;
  const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: FAKE_CLAUDE };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ATELIER_CODEX_BIN;
  if (!REAL) {
    Object.assign(env, { CODEX_HOME: codexHome, FAKE_CODEX_LOGIN_FILE: loginFile, OPENAI_API_KEY: 'sk-must-not-reach-codex' });
    fs.writeFileSync(loginFile, 'chatgpt');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-a"\nmodel_reasoning_effort = "high"\n\n[tui]\ntheme = "dark"\n');
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-a', display_name: 'GPT-A', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
      { slug: 'gpt-b', display_name: 'GPT-B', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
      { slug: 'gpt-refused', display_name: 'GPT-Refused', visibility: 'list', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    ] }));
  }
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  if (!REAL) await api('PATCH', '/api/settings', { console: { codexPath: FAKE_CODEX } });

  const folder = path.join(projectsDir, 'codex-probe');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'atelier.json'), JSON.stringify({ name: 'Codex Probe', kind: 'web-app', entry: 'src/index.html' }, null, 2));
  fs.writeFileSync(path.join(folder, 'src', 'index.html'), '<!doctype html>\n<title>Codex Probe</title>\n<h1 id="title">A page to ask about</h1>\n<script type="module" src="app.js"></script>\n');
  fs.writeFileSync(path.join(folder, 'src', 'app.js'), 'document.getElementById("title").dataset.ready = "1";\n');
  const imported = await api('POST', '/api/projects/import', { path: folder });
  const pid = imported.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const ui = async () => (await api('GET', `/api/projects/${pid}`)).project.ui || {};
  const record = async (sid) => api('GET', `/api/console/sessions/${sid}`);

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  win.setContentSize(1280, 720);
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code, true), new Promise((_, rej) => setTimeout(() => rej(new Error(`page script did not answer in 20 s: ${String(code).replace(/\s+/g, ' ').slice(0, 160)}`)), 20000))]);
  // Two frames before the capture: an offscreen window can hand back the frame from before the last redraw.
  const shot = async (name) => { await sleep(500); try { await Promise.race([win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true), sleep(1500)]); win.webContents.invalidate(); await sleep(300); const img = await Promise.race([win.webContents.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 10000))]); fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(85)); } catch (err) { results.push({ name: `shot ${name}`, ok: true, seen: String(err.message) }); } };
  const until = (expr, ms = 10000) => js(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 100)}; i++) { try { const v = (${expr}); if (v) return (typeof v === 'object' && v.nodeType) || typeof v === 'function' ? true : v; } catch {} await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  const clickTab = (name) => js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}))?.click()`);
  // Everything below is read inside the Codex panel's own host: the Companion's panel uses the same class names.
  const q = (sel) => `document.querySelector('.codex-host ${sel}')`;
  const text = (sel) => js(`${q(sel)}?.textContent.trim() || ''`);
  const choices = () => js(`[...document.querySelectorAll('.codex-host .cmp-choices select')].map((s) => ({ value: s.value, label: s.selectedOptions[0]?.textContent, write: s.classList.contains('cdx-write'), disabled: s.disabled }))`);
  const choose = (i, value) => js(`(() => { const s = document.querySelectorAll('.codex-host .cmp-choices select')[${i}]; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const say = (words) => js(`(() => { const ta = ${q('.cmp-composer textarea')}; ta.value = ${JSON.stringify(words)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  const stateIs = (re, ms) => until(`${re}.test(${q('.cmp-state')}?.textContent.trim() || '')`, ms);
  // A real reload: loadURL with the same address and hash is a same-document navigation, which reloads nothing.
  const reload = async () => { const loaded = new Promise((r) => win.webContents.once('did-finish-load', r)); win.webContents.reloadIgnoringCache(); await loaded; await sleep(1500); };
  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(2500);
  check('the window is 1280 px wide (laptop width)', (await js('window.innerWidth')) === 1280, await js('[window.innerWidth, window.innerHeight]'));

  // ---------- the tab and the head ----------
  const tabs = await js(`[...document.querySelectorAll('.dock-tabs [role="tab"]')].map((t) => t.textContent.trim())`);
  check('Codex is the second band tab, right after Claude Code', tabs[0] === 'Claude Code' && tabs[1] === 'Codex', tabs);
  await clickTab('Codex');
  await until(`${q('.cmp-choices select')} && !${q('.cmp-choices select')}.disabled`);
  const status = await api('GET', '/api/console/codex');
  const head = await text('.cmp-brain');
  const first = await choices();
  if (REAL) {
    check('the real CLI is found and signed in with ChatGPT', status.cli === true && status.loggedIn === true && status.login === 'chatgpt', { cli: status.cli, version: status.version, loggedIn: status.loggedIn, login: status.login, source: status.source, defaults: status.defaults, models: status.models.map((m) => m.id) });
    const name = status.models.find((m) => m.id === status.defaults.model)?.name || status.defaults.model;
    check('the head names Codex, config.toml\'s model and the ChatGPT login', head === `Codex · ${name} · your ChatGPT login`, head);
    check('the defaults are config.toml\'s model and effort and the read-only sandbox', first[0]?.value === status.defaults.model && first[1]?.value === (status.defaults.effort || '') && first[2]?.value === 'read-only', first);
    check('the models come from Codex\'s own list', status.source === 'models_cache.json', status.source);
  } else {
    check('the head names the brain, the model and the login', head === 'Codex · GPT-A · your ChatGPT login', head);
    check('the defaults are config.toml\'s model and effort and the read-only sandbox, in words', first[0]?.value === 'gpt-a' && first[1]?.value === 'high' && first[2]?.value === 'read-only' && first[2]?.label === 'Sandbox: read-only' && !first[2].write, first);
  }
  check('with no session: Idle · no session yet and a Start button', !!(await stateIs('/^Idle · no session yet$/')) && (await js(`[...document.querySelectorAll('.codex-host .cmp-start button')].some((b) => b.textContent.trim() === 'Start' && !b.disabled)`)), await text('.cmp-state'));
  const fits = () => js(`(() => { const h = ${q('.cmp-head')}; const b = ${q('.cmp-brain')}; return { head: h.clientWidth, scroll: h.scrollWidth, brain: Math.round(b.getBoundingClientRect().width), cut: b.scrollWidth > b.clientWidth }; })()`);
  const fit0 = await fits();
  check('at 1280 px the head holds the line and the three choices without cutting the line', fit0.scroll <= fit0.head && !fit0.cut, fit0);
  const startBox = await js(`(() => { const b = [...document.querySelectorAll('.codex-host .cmp-start button')].find((x) => x.textContent.trim() === 'Start').getBoundingClientRect(); const l = ${q('.cmp-log')}.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), logTop: Math.round(l.top), logBottom: Math.round(l.bottom) }; })()`);
  check('at 1280 x 720 the Start button shows whole in the dock at its default height', startBox.top >= startBox.logTop && startBox.bottom <= startBox.logBottom, startBox);
  await shot('a-codex-empty');
  if (REAL) await choose(1, 'low'); // the cheapest effort for the two real turns, chosen the way a person would
  await sleep(400);

  // ---------- Start and a message ----------
  await js(`[...document.querySelectorAll('.codex-host .cmp-start button')].find((b) => b.textContent.trim() === 'Start').click()`);
  const sid = await (async () => { for (let i = 0; i < 50; i++) { const id = (await ui()).codexSessionId; if (id) return id; await sleep(200); } return null; })();
  let rec = sid ? await record(sid) : null;
  check('Start makes a codex session, read-only, with the studio tools, and remembers its id', rec && rec.backend === 'codex' && rec.sandbox === 'read-only' && rec.tools === 'studio' && rec.title === 'Codex · Codex Probe' && rec.model === (REAL ? status.defaults.model : 'gpt-a') && rec.effort === (REAL ? 'low' : 'high'),
    rec && { backend: rec.backend, sandbox: rec.sandbox, tools: rec.tools, title: rec.title, model: rec.model, effort: rec.effort });
  await until(`!!${q('.cmp-composer textarea')}`);

  if (REAL) {
    await say('Run the command: git status --short. Then try to create a file named codex-write-probe.txt in this folder with a shell command. Answer in two short sentences: how many lines git printed, and whether the file could be created.');
    check('the run shows as Working while Codex answers', !!(await stateIs('/^Working · /', 20000)), await text('.cmp-state'));
    await shot('b-real-working');
    await stateIs('/^(Done|Needs you|Failed|Model refused|Signed out) · /', 300000);
    const done = await text('.cmp-state'); // the words: until() answers true for a test that held
    rec = await record(sid);
    const t1 = rec.turns.at(-1);
    check('the real codex CLI answered in the thread', /^(Done|Needs you)/.test(done || '') && t1.role === 'assistant' && t1.backend === 'codex' && !t1.isError && t1.text.length > 0 && (await text('.cmp-log')).includes(t1.text.slice(0, 40)), { state: done, error: t1.error, text: t1.text, model: t1.model, effort: t1.effort, sandbox: t1.sandbox, login: t1.login, usage: t1.usage, durationMs: t1.durationMs });
    const cmds = t1.events.filter((e) => e.kind === 'tool').map((e) => `${e.name} ${e.summary}`);
    check('its commands are events of the turn, the git status among them', cmds.some((c) => /^Shell .*git status --short/.test(c)), { cmds, results: t1.events.filter((e) => e.kind === 'tool-result' || e.kind === 'denied').map((e) => `${e.kind} ${e.ok} ${String(e.summary).slice(0, 80)}`) });
    const traj = await js(`[...document.querySelectorAll('.codex-host .cmp-traj-rows .turn-events > div')].map((d) => d.textContent.trim().slice(0, 120))`);
    check('the trajectory shows the command as time · Run · command', traj.some((t) => /^\d\d:\d\d · Run · .*git status --short/.test(t)), traj);
    check('the read-only sandbox held: the file Codex was asked to create is not there', !fs.existsSync(path.join(folder, 'codex-write-probe.txt')), fs.readdirSync(folder));
    check('the turn names the model, the sandbox and the ChatGPT login', t1.sandbox === 'read-only' && t1.login === 'chatgpt' && t1.model === status.defaults.model, { model: t1.model, sandbox: t1.sandbox, login: t1.login });
    const meta = await js(`[...document.querySelectorAll('.codex-host .cmp-log .turn-meta')].map((m) => m.textContent.trim()).at(-1)`);
    check('the meta line says who ran it: the model, read-only, on your ChatGPT login', /sandbox read-only/.test(meta || '') && /on your ChatGPT login/.test(meta || ''), meta);
    const thread1 = rec.codexThreadId;
    await shot('c-real-answered');

    await say('Call the atelier_read_briefing tool of the atelier MCP server and tell me in one sentence the project name it reports. Then, in a second sentence, repeat the exact git command you ran in your previous turn.');
    await stateIs('/^Working · /', 20000);
    await stateIs('/^(Done|Needs you|Failed|Model refused|Signed out) · /', 300000);
    const done2 = await text('.cmp-state');
    rec = await record(sid);
    const t2 = rec.turns.at(-1);
    check('a second message continues the same Codex thread (exec resume): the thread id is unchanged and Codex recalls its earlier command', !!thread1 && rec.codexThreadId === thread1 && /^(Done|Needs you)/.test(done2 || '') && /git status/.test(t2.text), { thread1, thread2: rec.codexThreadId, state: done2, text: t2.text, error: t2.error });
    const tool = t2.events.find((e) => e.kind === 'tool' && e.name === 'mcp__atelier__atelier_read_briefing');
    const toolResult = t2.events.find((e) => e.kind === 'tool-result' && e.name === 'mcp__atelier__atelier_read_briefing');
    check('the atelier MCP tools are reachable from the Codex session: atelier_read_briefing ran and answered with the project', !!tool && toolResult?.ok === true && /Codex Probe/.test(toolResult.summary + toolResult.detail) && /Codex Probe/.test(t2.text), { tool, result: toolResult && { ok: toolResult.ok, summary: toolResult.summary }, denied: t2.events.filter((e) => e.kind === 'denied') });
    await shot('d-real-second');
  } else {
    await say('Is the tree clean? TOOLS');
    await stateIs('/^Done · /', 20000);
    const thread = await text('.cmp-log');
    check('the fake codex answers in the thread, with its role and the studio context ahead of the first message', /echo: You are answering in the Codex tab/.test(thread) && /Your sandbox is read-only/.test(thread) && /Web entry: src\/index\.html/.test(thread) && /Is the tree clean\?/.test(thread), thread.slice(0, 1400));
    const traj = await js(`[...document.querySelectorAll('.codex-host .cmp-traj-rows .turn-events > div')].map((d) => d.textContent.trim())`);
    check('the trajectory shows the command as time · Run · command with its result, and the studio tool', traj.some((t) => /^\d\d:\d\d · Run · git status --short$/.test(t)) && traj.some((t) => /M index\.html/.test(t)) && traj.some((t) => /^\d\d:\d\d · Briefing$/.test(t)), traj);
    check('a call Codex was refused shows as denied', traj.some((t) => /^denied: .*write thing/i.test(t) || /^denied:/.test(t)), traj);
    check('the state line reads Done · when', /^Done · (just now|\d+ min ago)$/.test(await text('.cmp-state')), await text('.cmp-state'));
    rec = await record(sid);
    const t1 = rec.turns.at(-1);
    check('the child had no OPENAI_API_KEY and the argv says read-only', t1.events.some((e) => e.kind === 'status' && /^env OPENAI_API_KEY=absent /.test(e.summary)) && t1.events.some((e) => e.kind === 'status' && /^argv .*sandbox_mode=\\"read-only\\"/.test(e.summary)), t1.events.filter((e) => e.kind === 'status').map((e) => e.summary));
    const meta = await js(`[...document.querySelectorAll('.codex-host .cmp-log .turn-meta')].map((m) => m.textContent.trim()).at(-1)`);
    check('the meta line names the model, the effort, the sandbox and the login', /gpt-a, high effort, sandbox read-only/.test(meta || '') && /on your ChatGPT login/.test(meta || ''), meta);
    await shot('b-answered');
    const thread1 = rec.codexThreadId;
    await say('And now?');
    await until(`/resumed ${thread1}/.test(${q('.cmp-log')}.textContent) && /^Done · /.test(${q('.cmp-state')}.textContent.trim())`, 20000);
    rec = await record(sid);
    check('a second message resumes the same thread (exec resume <thread id>)', rec.codexThreadId === thread1 && new RegExp(`resumed ${thread1}\\. echo: And now\\?`).test(rec.turns.at(-1).text), rec.turns.at(-1).text);
  }

  // ---------- a fresh load shows the stored session, never Start ----------
  const before = (await record(sid)).turns.length;
  await js('window.__beforeReload = true');
  await reload();
  check('the page really reloaded', (await js('window.__beforeReload === undefined')) === true, null);
  const sel = await until(`document.querySelector('.dock-tabs [role="tab"][aria-selected="true"]')?.textContent.trim()`);
  check('after a reload the dock opens on Codex again', String(sel).startsWith('Codex'), sel);
  const reread = await until(`${q('.cmp-log .turn')} && /^(Done|Needs you) · /.test(${q('.cmp-state')}?.textContent.trim() || '')`, 15000);
  const turnsShown = await js(`document.querySelectorAll('.codex-host .cmp-log .turn').length`);
  check('after a reload the tab shows the stored session with its thread, not Start', !!reread && turnsShown === before && (await ui()).codexSessionId === sid && !(await js(`!!document.querySelector('.codex-host .cmp-start')`)), { turnsShown, before, stored: (await ui()).codexSessionId });

  if (REAL) {
    const configAfter = hashOf(REAL_CONFIG);
    check('~/.codex/config.toml is byte for byte what it was before the run', !!configBefore && configBefore === configAfter, { before: configBefore?.slice(0, 12), after: configAfter?.slice(0, 12) });
    await shot('e-real-reloaded');
    return;
  }

  // ---------- the sandbox choice ----------
  await choose(2, 'workspace-write');
  await until(`${q('.cmp-choices select.cdx-write')}`);
  const afterWrite = await choices();
  check('workspace-write is set on the session and the choice reads it in words, in the state colour', (await record(sid)).sandbox === 'workspace-write' && afterWrite[2].value === 'workspace-write' && afterWrite[2].label === 'Sandbox: may edit files' && afterWrite[2].write, afterWrite);
  await shot('c-workspace-write');
  await say('Third');
  await until(`/echo: \\[Studio: the person changed the sandbox/.test(${q('.cmp-log')}.textContent) && /^Done · /.test(${q('.cmp-state')}.textContent.trim())`, 20000);
  rec = await record(sid);
  check('the next run has the workspace-write sandbox and Codex is told once', rec.turns.at(-1).sandbox === 'workspace-write' && rec.turns.at(-1).events.some((e) => e.kind === 'status' && /sandbox_mode=\\"workspace-write\\"/.test(e.summary)), rec.turns.at(-1).events.filter((e) => e.kind === 'status').map((e) => e.summary));
  await choose(2, 'read-only');
  await sleep(600);

  // ---------- a refused model ----------
  await choose(0, 'gpt-refused');
  await until(`/GPT-Refused/.test(${q('.cmp-brain')}.textContent)`);
  await say('Hello');
  const refusedState = await stateIs('/^Model refused · /', 20000);
  const refusedNote = await js(`[...document.querySelectorAll('.codex-host .cmp-log .note.danger')].map((n) => n.textContent.trim()).at(-1)`);
  check('a refused model reads Model refused, and the thread says in one sentence what to do', !!refusedState && /^Codex refused the model gpt-refused: choose another model in the tab and send the message again\./.test(refusedNote || '') && (await record(sid)).model === 'gpt-refused', { refusedState, refusedNote });
  await shot('d-model-refused');
  await choose(0, 'gpt-a');
  await sleep(600);

  // ---------- signed out ----------
  // The login goes while the studio still holds a minute-old "signed in": the run itself finds out and says so.
  fs.writeFileSync(loginFile, 'out');
  await say('Are you there?');
  const outNote = await until(`${q('.cdx-problem .note')}?.textContent.trim()`, 20000);
  rec = await record(sid);
  const outTurn = rec.turns.at(-1);
  const threadNote = await js(`[...document.querySelectorAll('.codex-host .cmp-log .signed-out')].map((n) => n.textContent.trim()).at(-1)`);
  check('a run that finds no login: a signed-out turn whose one sentence says what to do, the same under the thread, in the head and the state', outTurn.signedOut === true && /^Codex is signed out on this machine: run `codex login` in a terminal, then send the message again\./.test(threadNote || '') && /^Codex is signed out on this machine/.test(outNote || '') && !!(await stateIs('/^Signed out · /')) && /signed out$/.test(await text('.cmp-brain')),
    { outNote, threadNote, state: await text('.cmp-state'), head: await text('.cmp-brain'), turn: { signedOut: outTurn.signedOut, error: outTurn.error } });
  // Now the studio knows: the next message is refused before anything is recorded, and the words go back in the box.
  const turnsBefore = rec.turns.length;
  await say('Still there?');
  await sleep(1500);
  check('while signed out a message is refused before it is recorded, and its words are back in the box', (await record(sid)).turns.length === turnsBefore && (await js(`${q('.cmp-composer textarea')}.value`)) === 'Still there?', { turns: (await record(sid)).turns.length, turnsBefore, box: await js(`${q('.cmp-composer textarea')}.value`) });
  await shot('e-signed-out');
  fs.writeFileSync(loginFile, 'chatgpt');
  await js(`[...document.querySelectorAll('.codex-host .cdx-problem button')].find((b) => b.textContent.trim() === 'Check again').click()`);
  check('Check again after signing in clears the note; the state reads the lost message as one to send again', !!(await until(`${q('.cdx-problem')}.hidden === true`)) && /your ChatGPT login$/.test(await text('.cmp-brain')) && !!(await stateIs('/^Failed · the last message found no login · send it again$/')), { head: await text('.cmp-brain'), state: await text('.cmp-state') });

  // ---------- no CLI ----------
  await api('PATCH', '/api/settings', { console: { codexPath: path.join(tmp, 'no-such-codex') } });
  await reload();
  const noCli = await until(`${q('.cdx-problem .note')}?.textContent.trim()`, 15000);
  check('no CLI: one sentence with what to do, and the state No Codex', /^The Codex CLI was not found: install it, or set its path in Settings › Console/.test(noCli || '') && !!(await stateIs('/^No Codex · /')) && /CLI not found$/.test(await text('.cmp-brain')), { noCli, state: await text('.cmp-state'), head: await text('.cmp-brain') });
  await shot('f-no-cli');
  await api('PATCH', '/api/settings', { console: { codexPath: FAKE_CODEX } });

  // ---------- narrow ----------
  win.setContentSize(1000, 700);
  await reload();
  await until(`${q('.cmp-log .turn')}`, 15000);
  await sleep(900);
  const narrow = await js(`(() => { const host = document.querySelector('.codex-host'); const split = ${q('.cmp-split')}; const h = ${q('.cmp-head')}; return { width: host.clientWidth, stacked: split.classList.contains('stacked'), rowsHidden: ${q('.cmp-traj-rows')}.hidden, button: !!${q('.cmp-state-btn')}, headScroll: h.scrollWidth, headWidth: h.clientWidth }; })()`);
  check('at 1000 x 700 the trajectory stacks under the thread when the panel is under 760 px, and the head still fits', (narrow.width < 760 ? narrow.stacked && narrow.rowsHidden && narrow.button : !narrow.stacked) && narrow.headScroll <= narrow.headWidth, narrow);
  await shot('g-narrow');
  check('the session shows in the Claude Code view\'s list too', (await api('GET', `/api/console/sessions?projectId=${pid}`)).some((s) => s.id === sid && s.backend === 'codex'), null);
}

app.whenReady().then(() => main().then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch(async (err) => { results.push({ name: 'DRIVER ERROR', ok: false, seen: String(err && err.stack || err) }); await finish(3); }));
