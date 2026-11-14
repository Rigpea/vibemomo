// Inspect: from a device pixel to the element under it in the app's WebView (Chrome DevTools Protocol over
// the WebView's debugging socket, forwarded by adb) and to the project files that likely hold it.
// The pure parts (mapping, PNG size, socket and page choice, the file search) are exported for the tests.
import path from 'node:path';
import fsp from 'node:fs/promises';

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!Buffer.isBuffer(buf) || buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A device point to the page's CSS point. The WebView fills the bottom of the screen up to the status bar, so
 * the inset at the top is what the screenshot has above the viewport: screenHeight - innerHeight * dpr, at least 0.
 */
export function mapDevicePoint({ x, y, dpr, innerHeight, screenHeight }) {
  const inset = Math.max(0, screenHeight - innerHeight * dpr);
  return { device: { x, y }, dpr, inset: round2(inset), screenHeight, css: { x: round2(x / dpr), y: round2(Math.max(0, y - inset) / dpr) } };
}

/** The WebView's DevTools socket name for a pid, from /proc/net/unix (the line ends in @webview_devtools_remote_<pid>). */
export function findDevtoolsSocket(procNetUnix, pid) {
  const want = `webview_devtools_remote_${pid}`;
  for (const line of String(procNetUnix || '').split(/\r?\n/)) {
    const m = line.trim().match(/@(\S+)$/);
    if (m && m[1] === want) return want;
  }
  return null;
}

/** The page that is the app: a visible page on localhost (Capacitor serves the app there) before any other page. */
export function pickPage(pages) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p?.type === 'page' && p.webSocketDebuggerUrl && p.url && p.url !== 'about:blank');
  const local = (p) => { try { return new URL(p.url).hostname === 'localhost'; } catch { return false; } };
  const visible = (p) => { try { return JSON.parse(p.description || '{}').visible === true; } catch { return false; } };
  return list.find((p) => local(p) && visible(p)) || list.find(local) || list.find(visible) || list[0] || null;
}

/** The forwarded port, whatever host the WebView wrote into its own URL. */
export function socketUrlOn(port, url) {
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
}

/** A minimal CDP client: send(method, params) -> result, rejecting on a protocol error or after timeoutMs. */
export function openCdp(url, WS = globalThis.WebSocket, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WS(url); } catch (err) { return reject(new Error(`Could not open the DevTools socket: ${err.message}`)); }
    let id = 0;
    const pending = new Map();
    const opening = setTimeout(() => { reject(new Error(`The DevTools socket did not open within ${timeoutMs / 1000} s`)); try { ws.close(); } catch { /* gone */ } }, timeoutMs);
    const dropAll = (why) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); } pending.clear(); };
    ws.addEventListener('open', () => {
      clearTimeout(opening);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const n = ++id;
            const timer = setTimeout(() => { pending.delete(n); rej(new Error(`${method} had no answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
            pending.set(n, { resolve: res, reject: rej, timer, method });
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* gone */ } },
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return; // an event, not an answer
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || 'protocol error'}`));
      else p.resolve(msg.result || {});
    });
    ws.addEventListener('error', () => { clearTimeout(opening); reject(new Error('Could not open the DevTools socket')); dropAll('The DevTools socket failed'); });
    ws.addEventListener('close', () => dropAll('The DevTools socket closed'));
  });
}

/** Runs in the page on the element under the point (a text node becomes its parent element). */
export const DESCRIBE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList);
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  let selector;
  if (el.id) selector = '#' + esc(el.id);
  else {
    let nth = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) nth++;
    selector = tag + classes.map((c) => '.' + esc(c)).join('') + ':nth-of-type(' + nth + ')';
  }
  return { tag, id: el.id || null, classes, text, selector, url: location.href };
}`;

export const VIEW_EXPRESSION = '({ dpr: devicePixelRatio, innerHeight: innerHeight, innerWidth: innerWidth, hash: location.hash })';

/** What the file search looks for: the id, each class, and the first six words of the text as one phrase. */
export function searchTerms(element) {
  const terms = [];
  if (element?.id && element.id.length >= 2) terms.push({ kind: 'id', term: element.id });
  for (const c of element?.classes || []) if (typeof c === 'string' && c.length >= 2) terms.push({ kind: 'class', term: c });
  const words = String(element?.text || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  if (words.length >= 3) terms.push({ kind: 'text', term: words });
  return terms;
}

const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.vue', '.svelte', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.studio', '.gradle', 'android', 'ios']);
const MAX_FILES = 3000;
const MAX_BYTES = 1024 * 1024;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function textFiles(root) {
  const out = [];
  async function walk(dir) {
    if (out.length >= MAX_FILES) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p); }
      else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * Lines in the web folder that hold the element's id, classes or text: [{ file, line, matched }] with file
 * relative to the project (forward slashes), most terms matched first, at most `limit`.
 * An id or class counts only as a whole name (not inside "start-button" for "start"); the text, case aside.
 */
export async function findCandidates({ projectPath, root, element, limit = 8 }) {
  const terms = searchTerms(element);
  if (!terms.length) return [];
  const tests = terms.map(({ kind, term }) => {
    if (kind === 'text') { const low = term.toLowerCase(); return (line) => line.replace(/\s+/g, ' ').toLowerCase().includes(low); }
    const re = new RegExp(`(?<![\\w-])${escapeRe(term)}(?![\\w-])`);
    return (line) => re.test(line);
  });
  const hits = [];
  for (const file of await textFiles(root)) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || stat.size > MAX_BYTES) continue;
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text == null || text.includes('\u0000')) continue;
    const rel = path.relative(projectPath, file).split(path.sep).join('/');
    text.split(/\r?\n/).forEach((line, i) => {
      const matched = terms.filter((_, k) => tests[k](line)).map((t) => t.term);
      if (matched.length) hits.push({ file: rel, line: i + 1, matched });
    });
  }
  hits.sort((a, b) => b.matched.length - a.matched.length || a.file.localeCompare(b.file) || a.line - b.line);
  return hits.slice(0, limit);
}

/** The folder the search reads: the manifest entry's folder, else the Capacitor webDir, else the project. */
export function searchRootOf(manifest = {}, config = {}) {
  if (typeof manifest.entry === 'string' && manifest.entry.trim()) return path.dirname(manifest.entry.trim()) || '.';
  return config.webDir || '.';
}
