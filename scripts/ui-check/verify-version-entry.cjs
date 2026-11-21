// By-eye check that Try on a version opens the entry that version's own atelier.json names (decision row 181): the
// bare preview root's redirect, the Workbench frame after Try from the version's row, the line above the frame, Try
// on the files on disk again, and both Side by side frames. A private studio (temp data, own port and pid file), the
// real client.
//
// By default on a throwaway project from templates/web-app-notes: #2 is kept while atelier.json names a looks page,
// #3 after the entry went back. To look at a real project instead, name its folder, its id and the version, and the
// entry that version should open on:
//   VERIFY_FOLDER=<folder> VERIFY_PROJECT=<p_…> VERIFY_VERSION=<v_…> VERIFY_ENTRY=<path in the project>
// Then the private studio registers that folder in its own temp registry (nothing is imported), and every request of
// the page that is not a GET is refused before it is sent, apart from the activation, which only writes that temp
// registry: the project's records stay as they are. The refused requests are listed in the results.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-version-entry.cjs  (writes .local/verify-version-entry/)
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.local', 'verify-version-entry');
const PORT = 4937;
const BASE = `http://127.0.0.1:${PORT}`;
const REAL = process.env.VERIFY_FOLDER ? { folder: process.env.VERIFY_FOLDER, id: process.env.VERIFY_PROJECT, version: process.env.VERIFY_VERSION, entry: process.env.VERIFY_ENTRY } : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-verify-entry-'));
const dataDir = path.join(tmp, 'data');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: dataDir, ATELIER_PROJECTS_DIR: projectsDir, ATELIER_PID_FILE: path.join(tmp, 'server.pid'), STUDIO_ANTHROPIC_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

let server = null;
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, `results${REAL ? '-real' : ''}.json`), JSON.stringify(results, null, 2));
  server?.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  app.exit(code);
}
setTimeout(() => { results.push({ name: 'timed out', ok: false }); finish(2); }, 120000);

app.disableHardwareAcceleration();

/** The throwaway project: #1 from the template, #2 kept on a looks page, #3 back on the template's entry. */
async function throwaway() {
  const created = await api('POST', '/api/projects', { name: 'Verify Entry', kind: 'web-app', template: 'web-app-notes' });
  const pid = created.project.id;
  await api('POST', `/api/projects/${pid}/activate`);
  const manifest = JSON.parse((await api('GET', `/api/projects/${pid}/files?path=atelier.json`)).content);
  const setEntry = (entry) => api('PUT', `/api/projects/${pid}/files`, { path: 'atelier.json', content: JSON.stringify({ ...manifest, entry }, null, 2) });
  await api('PUT', `/api/projects/${pid}/files`, { path: 'src/looks.html', content: '<!doctype html><meta charset="utf-8"><title>Looks</title><body style="font:16px system-ui;margin:32px"><h1>Looks comparison</h1><p><button>Now</button> <button>A</button> <button>B</button> <button>C</button></p></body>' });
  await setEntry('src/looks.html');
  const looks = await api('POST', `/api/projects/${pid}/versions`, { label: 'Looks comparison' });
  await setEntry(manifest.entry);
  await api('POST', `/api/projects/${pid}/versions`, { label: 'Back to the notes' });
  return { pid, vid: looks.id, entry: 'src/looks.html' };
}

/** A folder the person's studio already holds, registered here by a registry file of this run's own: no import. */
function registerReal() {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: REAL.id, name: path.basename(REAL.folder), slug: path.basename(REAL.folder).toLowerCase(), kind: 'web-app', path: REAL.folder, createdAt: now, lastOpenedAt: now }],
    settings: { ui: {}, apiUtility: { model: 'claude-haiku-5-5' }, console: { command: '', commandMode: 'stdin', timeoutMs: 600000, claudePath: '', terminalFont: '' } },
    activeProjectId: REAL.id,
    createdAt: now,
  }, null, 2));
  return { pid: REAL.id, vid: REAL.version, entry: REAL.entry };
}

async function main() {
  if (REAL && !(REAL.id && REAL.version && REAL.entry)) throw new Error('VERIFY_FOLDER needs VERIFY_PROJECT, VERIFY_VERSION and VERIFY_ENTRY');
  const real = REAL ? registerReal() : null;
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (i > 60) throw new Error('server did not start');
    await sleep(200);
  }
  const { pid, vid, entry } = real || await throwaway();
  const bundle = await api('GET', `/api/projects/${pid}`);
  const version = bundle.versions?.find((v) => v.id === vid);
  const headEntry = bundle.manifest?.entry;
  check('the version is there, and the project opens on another entry today', version && headEntry && headEntry !== entry, { version: version && `#${version.n} ${version.label}`, today: headEntry, expected: entry });

  // The server: the bare root of the version answers with its own entry, the files on disk with today's.
  const location = async (ref) => { const res = await fetch(`${BASE}/preview/${pid}/${ref}/?t=1`, { redirect: 'manual' }); return [res.status, res.headers.get('location')]; };
  const sent = { version: await location(vid), head: await location('head') };
  check('the bare root of the version redirects to its own entry, the files on disk to today\'s', sent.version[0] === 302 && sent.version[1] === `/preview/${pid}/${vid}/${entry}?t=1` && sent.head[1] === `/preview/${pid}/head/${headEntry}?t=1`, sent);

  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const refused = [];
  if (REAL) {
    win.webContents.session.webRequest.onBeforeRequest({ urls: [`${BASE}/*`] }, (details, done) => {
      const cancel = details.method !== 'GET' && !/\/activate$/.test(new URL(details.url).pathname);
      if (cancel) refused.push(`${details.method} ${new URL(details.url).pathname}`);
      done({ cancel });
    });
  }
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(500); fs.writeFileSync(path.join(OUT, `${REAL ? 'real-' : ''}${name}.jpg`), (await win.webContents.capturePage()).toJPEG(85)); };
  /** What a frame shows once it has settled on a page of the ref: its path, title and the short words on its controls. */
  const frameFacts = async (selector, ref) => {
    for (let i = 0; i < 50; i++) {
      const f = await js(`(() => {
        const frame = document.querySelector(${JSON.stringify(selector)});
        if (!frame) return null;
        try {
          const doc = frame.contentDocument;
          const loc = frame.contentWindow.location;
          if (!doc || doc.readyState !== 'complete' || !loc.pathname.includes(${JSON.stringify(`/${ref}/`)}) || loc.pathname.endsWith(${JSON.stringify(`/${ref}/`)})) return null;
          const words = [...doc.querySelectorAll('button, [role="tab"], [role="radio"], label, a')].map((n) => (n.textContent || '').trim().replace(/\\s+/g, ' ')).filter((t) => t && t.length <= 16);
          return { src: frame.getAttribute('src'), path: decodeURIComponent(loc.pathname), search: loc.search, title: doc.title, type: doc.contentType, controls: [...new Set(words)].slice(0, 24), heading: (doc.querySelector('h1, h2')?.textContent || '').trim().slice(0, 80) };
        } catch (err) { return { error: String(err) }; }
      })()`);
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  const stageWords = () => js(`({ cap: [...document.querySelectorAll('#main .stage-cap span')].map((n) => n.textContent), banner: document.querySelector('#main .banner')?.hidden ? null : document.querySelector('#main .banner')?.textContent, overlay: document.querySelector('#main .preview-overlay')?.hidden ? null : document.querySelector('#main .preview-overlay')?.textContent })`);

  await win.loadURL(`${BASE}/#/workbench`);
  await sleep(3500);
  const atHead = await frameFacts('#main .preview-wrap > iframe', 'head');
  check('the Workbench opens on the files on disk at today\'s entry', atHead?.path === `/preview/${pid}/head/${headEntry}`, atHead);
  await shot('1-files-on-disk');

  // Try from the version's own row in the Versions drawer.
  await js(`window.atelier.toggleVersions(true, { versionId: ${JSON.stringify(vid)} })`);
  await sleep(900);
  const pressed = await js(`(() => { const b = [...document.querySelectorAll('#version-row-${vid} .row-actions button')].find((x) => x.textContent.trim() === 'Try'); if (!b) return false; b.click(); return true; })()`);
  check('the version\'s row has Try', pressed === true, pressed);
  const tried = await frameFacts('#main .preview-wrap > iframe', vid);
  check('Try on the version opens the entry its own atelier.json names', tried?.path === `/preview/${pid}/${vid}/${entry}` && /^text\/html/.test(tried.type || ''), tried);
  check('the frame was asked for the version\'s bare root, with no entry of today\'s in the address', new RegExp(`^/preview/${pid}/${vid}/\\?t=\\d+$`).test(tried?.src || ''), tried?.src);
  await sleep(600);
  const words = await stageWords();
  check('the line above the frame says Viewing the version, the banner names it, and no error lies over the preview', new RegExp(`Viewing #${version?.n}$`).test(words.cap?.[1] || '') && /Previewing|on disk now/.test(words.banner || '') && words.overlay === null, words);
  await shot('2-drawer-after-try');
  await js(`window.atelier.toggleVersions(false)`);
  await sleep(700);
  await shot('3-version-tried');

  // Try in the toolbar: the files on disk again, at today's entry.
  await js(`[...document.querySelectorAll('#main .stage-head button')].find((b) => b.textContent.trim() === 'Try').click()`);
  const back = await frameFacts('#main .preview-wrap > iframe', 'head');
  check('Try in the toolbar is back on the files on disk at today\'s entry', back?.path === `/preview/${pid}/head/${headEntry}`, back);

  // Side by side: the version in A, the files on disk in B, each on its own entry.
  await js(`window.atelier.workbench.sideBySide({ a: ${JSON.stringify(vid)}, b: 'head' }); true`); // the dialog it returns cannot cross to the driver
  const a = await frameFacts('#main .sbs-col.side-a iframe', vid);
  const b = await frameFacts('#main .sbs-col.side-b iframe', 'head');
  check('Side by side: A opens the version\'s own entry', a?.path === `/preview/${pid}/${vid}/${entry}` && /sbs=a/.test(a.search || ''), a);
  check('Side by side: B opens the files on disk at today\'s entry', b?.path === `/preview/${pid}/head/${headEntry}` && /sbs=b/.test(b.search || ''), b);
  await sleep(1200); // the toast of the Try before it has gone
  const overlay = await js(`(() => { const d = document.querySelector('#main .preview-wrap dialog.overlay'); if (!d) return null; const r = d.getBoundingClientRect(); return { open: d.open, width: Math.round(r.width), height: Math.round(r.height), labels: [...d.querySelectorAll('.sbs-label')].map((n) => n.textContent) }; })()`);
  check('the Side by side overlay is open over the preview area with both labels', overlay?.open && overlay.width > 400 && overlay.height > 200 && overlay.labels.length === 2, overlay);
  await shot('4-side-by-side');
  if (REAL) check('requests of the page that would have written were refused before they were sent', true, refused);
}

app.whenReady().then(main).then(() => finish(results.every((r) => r.ok) ? 0 : 1)).catch((err) => { results.push({ name: 'driver error', ok: false, seen: String(err.stack || err) }); finish(2); });
