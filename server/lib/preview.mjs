// Preview: serve a project's working tree (head) or any checkpoint (git show)
// under /preview/:projectId/:ref/<path>. Same relative layout either way, so
// relative asset links inside the product keep working. The bare root
// /preview/:projectId/:ref/ redirects to the entry of that ref.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { insideProject, HttpError, toPosix } from './paths.mjs';
import { loadProject } from './projects.mjs';
import { getVersion } from './versions.mjs';
import * as git from './git.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** A manifest's entry as a path inside the project ("dist/welcome/looks.html"), or null when it names none or one that
 *  leaves the folder. It ends in a redirect, where a browser would follow ".." out of the preview's own path. */
export function entryPath(manifest) {
  if (typeof manifest?.entry !== 'string') return null;
  const raw = manifest.entry.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || /^[a-z]:/i.test(raw) || /[\u0000-\u001f]/.test(raw)) return null;
  const clean = path.posix.normalize(raw).replace(/^\.\//, '');
  return clean === '.' || clean === '..' || clean.startsWith('../') ? null : clean;
}

/**
 * The entry a ref opens on. The files on disk: the current manifest's. A version: the entry its own atelier.json names,
 * read from its commit, because a version can keep another page than the one the project opens on today; a version with
 * no manifest, an unreadable one or one that names no entry opens on the current entry. own says which of the two it is.
 */
export async function entryAt(projectPath, manifest, ref) {
  const current = entryPath(manifest) || 'index.html';
  if (ref === 'head') return { entry: current, own: true };
  const version = await getVersion(projectPath, ref);
  const buf = version.sha ? await git.showFile(projectPath, version.sha, 'atelier.json') : null;
  let kept = null;
  try { kept = buf ? entryPath(JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))) : null; } catch { /* not JSON: as if it had none */ }
  return { entry: kept || current, own: !!kept };
}

export async function servePreview(req, res, { projectId, ref, rel }) {
  const { path: projectPath, manifest } = await loadProject(projectId);
  if (manifest.kind === 'studio') {
    // Never nest the studio inside its own preview: each nested copy opens an SSE
    // connection and starves the browser's per-host connection pool.
    const note = `<!doctype html><meta charset="utf-8"><title>Studio preview</title><body style="font:14px system-ui;color:#cfd3da;background:#15171b;margin:0;display:grid;place-items:center;height:100vh"><p style="max-width:40ch;text-align:center">The studio's preview is this window. Studio versions are listed in the Versions drawer; Compare, Keep version and Restore work on the studio's own repository.</p></body>`;
    return send(res, Buffer.from(note), 'text/html; charset=utf-8', { cache: false });
  }
  let target = rel || '';
  if (!target) {
    // The bare preview root redirects to the entry so relative asset links resolve against the entry's own folder
    // (e.g. src/game.js next to src/index.html). The entry is the ref's own (entryAt), and the query rides along:
    // the client's cache-buster and the side-by-side frame's letter.
    const { entry } = await entryAt(projectPath, manifest, ref);
    const search = new URL(req.url, 'http://studio.local').search;
    res.writeHead(302, { Location: `/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(ref)}/${entry.split('/').map(encodeURIComponent).join('/')}${search}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (target.endsWith('/')) target = target + 'index.html';
  if (ref === 'head') {
    const abs = insideProject(projectPath, target);
    let stat = await fsp.stat(abs).catch(() => null);
    if (stat && stat.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      stat = await fsp.stat(idx).catch(() => null);
      if (!stat) throw new HttpError(404, 'not_found', `No index.html in ${target}`);
      return send(res, await fsp.readFile(idx), mimeFor(idx), { cache: false });
    }
    if (!stat) throw new HttpError(404, 'not_found', `Not found: ${target}`);
    return send(res, await fsp.readFile(abs), mimeFor(abs), { cache: false });
  }
  const version = await getVersion(projectPath, ref);
  const posix = toPosix(path.normalize(target)).replace(/^\.\//, '');
  insideProject(projectPath, posix); // confinement check only
  let buf = await git.showFile(projectPath, version.sha, posix);
  if (buf === null) {
    buf = await git.showFile(projectPath, version.sha, `${posix.replace(/\/$/, '')}/index.html`);
    if (buf === null) throw new HttpError(404, 'not_found', `Not in version ${ref}: ${posix}`);
    return send(res, buf, 'text/html; charset=utf-8', { cache: true });
  }
  return send(res, buf, mimeFor(posix), { cache: true });
}

function send(res, buf, type, { cache }) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}
