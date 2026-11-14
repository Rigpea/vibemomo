// Audio render route: a product's rendered cue (atelier:event "render") becomes <project>/dist/audio/<id>.wav.
// bytes is measured here; seconds, peak and sampleRate are the product's own numbers, checked for shape only.
// The tuning the product rendered with is kept beside the file as <id>.tuning.json, so a render can be compared
// with the tuning file by value: a file's time says nothing, because tuning is applied live and saved later.
// The list and the read answer from the file itself, through the same pure decoder the panel draws with.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpError, insideProject } from './paths.mjs';
import { ensureDir } from './fsutil.mjs';
import { wavInfo, wavPeak } from '../../client/components/wave-peaks.js';

export const MAX_WAV_BYTES = 20 * 1024 * 1024;
// Base64 of the largest WAV plus room for the small fields; the default 4 MB body limit would refuse it first.
export const MAX_RENDER_BODY = Math.ceil(MAX_WAV_BYTES / 3) * 4 + 64 * 1024;

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
// Names Windows keeps for devices, with or without an extension: these pass ID but are not files there.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

// The room MAX_RENDER_BODY leaves for the small fields.
const MAX_TUNING_CHARS = 64 * 1024;

const invalid = (message) => new HttpError(400, 'invalid_input', message);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The cue id of a name in dist/audio, or null when the name is not a render's. The list and the export share this. */
export function renderIdOf(name) {
  if (!name.endsWith('.wav')) return null;
  const id = name.slice(0, -4);
  return ID.test(id) && !RESERVED.test(id) ? id : null;
}

/** Decode and check a render body; returns {id, wav: Buffer, seconds, peak, sampleRate, tuning} or throws an HttpError. */
export function validateRender(body) {
  const { id, wav, seconds, peak, sampleRate, tuning } = body || {};
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('id must be lowercase letters, digits and hyphens, at most 41 characters, starting with a letter or digit');
  if (RESERVED.test(id)) throw invalid(`id ${id} is a device name on Windows; rename the cue`);
  if (typeof wav !== 'string') throw invalid('wav must be a base64 string');
  // Checked on the text length, so an oversized body is never decoded.
  if (Math.floor(wav.length / 4) * 3 > MAX_WAV_BYTES + 2) throw tooLarge();
  const bytes = Buffer.from(wav, 'base64');
  // Buffer.from skips what it cannot read, so only a round trip shows the text was really base64.
  if (bytes.toString('base64') !== wav) throw invalid('wav is not valid base64');
  if (bytes.length > MAX_WAV_BYTES) throw tooLarge();
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw invalid('wav is not a RIFF/WAVE file');
  for (const [name, value] of [['seconds', seconds], ['peak', peak], ['sampleRate', sampleRate]]) {
    if (!Number.isFinite(value) || value < 0) throw invalid(`${name} must be a number of at least 0`);
  }
  if (sampleRate === 0) throw invalid('sampleRate must be above 0');
  if (peak > 1) throw invalid(`peak must be at most 1, full scale; the product answered ${peak}`);
  if (tuning !== undefined && !isObject(tuning)) throw invalid('tuning must be an object of the values the product rendered with');
  if (tuning !== undefined && JSON.stringify(tuning).length > MAX_TUNING_CHARS) throw invalid(`tuning must be at most ${MAX_TUNING_CHARS} characters of JSON`);
  return { id, wav: bytes, seconds, peak, sampleRate, tuning };
}

function tooLarge() {
  return new HttpError(413, 'too_large', `The rendered file is larger than ${MAX_WAV_BYTES / (1024 * 1024)} MB`);
}

async function writeAtomic(target, data) {
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Called once the new file is in place. A product that sends no tuning, or a failed write, must not leave the
// earlier render's values describing this file: no sidecar reads as unknown, which is true.
async function writeSidecar(target, tuning) {
  try {
    if (tuning === undefined) await fsp.rm(target, { force: true });
    else await writeAtomic(target, JSON.stringify(tuning, null, 2));
  } catch {
    await fsp.rm(target, { force: true });
  }
}

// A JSON object read from a file's first brace to its last, as the Tuning panel reads a tuning file; null if there is none.
async function readObject(projectPath, rel) {
  try {
    const text = await fsp.readFile(insideProject(projectPath, rel), 'utf8');
    const value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const readProjectTuning = (projectPath, manifest) => (typeof manifest?.tuning === 'string' ? readObject(projectPath, manifest.tuning) : null);

// With no readable tuning file there is nothing to compare with, so nothing to say. Only keys on both sides count:
// a tuning file may leave a key to the product's default, and may hold a key the product does not know.
async function standingAgainst(projectTuning, projectPath, id) {
  if (!projectTuning) return { staleAgainstTuning: false, tuningUnknown: false };
  const rendered = await readObject(projectPath, `dist/audio/${id}.tuning.json`);
  if (!rendered) return { staleAgainstTuning: false, tuningUnknown: true };
  const differs = (key) => Object.hasOwn(rendered, key) && !isDeepStrictEqual(projectTuning[key], rendered[key]);
  return { staleAgainstTuning: Object.keys(projectTuning).some(differs), tuningUnknown: false };
}

/** Write the render atomically and answer with the file's facts and where it stands against the tuning file. */
export async function saveRender(projectPath, body, manifest) {
  const { id, wav, seconds, peak, sampleRate, tuning } = validateRender(body);
  const rel = `dist/audio/${id}.wav`;
  const target = insideProject(projectPath, rel);
  await ensureDir(path.dirname(target));
  try {
    await writeAtomic(target, wav);
  } catch (err) {
    // On Windows a file open in a player cannot be replaced; the earlier render and its sidecar stay as they were.
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') throw new HttpError(409, 'file_in_use', `${rel} is open in another program; close it and render again`);
    throw err;
  }
  await writeSidecar(insideProject(projectPath, `dist/audio/${id}.tuning.json`), tuning);
  const standing = await standingAgainst(await readProjectTuning(projectPath, manifest), projectPath, id);
  const { mtime } = await fsp.stat(target);
  return { path: rel, bytes: wav.length, mtime: mtime.toISOString(), seconds, peak, sampleRate, ...standing };
}

/** What each dist/audio/<cue>.wav holds, read from the file. A file that cannot be decoded is listed with
 *  {error} instead of the numbers, because the POST checks the RIFF/WAVE header only and anything can be put there by hand. */
export async function listRenders(projectPath, manifest) {
  const dir = insideProject(projectPath, 'dist/audio');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const projectTuning = await readProjectTuning(projectPath, manifest);
  const out = [];
  for (const e of entries) {
    const id = renderIdOf(e.name);
    if (!e.isFile() || !id) continue;
    const file = path.join(dir, e.name);
    const stat = await fsp.stat(file);
    const facts = { id, path: `dist/audio/${e.name}`, bytes: stat.size, mtime: stat.mtime.toISOString(), ...await standingAgainst(projectTuning, projectPath, id) };
    try {
      const bytes = await fsp.readFile(file);
      const { seconds, sampleRate } = wavInfo(bytes);
      out.push({ ...facts, seconds, peak: wavPeak(bytes), sampleRate });
    } catch (err) {
      out.push({ ...facts, error: err.message });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The bytes of one rendered file; 400 for an id that could not be a render, 404 when there is none. */
export async function readRender(projectPath, id) {
  if (!ID.test(id) || RESERVED.test(id)) throw invalid('not a cue id');
  const rel = `dist/audio/${id}.wav`;
  try {
    return await fsp.readFile(insideProject(projectPath, rel));
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'not_found', `No render at ${rel}`);
    throw err;
  }
}
