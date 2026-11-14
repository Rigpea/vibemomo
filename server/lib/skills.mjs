// Claude Code skills (docs/ARCHITECTURE.md, Skills): the folders with a SKILL.md that Claude Code sessions in a project
// folder can use: the project's .claude/skills, the person's own <claude config>/skills and installed plugins' skills.
// listSkills scans them (read-only), readSkill reads one SKILL.md of a listed skill, installSkill puts a picked folder
// or .zip into the project's or the person's skills folder. Nothing outside those skill folders is read or written.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { HttpError, insideProject, folderKey } from './paths.mjs';
import { readJson, exists, rmrf } from './fsutil.mjs';
import { parseFrontmatter, categoryOf, skillProblem } from '../../client/components/skill-words.js';

export const SKILL_FILE_MAX = 400 * 1024; // what the read route shows of one SKILL.md
export const INSTALL_MAX_BYTES = 20 * 1024 * 1024; // unpacked, all files of one skill
export const INSTALL_MAX_FILES = 1000;
export const INSTALL_BODY_LIMIT = 32 * 1024 * 1024; // base64 of the above, with room

/** Claude Code's own folder: CLAUDE_CONFIG_DIR when the person set it, else ~/.claude. Read per call, so tests can point it elsewhere. */
export const claudeConfigDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

/** A path joined under a base that must stay under it (a user-skills name, a plugin's skills folder entry). */
function under(base, ...parts) {
  const target = path.resolve(base, ...parts);
  const rel = path.relative(path.resolve(base), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'path_outside', 'The path leaves the skills folder');
  return target;
}

async function dirs(folder) {
  try {
    return (await fsp.readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

async function readSkillFolder(folder, source) {
  const file = path.join(folder, 'SKILL.md');
  let text;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return null;
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 64 * 1024)); // the frontmatter is at the top
      await fh.read(buf, 0, buf.length, 0);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null; // a folder without SKILL.md is not a skill
  }
  const { meta, hasFrontmatter } = parseFrontmatter(text);
  const folderName = path.basename(folder);
  const name = (typeof meta.name === 'string' && meta.name.trim()) || folderName;
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  const { category, from } = categoryOf({ ...meta, name, description });
  const problem = hasFrontmatter ? skillProblem(meta, true) : skillProblem({}, false);
  return { name, folder: folderName, description, category, categoryFrom: from, source, path: folder, problem };
}

async function scanSkillsDir(skillsDir, source) {
  const out = [];
  for (const name of await dirs(skillsDir)) {
    const s = await readSkillFolder(path.join(skillsDir, name), source);
    if (s) out.push(s);
  }
  return out;
}

/** Installed plugins and their folders: installed_plugins.json first (v1 and v2 shapes), else plugin folders found under plugins/. */
export async function pluginFolders(configDir = claudeConfigDir()) {
  const root = path.join(configDir, 'plugins');
  const found = new Map(); // folderKey -> { name, folder }
  const add = (name, folder) => { if (folder && !found.has(folderKey(folder))) found.set(folderKey(folder), { name, folder: path.resolve(folder) }); };
  const data = await readJson(path.join(root, 'installed_plugins.json'), null).catch(() => null);
  const plugins = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : {};
  for (const [key, val] of Object.entries(plugins)) {
    const name = key.split('@')[0] || key;
    for (const install of Array.isArray(val) ? val : [val]) {
      if (install && typeof install.installPath === 'string') add(name, path.isAbsolute(install.installPath) ? install.installPath : path.join(root, install.installPath));
    }
  }
  if (!found.size) {
    // No record: a plugin is a folder holding .claude-plugin/plugin.json, a few levels down (cache/<market>/<plugin>/<version>).
    const walk = async (folder, depth) => {
      if (depth > 5) return;
      const manifest = await readJson(path.join(folder, '.claude-plugin', 'plugin.json'), null).catch(() => null);
      if (manifest) return add(typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(folder), folder);
      for (const n of await dirs(folder)) if (n !== 'node_modules') await walk(path.join(folder, n), depth + 1);
    };
    await walk(root, 0);
  }
  return [...found.values()];
}

/** Every skill a session in this project can see, project first. Answers { skills, places } with the folders scanned. */
export async function listSkills({ projectPath = null, configDir = claudeConfigDir() } = {}) {
  const places = [];
  const skills = [];
  if (projectPath) {
    const dir = insideProject(projectPath, path.join('.claude', 'skills'));
    places.push({ kind: 'project', path: dir, exists: await exists(dir) });
    skills.push(...await scanSkillsDir(dir, { kind: 'project' }));
  }
  const userDir = path.join(configDir, 'skills');
  places.push({ kind: 'user', path: userDir, exists: await exists(userDir) });
  skills.push(...await scanSkillsDir(userDir, { kind: 'user' }));
  for (const p of await pluginFolders(configDir)) {
    const dir = path.join(p.folder, 'skills');
    if (!(await exists(dir))) continue;
    places.push({ kind: 'plugin', plugin: p.name, path: dir, exists: true });
    skills.push(...await scanSkillsDir(dir, { kind: 'plugin', plugin: p.name }));
  }
  return { skills, places, configDir };
}

/** One listed skill's SKILL.md and the names in its folder. A path that is not a listed skill's folder is refused. */
export async function readSkill({ projectPath = null, configDir = claudeConfigDir() } = {}, folder) {
  if (typeof folder !== 'string' || !folder) throw new HttpError(400, 'invalid_input', 'path is required');
  const { skills } = await listSkills({ projectPath, configDir });
  const skill = skills.find((s) => folderKey(s.path) === folderKey(folder));
  if (!skill) throw new HttpError(404, 'not_a_skill', 'That folder is not one of the skills listed for this project');
  const file = path.join(skill.path, 'SKILL.md');
  const buf = await fsp.readFile(file);
  const truncated = buf.length > SKILL_FILE_MAX;
  const files = (await fsp.readdir(skill.path, { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  return { skill, file, content: buf.subarray(0, SKILL_FILE_MAX).toString('utf8'), bytes: buf.length, truncated, files };
}

/** Open a folder in the system's file manager (Explorer, Finder, the desktop's default); resolves once it started. */
export function openInFileManager(folder) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [folder]] : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  return new Promise((resolve, reject) => {
    // Explorer exits 1 even when it opened the window, so the exit code says nothing: only a failed start is an error.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (err) => reject(new HttpError(500, 'open_failed', `Could not start ${cmd}: ${err.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * Open a listed skill's folder, or one of the places the listing looked in, in the system's file manager. Any other
 * path is refused (404), and so is a place that does not exist yet. open is the opener (tests pass a recorder).
 */
export async function revealFolder({ projectPath = null, configDir = claudeConfigDir() } = {}, folder, { open = openInFileManager } = {}) {
  if (typeof folder !== 'string' || !folder) throw new HttpError(400, 'invalid_input', 'path is required');
  const { skills, places } = await listSkills({ projectPath, configDir });
  const key = folderKey(folder);
  const skill = skills.find((s) => folderKey(s.path) === key);
  const place = skill ? null : places.find((p) => folderKey(p.path) === key);
  if (!skill && !place) throw new HttpError(404, 'not_a_skill', 'That folder is neither a listed skill nor a place the studio looks for skills');
  const target = path.resolve(skill ? skill.path : place.path);
  if (!(await exists(target))) throw new HttpError(404, 'not_found', `${target} does not exist yet: nothing has been installed there`);
  await open(target);
  return { opened: target, kind: skill ? 'skill' : 'place' };
}

// ---------- install ----------

/** A picked file's path inside the skill as POSIX segments; null when it is absolute or climbs out. */
export function cleanRel(raw) {
  const s = String(raw ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\0')) return null;
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts;
}

const IGNORED = (parts) => parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store' || parts[parts.length - 1] === 'Thumbs.db';

/** The picked files as [{ parts, data }]: from { zip } (base64 of a .zip) or { files: [{ path, data }] } (base64 each). */
export function unpack({ zip, files } = {}) {
  const out = [];
  let total = 0;
  const take = (rawPath, data) => {
    const parts = cleanRel(rawPath);
    if (!parts) throw new HttpError(400, 'path_outside', `A file's path leaves the skill folder: ${String(rawPath).slice(0, 120)}`);
    if (IGNORED(parts)) return;
    total += data.length;
    if (total > INSTALL_MAX_BYTES) throw new HttpError(413, 'too_large', `A skill is at most ${INSTALL_MAX_BYTES / 1024 / 1024} MB unpacked`);
    if (out.length >= INSTALL_MAX_FILES) throw new HttpError(413, 'too_large', `A skill is at most ${INSTALL_MAX_FILES} files`);
    out.push({ parts, data });
  };
  if (typeof zip === 'string' && zip) {
    let entries;
    let declared = 0;
    try {
      entries = unzipSync(Buffer.from(zip, 'base64'), { filter: (f) => { declared += f.originalSize || 0; return declared <= INSTALL_MAX_BYTES * 2; } });
    } catch (err) {
      throw new HttpError(400, 'bad_zip', `Not a readable .zip: ${err.message}`);
    }
    if (declared > INSTALL_MAX_BYTES * 2) throw new HttpError(413, 'too_large', `A skill is at most ${INSTALL_MAX_BYTES / 1024 / 1024} MB unpacked`);
    for (const [name, data] of Object.entries(entries)) if (!name.endsWith('/')) take(name, Buffer.from(data));
  } else if (Array.isArray(files) && files.length) {
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.data !== 'string') throw new HttpError(400, 'invalid_input', 'files must be [{ path, data (base64) }]');
      take(f.path, Buffer.from(f.data, 'base64'));
    }
  } else {
    throw new HttpError(400, 'invalid_input', 'Pick a folder holding SKILL.md, or a .zip of one');
  }
  return out;
}

/** The skill inside the picked files: the shallowest SKILL.md marks its folder; files outside that folder are left out. */
export function skillFromFiles(list) {
  const marks = list.filter((f) => f.parts[f.parts.length - 1] === 'SKILL.md');
  if (!marks.length) throw new HttpError(400, 'no_skill_md', 'No SKILL.md in what you picked: a skill is a folder with a SKILL.md at its top');
  const depth = Math.min(...marks.map((f) => f.parts.length));
  const top = marks.filter((f) => f.parts.length === depth);
  if (top.length > 1) throw new HttpError(400, 'several_skills', `What you picked holds ${top.length} skills side by side; add them one at a time`);
  const base = top[0].parts.slice(0, -1);
  const inside = list.filter((f) => f.parts.length > base.length && base.every((p, i) => f.parts[i] === p)).map((f) => ({ rel: f.parts.slice(base.length).join('/'), data: f.data }));
  const { meta, hasFrontmatter } = parseFrontmatter(top[0].data.toString('utf8'));
  const problem = skillProblem(meta, hasFrontmatter);
  if (problem) throw new HttpError(400, 'invalid_skill', problem);
  const name = meta.name.trim();
  const description = meta.description.trim();
  return { name, description, category: categoryOf({ ...meta, name, description }).category, files: inside, bytes: inside.reduce((n, f) => n + f.data.length, 0) };
}

function destinationOf(target, name, { projectPath, configDir }) {
  if (target === 'project') {
    if (!projectPath) throw new HttpError(400, 'invalid_input', 'No project is open to add the skill to');
    return insideProject(projectPath, path.join('.claude', 'skills', name));
  }
  if (target === 'user') return under(path.join(configDir, 'skills'), name);
  throw new HttpError(400, 'invalid_input', 'target must be project or user');
}

/**
 * Check (dryRun) or install a picked skill. The check answers where it would go for both targets and whether a skill
 * of that name is there; the install refuses to replace one unless replace is true, writes beside the folder and
 * renames into place, so a failed write leaves the old skill as it was.
 */
export async function installSkill({ projectPath = null, configDir = claudeConfigDir() } = {}, body = {}) {
  const skill = skillFromFiles(unpack(body));
  const ctx = { projectPath, configDir };
  const place = async (target) => { const p = destinationOf(target, skill.name, ctx); return { path: p, exists: await exists(p) }; };
  const summary = { name: skill.name, description: skill.description, category: skill.category, fileCount: skill.files.length, bytes: skill.bytes };
  if (body.dryRun) return { ...summary, destinations: { project: projectPath ? await place('project') : null, user: await place('user') } };
  const target = body.target === 'user' ? 'user' : body.target === 'project' ? 'project' : null;
  if (!target) throw new HttpError(400, 'invalid_input', 'target must be project or user');
  const dest = destinationOf(target, skill.name, ctx);
  const had = await exists(dest);
  if (had && body.replace !== true) throw new HttpError(409, 'skill_exists', `A skill named ${skill.name} is already in ${dest}; confirm to replace it`);
  const parent = path.dirname(dest);
  await fsp.mkdir(parent, { recursive: true });
  const stamp = crypto.randomBytes(4).toString('hex');
  const tmp = path.join(parent, `.${skill.name}.installing-${stamp}`);
  const old = path.join(parent, `.${skill.name}.replaced-${stamp}`);
  try {
    for (const f of skill.files) {
      const abs = under(tmp, ...f.rel.split('/'));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, f.data);
    }
    if (had) await fsp.rename(dest, old);
    try {
      await fsp.rename(tmp, dest);
    } catch (err) {
      if (had) await fsp.rename(old, dest).catch(() => {});
      throw err;
    }
  } finally {
    await rmrf(tmp);
  }
  if (had) await rmrf(old);
  return { ...summary, installed: true, target, path: dest, replaced: had };
}
