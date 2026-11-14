// Preview: serve a project's working tree (head) or any checkpoint (git show)
// under /preview/:projectId/:ref/<path>. Same relative layout either way, so
// relative asset links inside the product keep working.
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

/** Resolve the entry file for a project (manifest.entry, else index.html). */
export function entryFor(manifest) {
  return manifest?.entry || 'index.html';
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
    // The bare preview root redirects to the manifest entry so relative asset links resolve
    // against the entry's own folder (e.g. src/game.js next to src/index.html).
    const entry = entryFor(manifest).replace(/^\/+/, '');
    res.writeHead(302, { Location: `/preview/${projectId}/${ref}/${entry}`, 'Cache-Control': 'no-store' });
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
