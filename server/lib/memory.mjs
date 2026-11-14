// Memory records: one JSON file each. User-wide (and tool/session scoped)
// records live in ~/.atelier/memory; project records in <project>/.studio/memory.
// Retrieval is plain scoring over text/tags — no model involved.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { DATA_DIR, newId, nowIso, HttpError } from './paths.mjs';
import { readJson, writeJson, ensureDir, appendJsonl, exists } from './fsutil.mjs';
import { loadRegistry } from './registry.mjs';

export const KINDS = ['preference', 'observation', 'decision', 'method', 'resource', 'feedback', 'lesson', 'constraint'];
export const SCOPES = ['user', 'project', 'session', 'tool'];
export const STATUSES = ['explicit', 'inferred', 'verified', 'retracted'];

export const USER_STORE = path.join(DATA_DIR, 'memory');
export const projectStore = (projectPath) => path.join(projectPath, '.studio', 'memory');

function storeFor(scope, projectPath) {
  if (scope === 'project') {
    if (!projectPath) throw new HttpError(400, 'invalid_input', 'A project is required for project-scoped memory');
    return projectStore(projectPath);
  }
  return USER_STORE;
}

async function readStore(dir) {
  if (!(await exists(dir))) return [];
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  const out = [];
  for (const n of names) {
    const rec = await readJson(path.join(dir, n), null);
    if (rec && rec.id) out.push(rec);
  }
  return out;
}

export function validateRecord(rec) {
  if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) throw new HttpError(400, 'invalid_input', 'Memory text is required');
  if (!KINDS.includes(rec.kind)) throw new HttpError(400, 'invalid_input', `kind must be one of ${KINDS.join(', ')}`);
  if (!SCOPES.includes(rec.scope)) throw new HttpError(400, 'invalid_input', `scope must be one of ${SCOPES.join(', ')}`);
  if (rec.status && !STATUSES.includes(rec.status)) throw new HttpError(400, 'invalid_input', `status must be one of ${STATUSES.join(', ')}`);
}

export async function addMemory(input, { projectPath = null, projectId = null } = {}) {
  const rec = {
    id: newId('m'),
    kind: input.kind,
    scope: input.scope,
    scopeRef: input.scope === 'project' ? projectId : input.scopeRef || null,
    status: input.status || (input.provenance?.source === 'user' || input.provenance?.source === 'brief' ? 'explicit' : 'inferred'),
    text: String(input.text || '').trim(),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    provenance: { source: 'studio', ref: '', evidence: '', ...(input.provenance || {}) },
    links: { versions: [], files: [], tasks: [], urls: [], ...(input.links || {}) },
    supersedes: input.supersedes || null,
    supersededBy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  validateRecord(rec);
  const dir = storeFor(rec.scope, projectPath);
  await ensureDir(dir);
  await writeJson(path.join(dir, `${rec.id}.json`), rec);
  await appendJsonl(path.join(dir, 'memory-log.jsonl'), { ts: rec.createdAt, op: 'add', id: rec.id, kind: rec.kind, scope: rec.scope });
  return rec;
}

/** Find a record by id in the user store, the given project, then every registered project. */
export async function locate(id, { projectPath = null } = {}) {
  const candidates = [USER_STORE];
  if (projectPath) candidates.push(projectStore(projectPath));
  const reg = await loadRegistry();
  for (const p of reg.projects) candidates.push(projectStore(p.path));
  for (const dir of candidates) {
    const file = path.join(dir, `${id}.json`);
    if (await exists(file)) return { file, dir, rec: await readJson(file) };
  }
  throw new HttpError(404, 'not_found', `Memory ${id} not found`);
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/** Scored retrieval. scope: 'user' | 'project' | 'all' (default). */
export async function listMemory({ scope = 'all', projectPath = null, projectId = null, q = '', kind = null, includeRetracted = false, limit = 50 } = {}) {
  let records = [];
  if (scope === 'user' || scope === 'all') records = records.concat(await readStore(USER_STORE));
  if ((scope === 'project' || scope === 'all') && projectPath) {
    const recs = await readStore(projectStore(projectPath));
    records = records.concat(recs.map((r) => ({ ...r, scopeRef: r.scopeRef || projectId })));
  }
  if (!includeRetracted) records = records.filter((r) => r.status !== 'retracted');
  if (kind) records = records.filter((r) => r.kind === kind);
  const terms = tokenize(q);
  const scored = records.map((r) => {
    let match = 0;
    if (terms.length) {
      const hay = tokenize(r.text + ' ' + (r.tags || []).join(' '));
      const set = new Set(hay);
      for (const t of terms) {
        if (set.has(t)) match += 2;
        else if (hay.some((h) => h.startsWith(t) || t.startsWith(h))) match += 1;
      }
      if ((r.tags || []).some((tag) => terms.includes(tag.toLowerCase()))) match += 2;
    }
    const bonus = r.status === 'explicit' || r.status === 'verified' ? 0.5 : 0;
    return { r, match, score: match + bonus };
  });
  const filtered = terms.length ? scored.filter((s) => s.match > 0) : scored;
  filtered.sort((a, b) => b.score - a.score || (b.r.updatedAt || '').localeCompare(a.r.updatedAt || ''));
  return filtered.slice(0, limit).map((s) => ({ ...s.r, score: s.score }));
}

/** Correct a record: a changed text creates a superseding record; other fields patch in place. */
export async function correctMemory(id, partial, { projectPath = null, projectId = null, actor = 'user' } = {}) {
  const { file, dir, rec } = await locate(id, { projectPath });
  if (partial.text !== undefined && String(partial.text).trim() !== rec.text) {
    const replacement = {
      ...rec,
      id: newId('m'),
      text: String(partial.text).trim(),
      tags: partial.tags ?? rec.tags,
      status: partial.status || (actor === 'user' ? 'explicit' : rec.status),
      provenance: { ...rec.provenance, source: actor === 'user' ? 'user' : rec.provenance.source, ref: `corrects ${id}`, ...(partial.provenance || {}) },
      supersedes: id,
      supersededBy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    validateRecord(replacement);
    await writeJson(path.join(dir, `${replacement.id}.json`), replacement);
    rec.supersededBy = replacement.id;
    rec.status = 'retracted';
    rec.updatedAt = nowIso();
    await writeJson(file, rec);
    await appendJsonl(path.join(dir, 'memory-log.jsonl'), { ts: nowIso(), op: 'correct', id, replacedBy: replacement.id });
    return { record: replacement, retracted: rec };
  }
  for (const key of ['status', 'tags', 'links', 'kind']) {
    if (partial[key] !== undefined) rec[key] = partial[key];
  }
  validateRecord(rec);
  rec.updatedAt = nowIso();
  await writeJson(file, rec);
  await appendJsonl(path.join(dir, 'memory-log.jsonl'), { ts: nowIso(), op: 'patch', id, fields: Object.keys(partial) });
  return { record: rec, retracted: null };
}

export async function retractMemory(id, { projectPath = null } = {}) {
  return correctMemory(id, { status: 'retracted' }, { projectPath });
}

export async function deleteMemory(id, { projectPath = null } = {}) {
  const { file, dir } = await locate(id, { projectPath });
  await fsp.unlink(file);
  await appendJsonl(path.join(dir, 'memory-log.jsonl'), { ts: nowIso(), op: 'delete', id });
  return { deleted: id };
}

export async function exportMemory({ projectPath = null } = {}) {
  const user = await readStore(USER_STORE);
  const project = projectPath ? await readStore(projectStore(projectPath)) : [];
  return { exportedAt: nowIso(), user, project };
}
