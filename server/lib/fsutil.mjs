// Durable file helpers: atomic JSON writes, JSONL logs, template copies, hashes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    if (err instanceof SyntaxError) {
      // Keep a copy of the damaged file so nothing is silently lost.
      const broken = `${file}.corrupt-${Date.now()}`;
      await fsp.copyFile(file, broken).catch(() => {});
      if (fallback !== undefined) return structuredClone(fallback);
    }
    throw err;
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/** Bytes written the same atomic way (an image of the inspiration board): never a half-written file under the name. */
export async function writeBytes(file, buf) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
}

export async function appendJsonl(file, record) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function readJsonl(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Copy a directory tree (used for templates). Skips node_modules and .git. */
export async function copyDir(src, dest, { skip = ['node_modules', '.git'] } = {}) {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (skip.includes(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(from, to, { skip });
    else await fsp.copyFile(from, to);
  }
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** Recursively list files under dir as POSIX relative paths (skips .git, node_modules). */
export async function listFiles(dir, { skip = ['.git', 'node_modules', '.studio'] } = {}) {
  const out = [];
  async function walk(cur, rel) {
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(cur, e.name), r);
      else out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}
