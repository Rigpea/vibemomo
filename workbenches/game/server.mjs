// Game workbench (server side): static build of the source dir plus the
// project README, so the exported folder explains itself.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { copyDir, exists } from '../../server/lib/fsutil.mjs';

export async function build({ projectPath, manifest, outDir }) {
  const srcDir = path.join(projectPath, manifest.build?.dir || 'src');
  await copyDir(srcDir, outDir);
  const readme = path.join(projectPath, 'README.md');
  if (await exists(readme)) await fsp.copyFile(readme, path.join(outDir, 'README.md'));
  return { note: 'static game build (open index.html to play)', entry: 'index.html' };
}

export default { kind: 'game', build };
