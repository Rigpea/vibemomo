// Audio workbench (server side): the default static copy, plus the rendered cues.
// Renders live in <project>/dist/audio, outside versions, so the copy of the source dir leaves them behind.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { staticCopy } from '../../server/lib/build.mjs';
import { ensureDir } from '../../server/lib/fsutil.mjs';
import { insideProject } from '../../server/lib/paths.mjs';
import { renderIdOf } from '../../server/lib/audio-render.mjs';

// The same names the Audio panel's list shows, and the .wav files it does not. Sidecars and temp files are neither.
async function renderedFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const wavs = entries.filter((e) => e.isFile() && e.name.endsWith('.wav')).map((e) => e.name).sort();
  const names = wavs.filter(renderIdOf);
  return { names, skipped: wavs.length - names.length };
}

export async function build({ projectPath, manifest, outDir }) {
  await staticCopy({ projectPath, manifest, outDir });
  const from = insideProject(projectPath, 'dist/audio');
  const { names, skipped } = await renderedFiles(from);
  const skippedNote = skipped ? `, ${skipped} skipped by name` : '';
  if (!names.length) return { note: `static copy, no rendered files yet${skippedNote}`, rendered: 0 };
  const to = await ensureDir(path.join(outDir, 'audio'));
  for (const name of names) await fsp.copyFile(path.join(from, name), path.join(to, name));
  return { note: `static copy + ${names.length} rendered file${names.length > 1 ? 's' : ''}${skippedNote}`, rendered: names.length };
}

export default { kind: 'audio', build };
