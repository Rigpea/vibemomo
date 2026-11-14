// The companion dock tab's server half (docs/ARCHITECTURE.md section 12): pins in <project>/.studio/pins.json, the
// companion's role for --append-system-prompt, and the context pack its first message carries.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError, newId, nowIso, insideProject } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';
import { pageRefs, resolveRef, importSpecs } from './mcp/tools.mjs';
import { pinTitle } from '../../client/components/companion-words.js';
import { chipsFor } from '../../workbenches/phone/map.js';
import { auraLine } from '../../workbenches/page/pages.js';
import { siblingPages } from './page.mjs';

export const MAX_PINS = 50;
export const CONTEXT_MAX_LINES = 60;
const PAGE_LINES = 24; // files of the page in the pack; the brain asks atelier_page_files for the rest
const PACK_PINS = 8;

/** The companion's role, appended to the system prompt of a context: 'companion' session. */
export const COMPANION_PROMPT = [
  "You are the person's partner inside the Atelier studio for this one project, answering in the Companion tab under the preview.",
  'You are the manager: you talk with the person, plan, hand work to workers and judge what they bring back; the workers do the work.',
  'You know the studio through its tools (mcp__atelier__*): use them to read the project, its files, versions and memory, and to look at the phone and the page.',
  'When the person asks about what is on the screen, answer with the code in hand: read the files that make it before you explain it.',
  'A change to files goes to a worker: write a task with atelier_create_task (a clear request and acceptance lines), start it with atelier_start_task, and answer the person at once; do not carry out the change in your own turn. Answering, reading code and looking at the phone or the page you do yourself.',
  'Give every task a department (the department input of atelier_create_task; when unsure which one or what it holds, read atelier_list_skills first) and name in the request the skills that matter for the work.',
  'Before you start a worker, make sure you know what the person wants; ask when it is unclear.',
  'A message that begins with "[Studio report: not from the person]" is the studio telling you a worker ended. Review its work: atelier_task_report, atelier_read_diff, and checks when they matter; then accept it or send it back with a note through atelier_review_task, record what changed for the project (unresolved items, memory), and tell the person in a few lines what came back and what you decided.',
  'At the start of a conversation, call atelier_task_report without a task to see what the workers are doing, so you can pick up where an earlier manager left off.',
  'When the person asks to be taught something or to understand how something works or will work, build a visual lesson with atelier_show_lesson (open: true) and explain it in the chat beside it; the lesson opens in the Learning view while this conversation stays on its right. A lesson is a studio record like memory, so you write it yourself in your own turn, no worker. Make it concrete to this project\'s real code and plans (read the files and the briefing first, name them): diagrams of who talks to whom, steps paged one at a time for a flow, plain words for every term. Before drawing, check atelier_list_skills for the Design and Docs departments\' diagram and design skills and follow the one that fits; replace an earlier lesson on the same subject (atelier_list_lessons) instead of making a second.',
  'End every answer by naming the files you looked at.',
].join(' ');

/** The sentence that opens the studio itself to a companion session (decision row 127): where it lives, that it is
 *  open beside the project, and how a change there is checked and kept. studioProjectId: the studio's own project id
 *  for the checkpoint command (null when the studio is not registered as a project). */
export const companionReach = (studioDir, studioProjectId = null) => [
  `The Atelier studio itself (its code in client/, server/ and workbenches/, its docs and tests) lives in ${studioDir} and is open to this session beside the project for reading.`,
  studioProjectId
    ? `When the person asks to change the studio, it is a task in the studio's own project: atelier_create_task and atelier_start_task with project ${studioProjectId}; its worker runs "npm run check" there and keeps the version.`
    : "When the person asks to change the studio, it is a task in the studio's own project once the studio is registered as one; until then, say so and ask the person how to go on.",
  'When they ask to change this project, it is a task for a worker too.',
].join(' ');

/** A file the person attaches to a message: saved under <project>/.studio/attachments/<stamp>-<name>, named in the
 *  message so the session reads it with its Read tool (images included). At most ATTACH_MAX bytes. */
export const ATTACH_MAX = 16 * 1024 * 1024;
export async function saveAttachment(projectPath, { name, data, type } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'invalid_input', 'name is required');
  if (typeof data !== 'string' || !data) throw new HttpError(400, 'invalid_input', 'data (base64) is required');
  if (!/^[A-Za-z0-9+/s]+=*$/.test(data)) throw new HttpError(400, 'invalid_input', 'data must be base64');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new HttpError(400, 'invalid_input', 'data is not base64, or empty');
  if (buf.length > ATTACH_MAX) throw new HttpError(413, 'too_large', `An attachment is at most ${ATTACH_MAX / 1024 / 1024} MB`);
  const safe = path.basename(name.trim()).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const rel = `.studio/attachments/${stamp}-${safe}`;
  const abs = insideProject(projectPath, rel, { allowStudio: true });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buf);
  return { path: rel, name: safe, bytes: buf.length, type: typeof type === 'string' && type ? type.slice(0, 80) : null };
}

const pinsFile = (projectPath) => insideProject(projectPath, path.join('.studio', 'pins.json'), { allowStudio: true });

const queues = new Map(); // project folder -> the end of its queue, so two writes never read the same list
function queued(projectPath, run) {
  const done = (queues.get(projectPath) || Promise.resolve()).then(run);
  const tail = done.catch(() => {});
  queues.set(projectPath, tail);
  tail.then(() => { if (queues.get(projectPath) === tail) queues.delete(projectPath); });
  return done;
}

export async function listPins(projectPath) {
  const data = await readJson(pinsFile(projectPath), null);
  return Array.isArray(data?.pins) ? data.pins : [];
}

const str = (v, max, name) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${name} must be text`);
  if (v.length > max) throw new HttpError(400, 'invalid_input', `${name} must be at most ${max} characters`);
  return v.trim();
};
const xy = (p, name) => {
  if (p == null) return null;
  if (typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new HttpError(400, 'invalid_input', `${name} must be { x, y } numbers`);
  return { x: p.x, y: p.y };
};

/** A pin as stored, from a request body; a 400 names the field that does not fit. */
export function checkPin(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.source !== 'phone' && b.source !== 'preview') throw new HttpError(400, 'invalid_input', 'source must be phone or preview');
  const element = str(b.element, 200, 'element');
  if (!element) throw new HttpError(400, 'invalid_input', 'element is required');
  if (b.files != null && (!Array.isArray(b.files) || b.files.length > 10 || b.files.some((f) => typeof f !== 'string' || !f.trim() || f.length > 300))) {
    throw new HttpError(400, 'invalid_input', 'files must be up to 10 file:line strings');
  }
  if (b.point != null && (typeof b.point !== 'object' || Array.isArray(b.point))) throw new HttpError(400, 'invalid_input', 'point must be { device, css }');
  const point = b.point ? { device: xy(b.point.device, 'point.device'), css: xy(b.point.css, 'point.css') } : null;
  // A preview pin may name the Page tab's page (its aura key and name); a phone pin has none.
  const pageKey = b.source === 'preview' ? str(b.pageKey, 200, 'pageKey') : '';
  return {
    source: b.source, element,
    text: str(b.text, 500, 'text'), selector: str(b.selector, 300, 'selector'), point,
    files: (b.files || []).map((f) => f.trim()), page: str(b.page, 500, 'page'), note: str(b.note, 500, 'note'),
    ...(pageKey ? { pageKey, pageName: str(b.pageName, 200, 'pageName') } : {}),
  };
}

export function addPin(projectPath, body) {
  const pin = checkPin(body);
  return queued(projectPath, async () => {
    const pins = await listPins(projectPath);
    if (pins.length >= MAX_PINS) throw new HttpError(409, 'too_many_pins', `A project keeps at most ${MAX_PINS} pins; remove one first`);
    const rec = { id: newId('pin'), ...pin, createdAt: nowIso() };
    await writeJson(pinsFile(projectPath), { pins: [...pins, rec] });
    return rec;
  });
}

export function removePin(projectPath, pinId) {
  if (!/^pin_[a-z0-9]+$/.test(String(pinId))) throw new HttpError(404, 'not_found', `Pin ${pinId} not found`);
  return queued(projectPath, async () => {
    const pins = await listPins(projectPath);
    if (!pins.some((p) => p.id === pinId)) throw new HttpError(404, 'not_found', `Pin ${pinId} not found`);
    await writeJson(pinsFile(projectPath), { pins: pins.filter((p) => p.id !== pinId) });
    return { removed: pinId };
  });
}

/** The page's files as atelier_page_files reads them (the same pageRefs, resolveRef and importSpecs), from disk. */
export async function pageFileLines(projectPath, entry, max = PAGE_LINES) {
  if (!entry || !/\.html?$/i.test(entry)) return [entry ? `Web entry: ${entry} (not an HTML page)` : 'Web entry: none named in atelier.json'];
  const read = async (rel) => { try { return await fsp.readFile(insideProject(projectPath, rel), 'utf8'); } catch { return null; } };
  const html = await read(entry);
  if (html == null) return [`Web entry: ${entry} (missing)`];
  const out = [`Web entry: ${entry}`, 'Files it loads:'];
  const seen = new Set([entry]);
  let more = 0;
  const push = (line) => { if (out.length - 2 < max) out.push(line); else more++; };
  for (const { ref, as, inline } of pageRefs(html)) {
    const r = resolveRef(entry, ref, { isImport: !!inline });
    if (!r.rel) { push(`- ${r.external || r.bare || r.outside} (${as}, ${r.external ? 'external' : r.bare ? 'package' : 'outside the project'})`); continue; }
    if (seen.has(r.rel)) continue;
    seen.add(r.rel);
    const text = await read(r.rel);
    push(`- ${r.rel} (${as}${text == null ? ', missing' : ''})`);
    if (text == null || (as !== 'module' && !/\.m?js$/i.test(r.rel))) continue;
    for (const spec of importSpecs(text)) {
      const ir = resolveRef(r.rel, spec, { isImport: true });
      if (!ir.rel || seen.has(ir.rel)) continue;
      seen.add(ir.rel);
      push(`  - ${ir.rel} (import)`);
    }
  }
  if (out.length === 2) out.push('- nothing: the entry loads no scripts or stylesheets');
  if (more) out.push(`- and ${more} more (atelier_page_files lists them all)`);
  const others = await siblingPages(projectPath, entry);
  if (others.length) out.push(`Other pages beside it: ${others.join(', ')}`);
  return out;
}

/**
 * The block the first message of a companion session carries: the project's name, purpose and direction, the web
 * entry and its files, the open pins and the phone in one line. At most CONTEXT_MAX_LINES lines.
 * phoneLine: async () => string, so a slow or missing adb cannot hold the message (the caller bounds it).
 */
export async function contextPack({ project, manifest, path: projectPath }, { phoneLine = async () => 'Phone: not read' } = {}) {
  const lines = ['Studio context (sent with the first message of this conversation only; your tools read the rest):'];
  lines.push(`Project: ${project.name} (${project.id}), ${manifest?.kind || project.kind || 'web-app'}, folder ${projectPath}`);
  lines.push(`Purpose: ${project.purpose?.trim() || 'not set'}`);
  lines.push(`Direction: ${project.direction?.trim() || 'not set'}`);
  lines.push(...(await pageFileLines(projectPath, manifest?.entry)));
  const aura = auraLine(project.ui); // the Page tab's note for the page it last saw on the preview; no note, no line
  if (aura) lines.push(aura);
  const pins = await listPins(projectPath);
  if (!pins.length) lines.push('Open pins: none');
  else {
    lines.push(`Open pins: ${pins.length}`);
    pins.slice(0, PACK_PINS).forEach((p, i) => lines.push(`- ${pinTitle(p, i + 1)}${p.text ? ` · "${p.text.slice(0, 80)}"` : ''}`));
    if (pins.length > PACK_PINS) lines.push(`- and ${pins.length - PACK_PINS} more`);
  }
  let phone;
  try { phone = await phoneLine(); } catch (err) { phone = `Phone: not read (${err.message})`; }
  lines.push(phone);
  if (lines.length > CONTEXT_MAX_LINES) return [...lines.slice(0, CONTEXT_MAX_LINES - 1), '(cut at 60 lines)'].join('\n');
  return lines.join('\n');
}

/** The phone in one line from GET /phone's providers: the Phone panel's chip words, then the iPhone's reason. */
export function phoneLineOf(providers) {
  if (!providers?.length) return 'Phone: none (no android/ or ios/ folder, capacitor.config.json or devices in atelier.json)';
  const parts = [];
  const android = providers.find((p) => p?.id === 'android');
  if (android) parts.push(android.available === false && android.reason ? `Android: ${android.reason}` : `Android: ${chipsFor(android).map((c) => c.text).join(' · ')}`);
  const ios = providers.find((p) => p?.id === 'ios');
  if (ios) parts.push(`iPhone: ${ios.reason || 'no status'}`);
  return `Phone: ${parts.join('; ')}`;
}

/** The first message as it reaches the brain: the pack, a rule, then the person's words. */
export const withContextPack = (pack, text) => `${pack}\n\n---\n\n${text}`;
