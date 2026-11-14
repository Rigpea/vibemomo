// Lessons (docs/ARCHITECTURE.md section 19): the Learning view's records, one file per lesson in
// <project>/.studio/lessons/<id>.json as { id, title, createdAt, updatedAt, topic, html }. A lesson is a studio
// record like memory, not product source: the Companion writes it through atelier_show_lesson in its own turn and the
// person reads it in a sandboxed frame (client/components/lesson-frame.js). Writes go through a per-project queue.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError, newId, nowIso, insideProject } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';

/** A lesson's html is at most this many bytes (UTF-8): room for inline SVG diagrams, not for embedded media. */
export const LESSON_MAX_BYTES = 400 * 1024;
export const TITLE_MAX = 200;
export const TOPIC_MAX = 200;
export const MAX_LESSONS = 200;
/** The only ids a lesson file may have: newId('les') makes them, and a path can never be built from anything else. */
export const LESSON_ID = /^les_[a-z0-9]{4,40}$/;

const dirOf = (projectPath) => insideProject(projectPath, path.join('.studio', 'lessons'), { allowStudio: true });
const fileOf = (projectPath, id) => path.join(dirOf(projectPath), `${id}.json`);

const queues = new Map(); // project folder -> the end of its queue
function queued(projectPath, run) {
  const done = (queues.get(projectPath) || Promise.resolve()).then(run);
  const tail = done.catch(() => {});
  queues.set(projectPath, tail);
  tail.then(() => { if (queues.get(projectPath) === tail) queues.delete(projectPath); });
  return done;
}

const notFound = (id) => new HttpError(404, 'not_found', `Lesson ${String(id).slice(0, 60)} not found`);
export const isLessonId = (id) => typeof id === 'string' && LESSON_ID.test(id);

const oneLine = (v, max, name, { required = false } = {}) => {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, 'invalid_input', `${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${name} must be text`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, 'invalid_input', `${name} is required`);
  if (s.length > max) throw new HttpError(400, 'invalid_input', `${name} must be at most ${max} characters`);
  return s;
};

/** The fields of a save request, checked; a 400 or 413 names what does not fit. */
export function checkLesson(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (b.id != null && !isLessonId(b.id)) throw new HttpError(400, 'invalid_input', 'id must be a lesson id (les_…) as the studio gave it; leave it out to make a new lesson');
  const title = oneLine(b.title, TITLE_MAX, 'title', { required: true });
  const topic = oneLine(b.topic, TOPIC_MAX, 'topic');
  if (typeof b.html !== 'string' || !b.html.trim()) throw new HttpError(400, 'invalid_input', 'html is required: the lesson as HTML text');
  const bytes = Buffer.byteLength(b.html, 'utf8');
  if (bytes > LESSON_MAX_BYTES) throw new HttpError(413, 'too_large', `A lesson's html is at most ${LESSON_MAX_BYTES / 1024} KB; this one is ${Math.ceil(bytes / 1024)} KB. Draw with inline SVG and CSS rather than embedded images, or split it into two lessons`);
  return { id: b.id || null, title, topic, html: b.html };
}

const summary = (rec) => ({ id: rec.id, title: rec.title, topic: rec.topic || '', createdAt: rec.createdAt, updatedAt: rec.updatedAt, bytes: Buffer.byteLength(rec.html || '', 'utf8') });
const order = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

async function readOne(projectPath, id) {
  const rec = await readJson(fileOf(projectPath, id), null).catch(() => null);
  if (!rec || typeof rec !== 'object' || rec.id !== id || typeof rec.html !== 'string') return null;
  return rec;
}

/** Every lesson of the project as { id, title, topic, createdAt, updatedAt, bytes }, the latest written first.
 *  A file whose name is not a lesson id, or that does not read as one, is left out. */
export async function listLessons(projectPath) {
  let names = [];
  try { names = await fsp.readdir(dirOf(projectPath)); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isLessonId);
  const recs = (await Promise.all(ids.map((id) => readOne(projectPath, id)))).filter(Boolean);
  return recs.map(summary).sort(order);
}

export async function getLesson(projectPath, id) {
  if (!isLessonId(id)) throw notFound(id);
  const rec = await readOne(projectPath, id);
  if (!rec) throw notFound(id);
  return { id: rec.id, title: rec.title, topic: rec.topic || '', createdAt: rec.createdAt, updatedAt: rec.updatedAt, html: rec.html };
}

/** Create (no id) or replace (the id of a lesson that exists) a lesson. Answers its summary and replaced. */
export async function saveLesson(projectPath, body) {
  const input = checkLesson(body);
  return queued(projectPath, async () => {
    const now = nowIso();
    let created = now;
    if (input.id) {
      const old = await readOne(projectPath, input.id);
      if (!old) throw new HttpError(404, 'not_found', `Lesson ${input.id} not found; leave id out to make a new lesson`);
      created = old.createdAt || now;
    } else if ((await listLessons(projectPath)).length >= MAX_LESSONS) {
      throw new HttpError(409, 'too_many_lessons', `A project keeps at most ${MAX_LESSONS} lessons; delete one on the Learning shelf first`);
    }
    const rec = { id: input.id || newId('les'), title: input.title, createdAt: created, updatedAt: now, topic: input.topic, html: input.html };
    await writeJson(fileOf(projectPath, rec.id), rec);
    return { ...summary(rec), replaced: !!input.id };
  });
}

export async function deleteLesson(projectPath, id) {
  if (!isLessonId(id)) throw notFound(id);
  return queued(projectPath, async () => {
    try { await fsp.unlink(fileOf(projectPath, id)); } catch (err) { if (err.code === 'ENOENT') throw notFound(id); throw err; }
    return { removed: id };
  });
}
