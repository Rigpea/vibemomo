// The companion's tools: one table over the studio's own HTTP API (docs/ARCHITECTURE.md section 11), served by
// bin/atelier-mcp.mjs through server/lib/mcp/stdio.mjs. Every tool talks to a running studio with fetch, answers
// plain text (or an image block) naming the project it acted on, and nothing here pushes, deletes, restores,
// exports or spends on the API. Names are atelier_<verb>_<noun>.
import path from 'node:path';
import { checkShow, SHOW_VIEWS, SHOW_PANELS } from './show.mjs';
import { pngSize } from '../devices/inspect.mjs';
import { chipsFor, readoutState, taskText, candidateRef, providerOf } from '../../../workbenches/phone/map.js';
import { auraLinesForPins } from '../../../workbenches/page/pages.js';
import { normalizeDepartments, findDepartment, departmentsOf, groupByDepartment } from '../../../client/components/skill-departments.js';
import { oneLine, sourceWords } from '../../../client/components/skill-words.js';
import { LESSON_MAX_BYTES, LESSON_ID } from '../lessons.mjs';
import { CARD_ID, BOARD_FILE, BOARD_DIR, cardLine, cardImage, boardCount } from '../inspiration.mjs';
import { RULE_KINDS, RULES_FILE, ruleLine, rulesCount, byKind, lockedTokens } from '../rules.mjs';
import { REF_ID, REFS_FILE, refLine, refFull, refsCount, findRefs } from '../references.mjs';
import { CONSOLE_MODELS, WORKER_MODEL } from '../models.mjs';
import { usageText } from '../usage.mjs';
import { liveWords, argvText } from '../../../client/components/live-words.js';

export const DEFAULT_STUDIO = 'http://127.0.0.1:4747';
export const MEMORY_KINDS = ['preference', 'observation', 'decision', 'method', 'resource', 'feedback', 'lesson', 'constraint']; // as server/lib/memory.mjs KINDS; a test holds them equal
export const TASK_MODES = ['handle', 'teach', 'explore'];
export const FILE_LINES = 400; // atelier_read_file, per call
export const DIFF_LINES = 600; // atelier_read_diff
const PAGE_REFS = 60; // atelier_page_files reads at most this many references
export const INSPIRATION_IMAGE_BLOCK_MAX = 4 * 1024 * 1024; // atelier_read_inspiration attaches an image up to this size

export const SERVER_INSTRUCTIONS = 'Atelier is a local creative studio: each project is a folder with its own git history, and the studio keeps versions (#n), tasks, memory and a briefing for it. These tools read that state (the inspiration board of design references the person collected, the fixed rules saying what must stay the same in the design and the references it keeps to build from included), look at the project\'s phone, move the studio window, record work (tasks, unresolved items, memory, kept versions), and teach through visual lessons in the Learning view. Change a project through a task or a kept version, not by editing its files, unless the person asked for an edit.';

export const unreachable = (studio) => `The studio does not answer at ${studio}: start it (npm start in the studio folder) and try again.`;

/**
 * A project-relative path as the studio's guard would take it, or an Error saying why not: absolute paths,
 * paths that climb out of the project and the .git and .studio folders are refused (the server's insideProject
 * refuses them again). '' and '.' are the project folder.
 */
export function checkRel(rel) {
  const raw = String(rel ?? '').trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[a-z]:/i.test(raw)) throw new Error(`${rel} is an absolute path; name a path inside the project, relative to its folder`);
  const norm = raw ? path.posix.normalize(raw).replace(/\/+$/, '') : '.';
  if (norm === '..' || norm.startsWith('../')) throw new Error(`${rel} climbs out of the project; only paths inside it can be read`);
  const first = norm.split('/')[0].toLowerCase();
  if (first === '.git') throw new Error(`${rel} is inside .git, which the studio manages; read versions with atelier_list_versions and atelier_read_diff`);
  if (first === '.studio') throw new Error(`${rel} is inside .studio, the studio's records; read them with atelier_read_briefing and atelier_read_memory`);
  return norm === '.' ? '' : norm;
}

/** Text lines from..to (1-based, inclusive), numbered, at most `max` of them. */
export function numberLines(text, from = 1, to = null, max = FILE_LINES) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const a = Math.max(1, from);
  const b = Math.min(total, to ?? a + max - 1, a + max - 1);
  const width = String(Math.max(b, 1)).length;
  const body = a > total ? [] : lines.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(width)}  ${l}`);
  return { body: body.join('\n'), from: a, to: Math.max(a - 1, b), total };
}

/** The sections of a unified diff that touch one path (old or new side). */
export function diffOfPath(diff, rel) {
  return String(diff).split(/^(?=diff --git )/m).filter((s) => {
    const m = s.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    return m && (m[1] === rel || m[2] === rel);
  }).join('');
}

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

/** The module specifiers of an ES module's static import and export-from lines. */
export function importSpecs(js) {
  const out = [];
  const re = /^[ \t]*(?:import\s+(?:[\w$*{}\s,]+?\s+from\s+)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+)["']([^"'\n]+)["']/gm;
  for (const m of String(js).matchAll(re)) out.push(m[1]);
  return out;
}

/** What an HTML page loads: script src (module or classic), link href (stylesheets and the rest) and the
 *  imports of inline module scripts. HTML comments are skipped. */
export function pageRefs(html) {
  const s = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  for (const m of s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = attr(m[1], 'src');
    const isModule = /^module$/i.test(attr(m[1], 'type') || '');
    if (src) refs.push({ ref: src, as: isModule ? 'module' : 'script' });
    else if (isModule) for (const spec of importSpecs(m[2])) refs.push({ ref: spec, as: 'module', inline: true });
  }
  for (const m of s.matchAll(/<link\b([^>]*)>/gi)) {
    const href = attr(m[1], 'href');
    const rel = (attr(m[1], 'rel') || '').toLowerCase();
    if (href) refs.push({ ref: href, as: rel.includes('stylesheet') ? 'stylesheet' : rel.includes('modulepreload') ? 'module' : rel || 'link' });
  }
  return refs;
}

/** A reference from a project file: { rel } inside the project, { external } for a URL, { bare } for a package
 *  name in an import, { outside } for a path that leaves the project. Query and hash are dropped. */
export function resolveRef(fromRel, ref, { isImport = false } = {}) {
  const r = String(ref).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('//')) return { external: r };
  const clean = r.replace(/[?#].*$/, '');
  if (isImport && !/^\.{0,2}\//.test(clean)) return { bare: r };
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromRel), clean);
  try {
    return { rel: checkRel(joined) };
  } catch {
    return { outside: r };
  }
}

const VIEW_WORDS = { workbench: 'Workbench', learning: 'Learning', inspiration: 'Inspiration', console: 'Claude Code', tasks: 'Tasks', memory: 'Memory', settings: 'Settings' };
const PANEL_WORDS = { devices: 'Devices', phone: 'Phone', play: 'Play', tuning: 'Tuning', audio: 'Audio', page: 'Page', source: 'Source' };
const projectProp = { type: 'string', description: 'A registered project: its id (p_…), slug or name. Leave it out for the project this session is bound to.' };
const LIST_WAIT_MS = 3000; // tools/list asks the studio for the department names; a studio that is slow or down keeps the fixed words

/** atelier_create_task's department input: a described string naming the departments (live from the studio when given). */
export function departmentProp(departments = null) {
  const now = departments?.length ? ` The studio's departments now: ${departments.map((d) => (d.name.toLowerCase() === d.id ? d.name : `${d.name} (${d.id})`)).join(', ')}.` : ' The Skills tab and atelier_list_skills list them (the studio starts with Design, UX, Frontend, Backend, QA and review, Docs and writing).';
  return { type: 'string', description: `The studio skill department the work belongs to, by name or id. Give every task one: the worker is told to use that department's skills, and atelier_list_skills shows which skills each holds.${now}` };
}

export const WORKER_SCOPES = ['task', 'project', 'studio'];
/** A worker model input: one of the studio's Claude Code models, or default (the level above decides). */
export const modelProp = (what) => ({ type: 'string', enum: [...CONSOLE_MODELS, 'default'], description: `${what} One of ${CONSOLE_MODELS.join(', ')}, or default.` });
const OLDER_STUDIO = 'the running studio is older than this tool and has no route for it; restart the studio';
const isNoRoute = (err) => err?.status === 404 && /No route/.test(err.message || '');

/**
 * The worker model's three levels in words, from GET /api/projects/:id/worker-model ({ studio, project, task,
 * effective }): what each holds now, then the model the next worker starts on and where it comes from.
 */
export function workerModelText(f, { projectLabel = null } = {}) {
  const studio = `studio default: ${f.studio.model}${f.studio.stored ? '' : ` (built in; none stored)`}`;
  const project = f.project ? `project ${projectLabel || f.project.name}: ${f.project.model || 'none of its own'}` : null;
  const task = f.task ? `task ${f.task.id}: ${f.task.model || 'none of its own'}` : null;
  const out = [`Worker model now: ${[task, project, studio].filter(Boolean).join(' · ')}.`];
  if (f.effective) out.push(`${f.task ? `The next worker of task ${f.task.id}` : `The next worker of ${projectLabel || f.project?.name || 'the project'}, on a task with no model of its own,`} starts on ${f.effective.model} (${f.effective.words}).`);
  return out.join(' ');
}

/**
 * atelier_list_skills' answer from GET /api/skills ({ skills, places, departments }): every department with its skills
 * (name, one line of description, where it lives, Shared when another department holds it too), then the unplaced
 * skills, then the folders the listing read. only: one department's name or id (Error when there is none such).
 */
export function skillsText({ skills = [], places = [], departments: raw } = {}, { only = null, projectLabel = null } = {}) {
  const departments = normalizeDepartments(raw);
  const pick = only != null && String(only).trim() ? findDepartment(departments, String(only)) : null;
  if (only != null && String(only).trim() && !pick) throw new Error(`No department named ${String(only).slice(0, 60)}; the studio has ${departments.map((d) => d.name).join(', ') || 'none'}.`);
  const { groups, unplaced } = groupByDepartment(skills, departments);
  const where = (s) => sourceWords(s.source).chip;
  const line = (s, dept = null) => {
    const others = dept ? departmentsOf(departments, s.name).filter((d) => d.id !== dept.id) : [];
    return `- ${s.name} (${where(s)}${others.length ? ` · Shared · also in ${others.map((d) => d.name).join(', ')}` : ''}): ${oneLine(s.description) || 'no description written.'}`;
  };
  const head = `Skills a session${projectLabel ? ` in ${projectLabel}` : ''} can see: ${skills.length}, in ${departments.length} department${departments.length === 1 ? '' : 's'}${unplaced.length ? `, ${unplaced.length} placed in none` : ''}. Departments are the studio's, shared by every project; one skill can sit in several (marked Shared).`;
  const shown = pick ? groups.filter((g) => g.department.id === pick.id) : groups;
  const out = [head];
  for (const { department: d, skills: list } of shown) {
    const missing = d.skills.filter((n) => !skills.some((s) => s.name === n));
    out.push('', `${d.name} (${d.id}): ${list.length} skill${list.length === 1 ? '' : 's'}`, ...(list.length ? list.map((s) => line(s, d)) : ['(none placed yet)']));
    if (missing.length) out.push(`Placed here but not installed where these sessions can see them: ${missing.join(', ')}.`);
  }
  if (!pick) {
    out.push('', `Placed in no department: ${unplaced.length}`, ...unplaced.map(({ skill: s, suggested }) => `${line(s)}${suggested ? ` (its words suggest ${suggested.name})` : ''}`));
    const read = places.filter((p) => p.exists !== false);
    if (read.length) out.push('', 'Where they live:', ...read.map((p) => `- ${sourceWords(p).chip}: ${p.path}`));
  }
  return out.join('\n');
}

/** atelier_live_status's text: what is declared, the allowance, the state and the last lines (all masked by the server). */
export function liveText(s, who) {
  const lines = [`Live server of ${who}:`];
  if (s.declared) lines.push(`- Declared in atelier.json: "${s.declared.label}", runs ${argvText(s.declared.command)} in ${s.declared.cwd}`);
  else if (s.problem) lines.push(`- atelier.json's live entry is not valid: ${s.problem}`);
  else lines.push('- atelier.json declares no live server.');
  if (s.declared) lines.push(`- Allowed by the person: ${s.consent?.allowed ? `yes, since ${s.consent.allowedAt}` : s.consent?.changed ? 'no; the command changed since it was allowed' : 'no'}`);
  const w = liveWords(s);
  if (w.state !== 'invalid') lines.push(`- State: ${w.chip.toLowerCase()}${w.reason ? ` (${w.reason})` : ''}${s.state === 'running' && s.readyAt ? `, ready since ${s.readyAt}` : ''}${s.pid ? `, pid ${s.pid}` : ''}`);
  if (s.running && ['starting', 'running'].includes(s.state) && s.stale) lines.push(`- It runs the allowed command ${argvText(s.running.command)}, not the one atelier.json names now.`);
  const log = (s.log || []).slice(-15);
  if (log.length) lines.push(`Last ${log.length} of ${(s.log || []).length} log lines (tokens masked):`, ...log.map((l) => `  ${l.stream === 'stderr' ? '! ' : ''}${l.text}`));
  lines.push('Switching Live on or off is the person\'s, above the preview.');
  return lines.join('\n');
}

/**
 * The tool table: [{ name, description, inputSchema, run(args) }]. studio is the studio's origin; project the
 * id the session is bound to (null: every call must name one); session the console session this server belongs to
 * (ATELIER_SESSION_ID), named as the manager when it starts or sends back a task. fetch is injectable for tests.
 */
export function createTools({ studio = DEFAULT_STUDIO, project: bound = null, session = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  const origin = String(studio).replace(/\/+$/, '');
  const manager = typeof session === 'string' && /^cs_[a-z0-9]+$/.test(session) ? { managerSessionId: session } : {};

  async function call(method, p, { body, raw = false } = {}) {
    let res;
    try {
      res = await fetchImpl(origin + p, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error(`The studio at ${origin} did not answer ${method} ${p} within 120 s.`);
      throw new Error(unreachable(origin));
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `${method} ${p} answered ${res.status}`), { status: res.status, code: data?.error?.code, data });
    return data;
  }

  const label = (p) => `${p.name} (${p.id})`;
  const registered = (list) => list.map((x) => `${x.id} ${x.name}`).join('; ') || 'none';
  async function projectOf(args) {
    const want = args.project ?? bound;
    const list = (await call('GET', '/api/projects')) || [];
    if (!want) throw new Error(`No project: this session is bound to none, so name one with project. Registered: ${registered(list)}.`);
    const w = String(want).trim();
    const p = list.find((x) => x.id === w) || list.find((x) => x.slug === w) || list.find((x) => String(x.name).toLowerCase() === w.toLowerCase());
    if (!p) throw new Error(`No registered project ${w}. Registered: ${registered(list)}.`);
    return p;
  }
  const pid = (p) => encodeURIComponent(p.id);

  async function findVersion(p, ref) {
    const list = (await call('GET', `/api/projects/${pid(p)}/versions`)) || [];
    const r = String(ref).trim();
    const m = r.match(/^#?(\d+)$/);
    const v = m ? list.find((x) => x.n === Number(m[1])) : list.find((x) => x.id === r);
    if (!v) throw new Error(`${label(p)} has no version ${r}; it has ${list.length ? `#1 to #${Math.max(...list.map((x) => x.n))}` : 'none'}.`);
    return { v, list };
  }
  const vname = (v) => `#${v.n} ${v.label}`;

  const tools = [
    // ---------- read ----------
    {
      name: 'atelier_read_briefing',
      description: 'Read the continuation briefing of an Atelier project: the one document the studio composes from its records for whoever picks the work up. It says what the project is and for whom, where it stands (current version, uncommitted changes, the current piece and its acceptance, the next release), recent versions, accepted decisions, unresolved items, open tasks, the person\'s working preferences and the project memory. Read it first when you start on a project.',
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const { markdown } = await call('GET', `/api/briefing?projectId=${pid(p)}`);
        return `Briefing of ${label(p)}:\n\n${markdown}`;
      },
    },
    {
      name: 'atelier_read_memory',
      description: 'Read the studio\'s memory records: short facts the person and the studio keep across sessions, each with a kind (preference, observation, decision, method, resource, feedback, lesson, constraint) and a status (explicit: the person said it; inferred: someone concluded it; verified: checked against evidence). Scope project gives the records of one project, user the person\'s records for every project, all both. One line per record, newest and most certain first; retracted records are left out.',
      inputSchema: { type: 'object', properties: { project: projectProp, scope: { type: 'string', enum: ['project', 'user', 'all'], description: 'project, user or all (the default).' } }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const scope = args.scope || 'all';
        const list = (await call('GET', `/api/memory?projectId=${pid(p)}&scope=${scope}&limit=200`)) || [];
        if (!list.length) return `Memory for ${label(p)}, scope ${scope}: no records.`;
        return [`Memory for ${label(p)}, scope ${scope}: ${list.length} record${list.length === 1 ? '' : 's'}.`,
          ...list.map((r) => `- ${r.kind} · ${r.status} · ${r.scope}: ${String(r.text).replace(/\s*\n\s*/g, ' ')} (${r.id})`)].join('\n');
      },
    },
    {
      name: 'atelier_read_file',
      description: `Read a text file of an Atelier project, with line numbers. path is relative to the project folder (for example src/game.js). At most ${FILE_LINES} lines come back per call: give from and to (1-based, inclusive) to read further. Paths outside the project, and the .git and .studio folders, are refused; use atelier_read_diff for history and atelier_read_briefing or atelier_read_memory for the studio's records. Files over 512 KB are refused.`,
      inputSchema: { type: 'object', properties: { project: projectProp, path: { type: 'string', minLength: 1, description: 'File path relative to the project folder.' }, from: { type: 'integer', minimum: 1, description: 'First line, 1-based (default 1).' }, to: { type: 'integer', minimum: 1, description: `Last line, inclusive (default from + ${FILE_LINES - 1}).` } }, required: ['path'], additionalProperties: false },
      async run(args) {
        const rel = checkRel(args.path);
        if (!rel) throw new Error('path names the project folder; use atelier_list_files for folders');
        const p = await projectOf(args);
        const out = await call('GET', `/api/projects/${pid(p)}/files?path=${encodeURIComponent(rel)}`);
        if (out.type === 'dir') throw new Error(`${rel} in ${label(p)} is a folder; use atelier_list_files`);
        const n = numberLines(out.content, args.from ?? 1, args.to ?? null);
        const range = n.total === 0 ? 'empty file' : n.from > n.total ? `no line ${n.from}: the file has ${n.total}` : `lines ${n.from}-${n.to} of ${n.total}`;
        const more = n.to < n.total && n.from <= n.total ? `\n(more: from ${n.to + 1})` : '';
        return `${rel} in ${label(p)}, ${range}:\n${n.body}${more}`;
      },
    },
    {
      name: 'atelier_list_files',
      description: 'List one folder level of an Atelier project: its folders (ending in /) then its files. path is relative to the project folder; leave it out for the top. .git, .studio and node_modules are not listed. Call again with a folder\'s path to go deeper.',
      inputSchema: { type: 'object', properties: { project: projectProp, path: { type: 'string', description: 'Folder relative to the project folder (default: the top).' } }, additionalProperties: false },
      async run(args) {
        const rel = checkRel(args.path ?? '');
        const p = await projectOf(args);
        const out = await call('GET', `/api/projects/${pid(p)}/files?path=${encodeURIComponent(rel)}`);
        if (out.type !== 'dir') throw new Error(`${rel} in ${label(p)} is a file; use atelier_read_file`);
        const where = rel || 'the project folder';
        if (!out.entries.length) return `${where} in ${label(p)} is empty.`;
        return [`${where} in ${label(p)}:`, ...out.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))].join('\n');
      },
    },
    {
      name: 'atelier_list_versions',
      description: 'List the kept versions of an Atelier project, oldest first. A version is a git commit the studio recorded, named by its number (#n) and label. state says what the person thinks of it: experiment (trying something), kept (worth keeping), integrated (part of the main line), released (given to people); a star marks the version the person would ship today. Each line gives number, label, state, short sha, when it was kept and the task that made it, if any. The current line says whether the files on disk match a version.',
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const [list, changes] = await Promise.all([call('GET', `/api/projects/${pid(p)}/versions`), call('GET', `/api/projects/${pid(p)}/changes`)]);
        if (!list?.length) return `${label(p)} has no versions yet.`;
        const at = list.find((v) => v.id === changes?.sinceVersionId);
        const now = at ? `The files on disk are ${changes.dirty ? `#${at.n} with ${changes.files.length} file${changes.files.length === 1 ? '' : 's'} changed` : `exactly #${at.n}`}.` : `The files on disk are not at a kept version${changes?.dirty ? ` (${changes.files.length} file${changes.files.length === 1 ? '' : 's'} changed)` : ''}.`;
        return [`Versions of ${label(p)}: ${list.length}. ${now}`,
          ...list.map((v) => `#${v.n} ${v.label} · ${v.state}${v.userPreferred ? ' · ★' : ''} · ${String(v.sha).slice(0, 8)} · ${v.createdAt}${v.taskId ? ` · task ${v.taskId}` : ''}${v.origin ? ` · by ${v.origin}` : ''}`)].join('\n');
      },
    },
    {
      name: 'atelier_read_diff',
      description: `Read what a version of an Atelier project changed: the unified diff of that version against the version it was kept on top of (its parent), as the studio's Compare gives it, with the list of files and their added and removed lines. Name the version by number (#3 or 3) or id. Give path to see one file only. At most ${DIFF_LINES} lines of diff come back.`,
      inputSchema: { type: 'object', properties: { project: projectProp, version: { type: 'string', minLength: 1, description: 'The version: #n, n or its id.' }, path: { type: 'string', description: 'Only this file (relative to the project folder).' } }, required: ['version'], additionalProperties: false },
      async run(args) {
        const rel = args.path != null ? checkRel(args.path) : null;
        const p = await projectOf(args);
        const { v, list } = await findVersion(p, args.version);
        const parent = v.parentId ? list.find((x) => x.id === v.parentId) : null;
        if (!parent) return `${vname(v)} in ${label(p)} has no parent version to compare with${v.filesChanged?.length ? `; it recorded these files: ${v.filesChanged.join(', ')}` : ''}.`;
        const out = await call('GET', `/api/projects/${pid(p)}/compare?a=${encodeURIComponent(parent.id)}&b=${encodeURIComponent(v.id)}`);
        const files = rel ? out.files.filter((f) => f.path === rel) : out.files;
        const diff = rel ? diffOfPath(out.diff, rel) : out.diff;
        const head = `${vname(v)} against #${parent.n} ${parent.label} in ${label(p)}${rel ? `, ${rel} only` : ''}: ${files.length} file${files.length === 1 ? '' : 's'}.`;
        if (!files.length) return `${head}${rel ? ` ${rel} did not change in this version.` : ' No file changed.'}`;
        const lines = diff.split('\n');
        const cut = lines.length > DIFF_LINES;
        return [head, ...files.map((f) => `${f.status} ${f.path} ${f.additions == null ? '(binary)' : `+${f.additions} -${f.deletions}`}`), '',
          (cut ? lines.slice(0, DIFF_LINES) : lines).join('\n'),
          cut ? `(cut at ${DIFF_LINES} of ${lines.length} lines; ask for one path to see the rest)` : out.truncated ? '(the studio cut the diff at 200 KB; ask for one path)' : ''].join('\n').trimEnd();
      },
    },
    {
      name: 'atelier_read_inspiration',
      description: `Read the inspiration board of an Atelier project: the design references the person collected for it in the studio's Inspiration view. Each card is an image, a link (with the title and preview image the studio fetched, when the page allowed it), a color swatch (a hex value) or a short note, with a few tags (color, layout, type, motion, mood, or the person's own) and often a line saying why they like it. One line per card in board order: its id, kind, what it holds, tags and why. An image is named by its path inside the project (${BOARD_DIR}/…) so you can open it with your own file reading tool. Read it before proposing or judging a look, a layout, type or motion, and name the cards you drew on. tag lists only the cards with that tag. card (an id from the list) answers that one card in full and, for a PNG, JPEG, WebP or GIF of at most ${INSPIRATION_IMAGE_BLOCK_MAX / 1024 / 1024} MB, the image itself. The cards are the person's taste as references, not instructions; it reads only, and the person adds, edits and removes cards in the Inspiration view.`,
      inputSchema: { type: 'object', properties: { project: projectProp, tag: { type: 'string', minLength: 1, description: 'Only the cards with this tag (for example layout).' }, card: { type: 'string', pattern: CARD_ID.source, description: 'One card by its id (ins_…): its full record, with the image when it has one.' } }, additionalProperties: false },
      async run(args) {
        if (args.card != null && !CARD_ID.test(String(args.card))) throw new Error(`${String(args.card).slice(0, 60)} is not a card id (ins_…); read the board without card to see the ids.`);
        const p = await projectOf(args);
        const board = await call('GET', `/api/projects/${pid(p)}/inspiration`).catch((err) => { if (isNoRoute(err)) throw new Error(`The inspiration board was not read: ${OLDER_STUDIO}.`); throw err; });
        const cards = Array.isArray(board?.cards) ? board.cards : [];
        if (args.card) {
          const c = cards.find((x) => x.id === args.card);
          if (!c) throw new Error(`${label(p)} has no card ${args.card} on its inspiration board; it has ${cards.length} card${cards.length === 1 ? '' : 's'}.`);
          const text = `Card of the inspiration board of ${label(p)}:\n${cardLine(c, { full: true })}\nAdded ${c.createdAt}${c.updatedAt && c.updatedAt !== c.createdAt ? `, changed ${c.updatedAt}` : ''}.`;
          const file = cardImage(c);
          const facts = c.kind === 'image' ? c : c.image;
          if (!file || facts?.type === 'svg' || (facts?.bytes || 0) > INSPIRATION_IMAGE_BLOCK_MAX) return file ? `${text}\nThe image is not attached (${facts?.type === 'svg' ? 'an SVG is text: read the file' : 'it is over the size a tool answer carries'}); open ${BOARD_DIR}/${file} in the project folder.` : text;
          const res = await call('GET', `/api/projects/${pid(p)}/inspiration/files/${encodeURIComponent(file)}`, { raw: true });
          return { content: [{ type: 'image', data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: res.headers.get('content-type') || 'image/png' }, { type: 'text', text }] };
        }
        const want = args.tag != null ? String(args.tag).trim().replace(/^#+/, '').toLowerCase() : null;
        const shown = want ? cards.filter((c) => (c.tags || []).includes(want)) : cards;
        if (!cards.length) return `The inspiration board of ${label(p)} is empty: the person has collected no references yet (the studio's Inspiration view; ${BOARD_FILE}).`;
        const used = [...new Set(cards.flatMap((c) => c.tags || []))];
        if (want && !shown.length) return `No card of the inspiration board of ${label(p)} has the tag ${want}; the tags in use are ${used.join(', ') || 'none'}.`;
        return [`Inspiration board of ${label(p)}: ${boardCount(cards)}${want ? `; ${shown.length} with the tag ${want}` : ''}, in board order. Records in ${BOARD_FILE}, images in ${BOARD_DIR}/ of the project folder. Tags in use: ${used.join(', ') || 'none'}.`,
          ...shown.map((c, i) => `${i + 1}. ${cardLine(c, { full: true })}`)].join('\n');
      },
    },
    {
      name: 'atelier_read_rules',
      description: `Read the fixed rules of an Atelier project: what the person decided must stay the same in its design while everything else is free to change (the studio's Inspiration view, Fixed rules). Each rule is one sentence with a kind (${RULE_KINDS.join(', ')}), often a line saying why or where it comes from, and sometimes a locked design token: a CSS custom property and the exact value it keeps, such as --accent: #d6a455. One line per rule, by kind: its id, its words, the locked token, why; then the locked tokens together. Read it before proposing or making any change to a look, a layout, type, motion, wording or behaviour, keep to every rule, leave a locked token at its value, and say so when a request would break one instead of breaking it. kind lists only the rules of that kind. It reads only: the person adds, edits and removes rules in the studio.`,
      inputSchema: { type: 'object', properties: { project: projectProp, kind: { type: 'string', enum: RULE_KINDS, description: 'Only the rules of this kind (for example motion).' } }, additionalProperties: false },
      async run(args) {
        const want = args.kind != null ? String(args.kind).trim().toLowerCase() : null;
        if (want && !RULE_KINDS.includes(want)) throw new Error(`${want.slice(0, 40)} is not a kind of rule; the kinds are ${RULE_KINDS.join(', ')}.`);
        const p = await projectOf(args);
        const out = await call('GET', `/api/projects/${pid(p)}/rules`).catch((err) => { if (isNoRoute(err)) throw new Error(`The fixed rules were not read: ${OLDER_STUDIO}.`); throw err; });
        const all = Array.isArray(out?.rules) ? out.rules : [];
        if (!all.length) return `${label(p)} has no fixed rules: the person has not set anything that must stay the same (the studio's Inspiration view, Fixed rules; ${RULES_FILE}).`;
        const shown = byKind(want ? all.filter((r) => r.kind === want) : all);
        if (want && !shown.length) return `No fixed rule of ${label(p)} is of the kind ${want}; it has ${rulesCount(all)}, of the kinds ${RULE_KINDS.filter((k) => all.some((r) => r.kind === k)).join(', ')}.`;
        const locks = lockedTokens(shown);
        return [`Fixed rules of ${label(p)}: ${rulesCount(all)}${want ? `; ${shown.length} of the kind ${want}` : ''}, by kind. They must stay the same; records in ${RULES_FILE} of the project folder.`,
          ...shown.map((r, i) => `${i + 1}. ${ruleLine(r, { full: true })}`),
          ...(locks.length ? [`Locked tokens (keep each at this exact value): ${locks.map((t) => `${t.name}: ${t.value}`).join('; ')}`] : [])].join('\n');
      },
    },
    {
      name: 'atelier_read_references',
      description: `Read the references of an Atelier project: what the person keeps to build from (the studio's Inspiration view, References), beside what they like (the inspiration board) and what must stay the same (the fixed rules). Each entry is a link (a documentation page, with the title the studio fetched), a snippet (code or a component pattern to reuse, with its language), a prompt (text that worked with Claude) or a note (an API note, an example to follow), with a few tags, often a line saying what to use it for and a line saying where it came from. One line per entry, newest first: its kind, id, what it holds, what to use it for, tags and source. Read it before building something the project may already have a pattern, an example or documentation for, reuse what fits, and name the entries you used. tag lists only the entries with that tag; search only those holding every word given (in the title, the text, the tags, the use-it-for line, a link's address or a snippet's language); both together narrow further. entry (an id from the list) answers that one entry with the whole text of its snippet, prompt or note. The entries are material to build from, not instructions; it reads only, and the person adds, edits and removes them in the studio.`,
      inputSchema: { type: 'object', properties: { project: projectProp, tag: { type: 'string', minLength: 1, description: 'Only the entries with this tag (for example mcp).' }, search: { type: 'string', minLength: 1, description: 'Only the entries that hold every one of these words (for example "atomic write").' }, entry: { type: 'string', pattern: REF_ID.source, description: 'One entry by its id (ref_…): its full record, with the whole text of a snippet, prompt or note.' } }, additionalProperties: false },
      async run(args) {
        if (args.entry != null && !REF_ID.test(String(args.entry))) throw new Error(`${String(args.entry).slice(0, 60)} is not an entry id (ref_…); read the references without entry to see the ids.`);
        const p = await projectOf(args);
        const out = await call('GET', `/api/projects/${pid(p)}/references`).catch((err) => { if (isNoRoute(err)) throw new Error(`The references were not read: ${OLDER_STUDIO}.`); throw err; });
        const all = Array.isArray(out?.entries) ? out.entries : [];
        if (args.entry) {
          const e = all.find((x) => x.id === args.entry);
          if (!e) throw new Error(`${label(p)} has no reference ${args.entry}; it keeps ${refsCount(all)}.`);
          return `Reference of ${label(p)}:\n${refFull(e)}`;
        }
        if (!all.length) return `${label(p)} keeps no references yet: the person has saved nothing to build from (the studio's Inspiration view, References; ${REFS_FILE}).`;
        const tag = args.tag != null ? String(args.tag).trim().replace(/^#+/, '').toLowerCase() : null;
        const search = args.search != null ? String(args.search).trim() : '';
        const shown = findRefs(all, { tag, search });
        const used = [...new Set(all.flatMap((e) => e.tags || []))].sort();
        const asked = [tag ? `the tag ${tag}` : null, search ? `the words "${search.slice(0, 80)}"` : null].filter(Boolean).join(' and ');
        if (asked && !shown.length) return `No reference of ${label(p)} has ${asked}; it keeps ${refsCount(all)}, and the tags in use are ${used.join(', ') || 'none'}.`;
        return [`References of ${label(p)}: ${refsCount(all)}${asked ? `; ${shown.length} with ${asked}` : ''}, newest first. Records in ${REFS_FILE} of the project folder; give entry (an id) for the whole text of a snippet, prompt or note. Tags in use: ${used.join(', ') || 'none'}.`,
          ...shown.map((e, i) => `${i + 1}. ${refLine(e)}`)].join('\n');
      },
    },

    {
      name: 'atelier_list_skills',
      description: 'List the studio\'s skill departments (Design, UX, Frontend, Backend and the rest, as the person keeps them in the Skills tab), each with its Claude Code skills: name, one line of what it is for, where it lives (this project, the person\'s own skills or a plugin), and Shared when another department holds it too; then the skills placed in no department and the folders they were read from. Read it before you give a task its department with atelier_create_task, so the request can name the skills that matter. department lists that one alone.',
      inputSchema: { type: 'object', properties: { project: projectProp, department: { type: 'string', description: 'Only this department, by name or id.' } }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const out = await call('GET', `/api/skills?projectId=${pid(p)}`);
        if (!Array.isArray(out?.departments)) throw new Error(`The studio at ${origin} lists skills without departments; it is older than this tool, so restart it.`);
        return skillsText(out, { only: args.department ?? null, projectLabel: label(p) });
      },
    },

    // ---------- look ----------
    {
      name: 'atelier_phone_status',
      description: 'Read the state of the phone an Atelier project runs on: whether adb and the Android emulator were found, which device is up (an emulator or a USB phone) and whether it has finished booting, whether the project\'s app is installed and running, and how the last build went. It reads only; booting, building and launching are the person\'s buttons in the studio\'s Phone panel. Fails when the project has no android/ or ios/ folder, capacitor.config.json or devices entry in atelier.json.',
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const status = await call('GET', `/api/projects/${pid(p)}/phone`);
        const lines = [`Phone of ${label(p)}:`];
        const android = providerOf(status, 'android');
        if (android) {
          if (android.available === false && android.reason) lines.push(`- Android: ${android.reason}`);
          for (const c of chipsFor(android)) lines.push(`- ${c.label}`);
          if (android.target) lines.push(`- Actions go to ${android.target}.`);
        }
        const ios = providerOf(status, 'ios');
        if (ios) lines.push(`- iPhone: ${ios.reason || 'no status'}${ios.note ? ` ${ios.note}` : ''}`);
        return lines.join('\n');
      },
    },
    {
      name: 'atelier_phone_screenshot',
      description: 'Take a screenshot of the phone an Atelier project runs on (the emulator or USB phone the Phone panel acts on) and see it as an image, with its size in device pixels. Use it to look at what the app shows now; atelier_phone_inspect then reads the element at a point of it. Fails when no device is up.',
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const res = await call('GET', `/api/projects/${pid(p)}/phone/screenshot?t=${Date.now()}`, { raw: true });
        const png = Buffer.from(await res.arrayBuffer());
        const size = pngSize(png);
        const serial = res.headers.get('x-device-serial');
        return {
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `Phone screen of ${label(p)}${serial ? ` on ${serial}` : ''}: ${size ? `${size.width}×${size.height} device pixels` : 'size unknown'}, ${Math.max(1, Math.round(png.length / 1024))} KB.` },
          ],
        };
      },
    },
    {
      name: 'atelier_phone_inspect',
      description: 'Read what is at a point of the phone\'s screen, the way the Phone panel\'s Point mode does: the web element under it in the app\'s WebView (tag, id, classes, text, selector), the page, and the project files that likely hold it as file:line candidates. x and y are device pixels, as in atelier_phone_screenshot (0,0 is the top left). Answers nothing found on a native screen or when the app is not running or not in front.',
      inputSchema: { type: 'object', properties: { project: projectProp, x: { type: 'integer', minimum: 0, description: 'Device pixels from the left.' }, y: { type: 'integer', minimum: 0, description: 'Device pixels from the top.' } }, required: ['x', 'y'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const answer = await call('POST', `/api/projects/${pid(p)}/phone/inspect`, { body: { x: args.x, y: args.y } });
        const s = readoutState(answer);
        const head = `Point (${args.x}, ${args.y}) on the phone of ${label(p)}:`;
        if (!s.found) {
          const text = [head, s.title, s.detail || ''].filter(Boolean).join('\n');
          return answer?.ok === false ? { content: [{ type: 'text', text }], isError: true } : text;
        }
        const rest = (answer.candidates || []).slice(3).map((c) => `- ${candidateRef(c)}${c.matched?.length ? ` (matches ${c.matched.join(', ')})` : ''}`);
        return [head, taskText(answer), ...(rest.length ? ['More files:', ...rest] : [])].join('\n');
      },
    },
    {
      name: 'atelier_live_status',
      description: "Read the state of an Atelier project's live server: the project's own local server that atelier.json may declare under live { label, command, cwd } and that the Workbench shows in the preview instead of the static files when the person switches Live on. Says what is declared (or why the entry is not valid), whether the person allowed that exact command, the state (off, starting, running, failed) with its reason and address, and the last lines it printed. The address's token is masked. It reads only: starting, stopping and allowing are the person's, through the Live switch above the preview.",
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        let s;
        try {
          s = await call('GET', `/api/projects/${pid(p)}/live`);
        } catch (err) {
          if (err.status === 404 && /No route/.test(err.message)) throw new Error(`The studio at ${origin} has no live route; it is older than this tool, so restart it.`);
          throw err;
        }
        return liveText(s, label(p));
      },
    },
    {
      name: 'atelier_page_files',
      description: 'List the files an Atelier project\'s web page is made of: the entry HTML named in atelier.json, then the scripts, ES modules and stylesheets it loads (script src, link href, the imports of inline module scripts) and, one level deeper, what each local module imports; then the other HTML pages in the entry\'s folder. Paths are relative to the project folder, ready for atelier_read_file; URLs and package names are listed as such, and files that are referenced but missing are marked.',
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const bundle = await call('GET', `/api/projects/${pid(p)}`);
        const entry = bundle?.manifest?.entry;
        if (!entry) throw new Error(`${label(p)} names no entry in atelier.json`);
        const entryRel = checkRel(entry);
        if (!/\.html?$/i.test(entryRel)) throw new Error(`The entry of ${label(p)} is ${entryRel}, not an HTML page`);
        const read = async (rel) => {
          try {
            const out = await call('GET', `/api/projects/${pid(p)}/files?path=${encodeURIComponent(rel)}`);
            return out?.type === 'file' ? out.content : null;
          } catch (err) {
            if (err.status === 404) return null;
            throw err;
          }
        };
        const html = await read(entryRel);
        if (html == null) throw new Error(`The entry ${entryRel} of ${label(p)} is missing`);
        const lines = [`Page files of ${label(p)}:`, `${entryRel} (entry)`];
        const seen = new Set([entryRel]);
        const outside = [];
        let reads = 0;
        const describe = (r, ref, as, indent) => {
          if (r.external) return `${indent}${r.external} (${as}, external)`;
          if (r.bare) return `${indent}${r.bare} (${as}, package name: not a project path)`;
          if (r.outside) { outside.push(ref); return `${indent}${r.outside} (${as}, outside the project: not read)`; }
          return null;
        };
        for (const { ref, as, inline } of pageRefs(html)) {
          const r = resolveRef(entryRel, ref, { isImport: !!inline });
          const said = describe(r, ref, as, '- ');
          if (said) { lines.push(said); continue; }
          if (seen.has(r.rel)) continue;
          seen.add(r.rel);
          if (reads >= PAGE_REFS) { lines.push(`- ${r.rel} (${as}, not checked: over ${PAGE_REFS} references)`); continue; }
          reads++;
          const text = await read(r.rel);
          if (text == null) { lines.push(`- ${r.rel} (${as}, missing)`); continue; }
          lines.push(`- ${r.rel} (${as}${inline ? ', imported by the page' : ''})`);
          if (as !== 'module' && !/\.m?js$/i.test(r.rel)) continue;
          for (const spec of importSpecs(text)) {
            const ir = resolveRef(r.rel, spec, { isImport: true });
            const s2 = describe(ir, spec, 'import', '  - ');
            if (s2) { lines.push(s2); continue; }
            const missing = reads < PAGE_REFS && !seen.has(ir.rel) ? (reads++, (await read(ir.rel)) == null) : false;
            lines.push(`  - ${ir.rel} (import${missing ? ', missing' : ''})`);
            seen.add(ir.rel);
          }
        }
        if (lines.length === 2) lines.push('The entry loads no scripts or stylesheets.');
        // The other HTML pages in the entry's folder (the Page tab lists them after the entry's own screens).
        const siblings = await call('GET', `/api/projects/${pid(p)}/page/files`).then((o) => o?.siblings || [], (err) => { if (err.status === 404) return []; throw err; });
        if (siblings.length) lines.push('Other pages beside the entry:', ...siblings.map((s) => `- ${s} (page)`));
        return lines.join('\n');
      },
    },

    // ---------- move around ----------
    {
      name: 'atelier_studio_show',
      description: `Move the person's open studio window to something: select the project, go to a view (${SHOW_VIEWS.join(', ')}; console is the Claude Code view, learning the lessons beside this conversation: atelier_show_lesson opens one; inspiration the project's board of design references, which atelier_read_inspiration reads), open a Workbench panel under the preview (${SHOW_PANELS.join(', ')}; devices is the screen-size panel of web apps, play the game panel, tuning the live values, page the numbered pages of the preview with the parts of the one on screen, source the read-only file viewer), turn the Phone panel's Point mode on (point: true, which opens the phone panel), or open a file at a line (file, with line: it opens in the Source panel, scrolled to the line and marked). It changes what the person sees, never their files; use it when you want them to look at something.`,
      inputSchema: { type: 'object', properties: { project: projectProp, view: { type: 'string', enum: SHOW_VIEWS }, panel: { type: 'string', enum: SHOW_PANELS }, file: { type: 'string', description: 'A file relative to the project folder; it opens in the Source panel (panel may be left out or be source).' }, line: { type: 'integer', minimum: 1, description: 'The line to scroll to and mark in file.' }, point: { type: 'boolean', description: 'true turns the Phone panel\'s Point mode on.' } }, additionalProperties: false },
      async run(args) {
        const file = args.file != null ? checkRel(args.file) : undefined;
        if (args.file != null && !file) throw new Error('file names the project folder; name a file');
        const p = await projectOf(args);
        const checked = checkShow({ projectId: p.id, view: args.view, panel: args.panel, point: args.point, file, line: args.line });
        if (checked.error) throw new Error(`${checked.error}.`);
        const s = checked.show;
        const out = await call('POST', '/api/studio/show', { body: s });
        const parts = [`the project ${label(p)}`];
        if (s.view) parts.push(`the ${VIEW_WORDS[s.view]} view`);
        if (s.panel) parts.push(`the ${PANEL_WORDS[s.panel]} panel`);
        if (s.point === true) parts.push('Point mode on');
        if (s.point === false) parts.push('Point mode off');
        const fileLine = s.file ? `${s.file}${s.line ? `:${s.line}` : ''}` : null;
        if (fileLine) parts.push(fileLine);
        const said = [`Asked the studio to show ${parts.join(', ')}.`];
        if (s.panel) said.push(`If the project has no ${PANEL_WORDS[s.panel]} panel, the window says so instead.`);
        said.push(out?.delivered ? `${out.delivered} studio window${out.delivered === 1 ? '' : 's'} received it.` : 'No studio window is open, so nothing on screen changed.');
        return said.join(' ');
      },
    },

    // ---------- teach (studio records, written in the companion's own turn) ----------
    {
      name: 'atelier_show_lesson',
      description: `Make or replace a visual lesson in an Atelier project's Learning view: the place where you teach the person what is about to be built, while this conversation stays beside it. html is the lesson's body (headings, paragraphs, inline SVG, the studio's lesson classes below); it renders in a sandboxed frame with no network (no external scripts, styles, images or fonts: inline everything, images as data: URLs), on the studio's dark style. Classes the frame styles: <ol class="steps"> with <li class="step"> items, paged one at a time with Back and Next and a progress row; <figure class="diagram"> with an inline <svg> and a <figcaption>; <aside class="callout"> (add class "warn" or "ok" for tone); <dl class="terms"> with <dt>/<dd> pairs; <div class="flow"> holding <div class="box"> items and <span class="arrow"></span> between them (add class "down" to the flow to stack it). The person can select text or press a figure to quote it into your box with Ask about this. A lesson is a studio record like memory, not a product file: write it yourself in your own turn, no worker needed. Leave id out to make a new lesson; give the id atelier_list_lessons or an earlier answer named to replace that one. open: true moves the person's studio window to the Learning view showing it (as atelier_studio_show does). At most ${LESSON_MAX_BYTES / 1024} KB of html.`,
      inputSchema: { type: 'object', properties: { project: projectProp, id: { type: 'string', pattern: LESSON_ID.source, description: 'The lesson to replace (les_…); leave it out to make a new one.' }, title: { type: 'string', minLength: 1, maxLength: 200, description: "The lesson’s title as the shelf lists it, one line." }, topic: { type: 'string', maxLength: 200, description: 'What it is about in a few words (for example "login and data storage"), shown under the title.' }, html: { type: 'string', minLength: 1, description: `The lesson as HTML: a body fragment, or a whole document whose body is used. At most ${LESSON_MAX_BYTES / 1024} KB.` }, open: { type: 'boolean', description: "true switches the person’s studio window to the Learning view showing this lesson." } }, required: ['title', 'html'], additionalProperties: false },
      async run(args) {
        if (args.id != null && !LESSON_ID.test(String(args.id))) throw new Error(`${String(args.id).slice(0, 60)} is not a lesson id (les_…); leave id out to make a new lesson.`);
        if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('title is required: one line naming the lesson.');
        if (typeof args.html !== 'string' || !args.html.trim()) throw new Error('html is required: the lesson as HTML text.');
        const bytes = Buffer.byteLength(args.html, 'utf8');
        if (bytes > LESSON_MAX_BYTES) throw new Error(`The lesson's html is ${Math.ceil(bytes / 1024)} KB, over the ${LESSON_MAX_BYTES / 1024} KB a lesson may hold: draw with inline SVG and CSS rather than embedded images, or split it into two lessons.`);
        const p = await projectOf(args);
        const saved = await call('POST', `/api/projects/${pid(p)}/lessons`, { body: { ...(args.id ? { id: args.id } : {}), title: args.title, topic: args.topic ?? '', html: args.html } });
        const said = [`${saved.replaced ? 'Replaced' : 'Made'} lesson ${saved.id} "${saved.title}" in ${label(p)} (${Math.ceil(saved.bytes / 1024)} KB); it is on the Learning shelf.`];
        if (args.open) {
          const out = await call('POST', '/api/studio/show', { body: { projectId: p.id, view: 'learning', lesson: saved.id } });
          said.push(out?.delivered ? `Asked the studio to show it in the Learning view: ${out.delivered} studio window${out.delivered === 1 ? '' : 's'} received it.` : 'No studio window is open, so nothing on screen changed; the person finds it on the Learning shelf.');
        }
        said.push(`Replace it later with id ${saved.id}. Explain it in the chat beside it.`);
        return said.join(' ');
      },
    },
    {
      name: 'atelier_list_lessons',
      description: "List the visual lessons of an Atelier project, as the Learning view’s shelf shows them: id, title, topic, size and when each was last written, the latest first. Use it before atelier_show_lesson to replace a lesson rather than make a second one on the same subject. A lesson is a studio record like memory: read and write them in your own turn.",
      inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const { lessons = [] } = (await call('GET', `/api/projects/${pid(p)}/lessons`)) || {};
        if (!lessons.length) return `${label(p)} has no lessons yet; atelier_show_lesson makes one.`;
        return [`Lessons of ${label(p)}: ${lessons.length}, the latest first.`,
          ...lessons.map((l) => `- ${l.id} · "${l.title}"${l.topic ? ` · ${l.topic}` : ''} · ${Math.ceil((l.bytes || 0) / 1024)} KB · written ${l.updatedAt}`)].join('\n');
      },
    },

    // ---------- work ----------
    {
      name: 'atelier_create_task',
      description: 'Create a task in an Atelier project: a written request the studio turns into a brief (with the project\'s context, decisions and preferences) for a Claude Code session to carry out, after which the result comes back as a version to try. The task is created ready and nothing is handed over yet: start it with atelier_start_task, or the person starts it from the studio. mode says how the work should go: handle (do the engineering and report), teach (explain while doing, so the person learns), explore (make options to compare). acceptance lists what must be true when it is done. department names the skill department the work belongs to (atelier_list_skills lists them with their skills); give every task one. model gives the task a worker model of its own, for work that needs a stronger or a cheaper model than the project\'s; leave it out and its workers start on the project\'s model, else the studio default. Answers the task id.',
      inputSchema: { type: 'object', properties: { project: projectProp, title: { type: 'string', description: 'A short title (default: the request\'s first sentence).' }, request: { type: 'string', minLength: 1, description: 'What to do, in plain words.' }, acceptance: { type: 'array', items: { type: 'string' }, description: 'Conditions that must hold when the task is done.' }, mode: { type: 'string', enum: TASK_MODES, description: 'handle (default), teach or explore.' }, department: departmentProp(), model: modelProp('The model this task\'s workers start on, kept on the task until changed; default (or left out) means the project\'s model, else the studio default.'), pins: { type: 'array', items: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }] }, description: 'The pins the task is about: their numbers as the Companion tab lists them (Pin 1 is 1) or their ids. A preview pin on a page with an aura note adds "Aura of <page>: <note>" to the request.' } }, required: ['request'], additionalProperties: false },
      // tools/list (stdio.mjs) asks for the schema each time, so the department input names the departments as they are now.
      async listSchema() {
        const res = await fetchImpl(`${origin}/api/skills`, { signal: AbortSignal.timeout(LIST_WAIT_MS) });
        if (!res.ok) throw new Error(`GET /api/skills answered ${res.status}`);
        const { departments } = await res.json();
        if (!Array.isArray(departments)) throw new Error('no departments in the answer');
        return { ...this.inputSchema, properties: { ...this.inputSchema.properties, department: departmentProp(normalizeDepartments(departments)) } };
      },
      async run(args) {
        const p = await projectOf(args);
        let request = args.request;
        let auras = [];
        if (args.pins?.length) {
          const [{ pins = [] } = {}, bundle] = await Promise.all([call('GET', `/api/projects/${pid(p)}/companion/pins`), call('GET', `/api/projects/${pid(p)}`)]);
          const picked = args.pins.map((ref) => (Number.isInteger(ref) ? pins[ref - 1] : pins.find((x) => x.id === ref)));
          const missing = args.pins.filter((_, i) => !picked[i]);
          if (missing.length) throw new Error(`${label(p)} has no pin ${missing.join(', ')}; it has ${pins.length} pin${pins.length === 1 ? '' : 's'}.`);
          auras = auraLinesForPins(bundle?.project?.ui, picked);
          if (auras.length) request = `${String(request).trimEnd()}\n\n${auras.join('\n')}`;
        }
        const wantModel = args.model && args.model !== 'default' ? args.model : null;
        const task = await call('POST', `/api/projects/${pid(p)}/tasks`, { body: { title: args.title, request, acceptance: args.acceptance ?? [], mode: args.mode ?? 'handle', ...(args.department ? { department: args.department } : {}), ...(wantModel ? { workerModel: wantModel } : {}) } });
        // Said from the record the studio answered, not from what was asked: an older studio stores no model.
        const modelWords = task.workerModel ? `, worker model ${task.workerModel} (set for this task)` : wantModel ? `, worker model NOT stored (${OLDER_STUDIO})` : '';
        return `Created task ${task.id} in ${label(p)}: "${task.title}", mode ${task.mode}${task.department ? `, department ${task.department.name}` : ''}${modelWords}, status ${task.status}${task.acceptance?.length ? `, ${task.acceptance.length} acceptance condition${task.acceptance.length === 1 ? '' : 's'}` : ''}${auras.length ? `, with ${auras.length === 1 ? 'the aura line' : `${auras.length} aura lines`} of the pinned page${auras.length === 1 ? '' : 's'}` : ''}. Nothing was handed over yet: start it with atelier_start_task.`;
      },
    },
    {
      name: 'atelier_start_task',
      description: 'Hand a studio task to a worker: its own Claude Code session, high effort, that carries the task out while you keep talking with the person. The worker starts on the task\'s own model when it has one, else the project\'s, else the studio default (atelier_set_worker_model sets and shows all three; atelier_task_report names the one in effect). model sets the task\'s own model before it starts and keeps it for the task\'s later rounds; leave it out to change nothing. One worker writes in a project at a time; a task started while another works waits in the queue and starts when it ends. When the worker ends, the studio sends you a report in this conversation, marked as a studio report; review it then with atelier_task_report and atelier_review_task. Use it for every change to the project\'s files.',
      inputSchema: { type: 'object', properties: { project: projectProp, task: { type: 'string', pattern: '^t_[a-z0-9]+$', description: 'The task id, as atelier_create_task answered it.' }, model: modelProp('Set the task\'s own worker model before it starts (default clears it, so the project\'s or the studio default decides); leave it out to keep what the task has.') }, required: ['task'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const out = await call('POST', `/api/projects/${pid(p)}/workers`, { body: { taskId: args.task, ...(args.model ? { workerModel: args.model } : {}), ...manager } });
        // The model as the studio answered it; an older studio answers none and stored none.
        const on = out.model ? ` on ${out.model}${out.modelSource ? ` (${{ task: 'set for this task', project: 'set for this project', studio: 'studio default' }[out.modelSource] || out.modelSource})` : ''}` : '';
        const unstored = args.model && out.model === undefined && !out.already ? ` The model was NOT set: ${OLDER_STUDIO}.` : '';
        if (out.already) return `Task ${args.task} in ${label(p)} already has a worker (session ${out.sessionId}${out.model ? `, on ${out.model}` : ''}); it keeps that model.${out.next ? ` A later round of this task would start on ${out.next.model}.` : ''} You will get a studio report here when it ends.`;
        if (out.state === 'queued') return `Task ${args.task} in ${label(p)} waits in the queue at position ${out.position}, behind ${out.behind}; it starts when that worker ends${on ? `,${on} as the records say now` : ''}.${unstored} Nothing more to do now: tell the person it is queued.`;
        return `Task ${args.task} in ${label(p)} went to a worker (session ${out.sessionId})${on}.${unstored} It runs on its own; you will get a studio report here when it ends.${out.queued ? ` ${out.queued} task${out.queued === 1 ? '' : 's'} wait${out.queued === 1 ? 's' : ''} behind it.` : ''}`;
      },
    },
    {
      name: 'atelier_task_report',
      description: 'Read where the work stands. With a task id: its status, request and acceptance, the model its next worker would start on (and where that comes from: the task, the project or the studio default) and the model each of its workers ran on, the worker\'s notes and question, and its result (summary, verification, what was left open, the version and the files changed). Without one: the project\'s worker model in effect and its source, then every open task of the project with its status, the model it runs or will run on, its department, the worker running now and the queue.',
      inputSchema: { type: 'object', properties: { project: projectProp, task: { type: 'string', pattern: '^t_[a-z0-9]+$', description: 'The task id; leave it out for the overview.' } }, additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        // The worker model's levels; a studio older than this tool has no such route, and the report says so instead of failing.
        const levels = (task) => call('GET', `/api/projects/${pid(p)}/worker-model${task ? `?task=${encodeURIComponent(task)}` : ''}`).catch((err) => { if (isNoRoute(err)) return null; throw err; });
        const SHORT = { task: 'task', project: 'project', studio: 'studio default' };
        if (!args.task) {
          const [list, w, f] = await Promise.all([call('GET', `/api/projects/${pid(p)}/tasks`), call('GET', `/api/projects/${pid(p)}/workers`), levels()]);
          const rows = (Array.isArray(list) ? list : list?.tasks || []).filter((t) => !['done', 'cancelled'].includes(t.status));
          const modelOf = (t) => {
            if (w.active?.tid === t.id) return ` · runs on ${w.active.model || 'a model this studio did not record'}`;
            if (!f) return '';
            return f.models.includes(t.workerModel) ? ` · will run on ${t.workerModel} (task)` : ` · will run on ${f.effective.model} (${SHORT[f.effective.source]})`;
          };
          const lines = rows.map((t) => `- ${t.id} · ${t.status}${w.active?.tid === t.id ? ' · a worker is on it' : w.queue.includes(t.id) ? ` · queued (${w.queue.indexOf(t.id) + 1})` : ''}${modelOf(t)} · ${t.department?.name ? `${t.department.name} department` : 'no department'} · ${t.title}`);
          const model = f ? `Worker model of ${label(p)}: ${f.effective.model} (${f.effective.words}); studio default ${f.studio.model}${f.studio.stored ? '' : ' (built in; none stored)'}. A task's own model outranks both.` : `Worker model: not read (${OLDER_STUDIO}).`;
          return `${label(p)}: ${rows.length} open task${rows.length === 1 ? '' : 's'}${w.active ? `; worker on ${w.active.tid}` : '; no worker running'}${w.queue.length ? `; queue: ${w.queue.join(', ')}` : ''}${w.held ? `; ${w.held} report${w.held === 1 ? '' : 's'} held for you` : ''}.\n${model}\n${lines.join('\n') || '(none)'}`;
        }
        const [{ task, events = [], versionNames = {} }, f] = await Promise.all([call('GET', `/api/projects/${pid(p)}/tasks/${encodeURIComponent(args.task)}`), levels(args.task)]);
        const r = task.result || {};
        const said = events.filter((e) => ['note', 'question', 'answer', 'queued', 'handed_to_console', 'worker_model', 'finished', 'ingested'].includes(e.type)).slice(-12)
          .map((e) => `- ${e.at || ''} ${e.type}${e.actor ? ` (${e.actor})` : ''}${e.data?.text ? `: ${String(e.data.text).slice(0, 300)}` : ''}`);
        // Each handover as its event recorded it: a worker's names its model; a Chat or terminal handover's does not.
        const ran = events.filter((e) => e.type === 'handed_to_console').map((e) => `${e.data?.worker ? e.data.model || 'a worker, model not recorded' : 'a Chat session, model not in the task\'s events'}${e.ts ? ` (${e.ts})` : ''}`);
        return [
          `Task ${task.id} in ${label(p)}: "${task.title}" · status ${task.status} · mode ${task.mode}${task.department ? ` · department ${task.department.name}` : ''}`,
          f ? `Worker model: the next worker of this task would start on ${f.effective.model} (${f.effective.words}). Ran on: ${ran.join('; ') || 'no worker yet'}.` : `Worker model: not read (${OLDER_STUDIO}). Ran on: ${ran.join('; ') || 'no worker yet'}.`,
          `Request: ${String(task.request || '').slice(0, 1200)}`,
          task.acceptance?.length ? `Acceptance:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}` : 'Acceptance: none written',
          said.length ? `Activity:\n${said.join('\n')}` : 'Activity: none yet',
          task.result ? [
            `Result: ${r.summary || '(no summary)'}`,
            r.versionId ? `Version: ${versionNames[r.versionId] || r.versionId}` : r.note ? `No version: ${r.note}` : null,
            r.verification?.length ? `Verified: ${r.verification.join('; ')}` : 'Verified: nothing named',
            r.unresolved?.length ? `Left open: ${r.unresolved.join('; ')}` : null,
            r.filesChanged?.length ? `Files changed: ${r.filesChanged.slice(0, 40).join(', ')}` : null,
          ].filter(Boolean).join('\n') : 'Result: none yet',
        ].join('\n');
      },
    },
    {
      name: 'atelier_review_task',
      description: 'Your verdict on a worker\'s task after you checked it. accept: the result is recorded (its decisions and open items carried into the project) and the task is done. revise: the note goes to the task (as the answer, when the worker asked a question) and the task goes back to a worker, who receives the note. Accept only what you checked against the acceptance; say in the note what you checked.',
      inputSchema: { type: 'object', properties: { project: projectProp, task: { type: 'string', pattern: '^t_[a-z0-9]+$' }, verdict: { type: 'string', enum: ['accept', 'revise'] }, note: { type: 'string', description: 'What you checked (accept), or what the worker should do differently (revise, required).' } }, required: ['task', 'verdict'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const out = await call('POST', `/api/projects/${pid(p)}/tasks/${encodeURIComponent(args.task)}/review`, { body: { verdict: args.verdict, note: args.note || '', ...manager } });
        if (args.verdict === 'accept') return `Accepted task ${args.task} in ${label(p)}: status ${out.status}${out.versionId ? `, version ${out.versionId}` : ''}.`;
        return out.state === 'queued' ? `Sent task ${args.task} back; it waits in the queue at position ${out.position}.` : `Sent task ${args.task} back to a worker (session ${out.sessionId}) with your note.`;
      },
    },
    {
      name: 'atelier_set_worker_model',
      description: `Set or clear the model the studio's workers start on, at one of three levels. scope task: that task's own model (needs task), used for its every launch, queued starts and revise rounds after atelier_review_task included, until changed. scope project: the model of the project's workers whose task names none. scope studio: the studio default for every project that names none, kept across studio restarts. model is one of the studio's Claude Code models, or default, which clears that level so the next one decides: the task's, then the project's, then the studio default, then the built-in ${WORKER_MODEL}. The answer says what each level holds now and which model the next worker will actually start on. A running worker keeps its model: a change reaches the next worker started, with no restart. Nothing switches by itself; the model changes only when you or the person set it, so say which model you set and why (atelier_worker_usage shows how much each has been used).`,
      inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: WORKER_SCOPES, description: 'task (needs task), project, or studio (the default for every project).' }, model: modelProp('The model to set at that level; default clears the level.'), project: projectProp, task: { type: 'string', pattern: '^t_[a-z0-9]+$', description: 'The task id, for scope task.' } }, required: ['scope', 'model'], additionalProperties: false },
      async run(args) {
        if (!WORKER_SCOPES.includes(args.scope)) throw new Error(`scope must be ${WORKER_SCOPES.join(', ')} (got ${JSON.stringify(args.scope)}).`);
        if (args.scope === 'task' && !args.task) throw new Error('scope task needs task: the task id (t_…).');
        const older = (err) => { if (isNoRoute(err)) throw new Error(`Nothing was set: ${OLDER_STUDIO}.`); throw err; };
        const body = { workerModel: args.model, actor: 'companion' };
        const cleared = args.model === 'default' || args.model == null || args.model === '';
        // The project the answer speaks of: named or bound; scope studio needs none.
        const p = args.scope === 'studio' && !(args.project ?? bound) ? null : await projectOf(args);
        let did;
        if (args.scope === 'task') {
          await call('PUT', `/api/projects/${pid(p)}/tasks/${encodeURIComponent(args.task)}/worker-model`, { body }).catch(older);
          did = cleared ? `Task ${args.task} in ${label(p)} has no worker model of its own now.` : `Task ${args.task} in ${label(p)}: its workers start on ${args.model}.`;
        } else if (args.scope === 'project') {
          await call('GET', `/api/projects/${pid(p)}/worker-model`).catch(older); // an older studio would refuse the field or ignore it
          await call('PATCH', `/api/projects/${pid(p)}`, { body: { workerModel: args.model } });
          did = cleared ? `${label(p)} has no worker model of its own now.` : `${label(p)}: its workers start on ${args.model} when their task names no model.`;
        } else {
          const { studio } = await call('PUT', '/api/settings/worker-model', { body }).catch(older);
          did = cleared ? `The studio default is cleared: nothing is stored, so the built-in ${studio.fallback} applies.` : `The studio default is ${studio.model} now, stored for every project that names no model.`;
          if (!p) return `${did} Worker model now: studio default: ${studio.model}${studio.stored ? '' : ' (built in; none stored)'}. The next worker of a project and task with no model of their own starts on ${studio.model}. A running worker keeps the model it started on.`;
        }
        const [f, w] = await Promise.all([call('GET', `/api/projects/${pid(p)}/worker-model${args.scope === 'task' ? `?task=${encodeURIComponent(args.task)}` : ''}`), call('GET', `/api/projects/${pid(p)}/workers`)]);
        const running = w.active ? `A worker is on ${w.active.tid} now${w.active.model ? `, on ${w.active.model}` : ''}; it keeps that model.` : 'A running worker keeps the model it started on.';
        return `${did} ${workerModelText(f, { projectLabel: label(p) })} ${running}`;
      },
    },
    {
      name: 'atelier_worker_usage',
      description: 'Read how much each model has been used by the studio\'s Claude Code sessions, to choose a worker model by: for the last 24 hours and the last 7 days, the sessions and turns per model, apart for workers, the companion (manager) and other studio sessions, with the tokens (in, out, cache read, cache write) and the cost figure Claude Code\'s result event reported for those turns, and a line saying so wherever a figure was not recorded. It is counted from the studio\'s own session records, nothing is estimated, and it does not know the plan\'s limits or what is left of them. Use it before atelier_set_worker_model when the person asks how much of a model is being used, or to move routine work to a cheaper model.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Only this project\'s sessions: its id (p_…), slug or name. Leave it out for every project, since the plan is shared by all of them.' } }, additionalProperties: false },
      async run(args) {
        const p = args.project ? await projectOf({ project: args.project }) : null;
        const tally = await call('GET', `/api/workers/usage${p ? `?projectId=${pid(p)}` : ''}`).catch((err) => { if (isNoRoute(err)) throw new Error(`No usage read: ${OLDER_STUDIO}.`); throw err; });
        return usageText(tally, { scope: p ? label(p) : 'every project' });
      },
    },
    {
      name: 'atelier_add_unresolved',
      description: 'Add an unresolved item to an Atelier project: something open that the next person or session must know about (a question nobody has answered, a thing not verified, a known fault left in place). Unresolved items appear in the briefing and the Focus panel until the person resolves them.',
      inputSchema: { type: 'object', properties: { project: projectProp, text: { type: 'string', minLength: 1, description: 'The open item, in one or two sentences.' } }, required: ['text'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const project = await call('PATCH', `/api/projects/${pid(p)}`, { body: { unresolvedAdd: [{ text: args.text }] } });
        const item = (project?.unresolved || []).at(-1);
        return `Added an unresolved item to ${label(p)}${item?.id ? ` (${item.id})` : ''}: ${args.text.trim()}`;
      },
    },
    {
      name: 'atelier_add_memory',
      description: `Add a memory record to an Atelier project: a short fact worth keeping across sessions, of one kind (${MEMORY_KINDS.join(', ')}). It is recorded with source companion and status inferred, because it is your conclusion rather than something the person said; the person can correct or retract it in the studio's Memory view. Read atelier_read_memory first so you do not repeat a record.`,
      inputSchema: { type: 'object', properties: { project: projectProp, kind: { type: 'string', enum: MEMORY_KINDS }, text: { type: 'string', minLength: 1, description: 'The fact, in one or two sentences.' } }, required: ['kind', 'text'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        const rec = await call('POST', '/api/memory', { body: { kind: args.kind, text: args.text, scope: 'project', projectId: p.id, provenance: { source: 'companion' } } });
        return `Added memory ${rec.id} to ${label(p)}: ${rec.kind}, ${rec.status}, source ${rec.provenance?.source}: ${rec.text}`;
      },
    },
    {
      name: 'atelier_keep_version',
      description: 'Keep the files of an Atelier project as they are on disk now as a new version: the studio commits the working tree and records it with the next number (#n), the label and the note, as the person\'s Keep version button does. It never restores, deletes or pushes anything. When nothing changed since the last version there is nothing to keep, and it says so.',
      inputSchema: { type: 'object', properties: { project: projectProp, label: { type: 'string', minLength: 1, description: 'A short name for the version.' }, note: { type: 'string', description: 'What changed and why, if worth saying.' } }, required: ['label'], additionalProperties: false },
      async run(args) {
        const p = await projectOf(args);
        try {
          const v = await call('POST', `/api/projects/${pid(p)}/versions`, { body: { label: args.label, note: args.note ?? '' } });
          return `Kept #${v.n} "${v.label}" in ${label(p)} (${String(v.sha).slice(0, 8)}, ${v.filesChanged?.length ?? 0} file${v.filesChanged?.length === 1 ? '' : 's'}).`;
        } catch (err) {
          if (err.code !== 'nothing_changed') throw err;
          const at = err.data?.existing;
          return `Nothing to keep in ${label(p)}: the files on disk match ${at ? `#${at.n} ${at.label}` : 'the last version'}.`;
        }
      },
    },
  ];
  return tools;
}
