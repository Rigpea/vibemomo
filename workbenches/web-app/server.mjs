// Web app / site workbench (server side): static build plus README.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { copyDir, exists } from '../../server/lib/fsutil.mjs';

export async function build({ projectPath, manifest, outDir }) {
  const srcDir = path.join(projectPath, manifest.build?.dir || 'src');
  await copyDir(srcDir, outDir);
  const readme = path.join(projectPath, 'README.md');
  if (await exists(readme)) await fsp.copyFile(readme, path.join(outDir, 'README.md'));
  return { note: 'static site build (open index.html, or host the folder on any static server)', entry: 'index.html' };
}

export default { kind: 'web-app', build };
