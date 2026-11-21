// `npm run app:shortcut` [--remove]   (Windows)
// Puts "vibeMomo" on the Desktop: a shortcut that opens the studio window from THIS folder
// (node_modules/electron/dist/electron.exe <this folder>), the same as `npm run app`. The
// companion it starts when none is running is the source here, with the projects beside it and
// the pid file in .local/, so `npm run restart` and studio tasks see the same server. The portable
// exe in dist-app/ is for another machine: it runs a temp copy of the source and keeps new projects
// under Documents\Atelier projects (README, "Desktop app"). Decision row 64.
// The shortcut was called Atelier.lnk before the visible rename. That one is replaced (and removed by --remove) only
// when it opens this folder's window: its target is this electron.exe and its argument this folder. Any other
// Atelier.lnk is someone else's and stays.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remove = process.argv.includes('--remove');
const log = (m) => console.log(`[shortcut] ${m}`);

if (process.platform !== 'win32') {
  log('a Desktop shortcut is made on Windows only; elsewhere start the window with `npm run app`.');
  process.exit(1);
}
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const icon = path.join(ROOT, 'app', 'icon.ico');
for (const f of [electron, icon]) {
  if (!fs.existsSync(f)) { log(`missing ${f}${f === electron ? ' (run npm install)' : ''}`); process.exit(1); }
}

/** Run a PowerShell script (encoded, so no quoting of ours is parsed by the shell); its stdout. */
function ps(script) {
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) { log(`powershell failed: ${(r.error && r.error.message) || (r.stderr || r.stdout || '').trim()}`); process.exit(1); }
  return r.stdout.trim();
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const desktop = ps(`[Environment]::GetFolderPath('Desktop')`);
const lnk = path.join(desktop, 'vibeMomo.lnk');
const oldLnk = path.join(desktop, 'Atelier.lnk');

/** What a shortcut on disk opens, read back: { target, args, cwd, icon }. */
function readShortcut(file) {
  const [target, args, cwd, icon] = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)}); "$($s.TargetPath)|$($s.Arguments)|$($s.WorkingDirectory)|$($s.IconLocation)"`).split('|');
  return { target, args, cwd, icon };
}
const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

/** Remove the old Atelier.lnk only when it opens this folder's window; say why one is left. */
function dropOldShortcut() {
  if (!fs.existsSync(oldLnk)) return;
  const s = readShortcut(oldLnk);
  if (!samePath(s.target, electron) || !samePath(s.args.replace(/^"|"$/g, ''), ROOT)) {
    log(`left ${oldLnk}: it opens ${s.target} ${s.args}, not this folder's window`);
    return;
  }
  fs.rmSync(oldLnk);
  log(`removed ${oldLnk} (this shortcut's name before the rename)`);
}

if (remove) {
  if (fs.existsSync(lnk)) { fs.rmSync(lnk); log(`removed ${lnk}`); } else log(`nothing at ${lnk}`);
  dropOldShortcut();
  process.exit(0);
}

ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})
$s.TargetPath = ${q(electron)}
$s.Arguments = ${q(`"${ROOT}"`)}
$s.WorkingDirectory = ${q(ROOT)}
$s.IconLocation = ${q(`${icon},0`)}
$s.Description = 'vibeMomo: opens the studio window; starts the companion from this folder when none is running'
$s.Save()`);

// Report what is on disk, not what was asked for.
const { target, args, cwd, icon: ico } = readShortcut(lnk);
dropOldShortcut();
log(lnk);
log(`opens ${target} ${args}`);
log(`in ${cwd}; icon ${ico}`);

// The shortcut runs with Explorer's PATH, not this shell's: say where that PATH finds node.
const sysPath = ps(`[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')`);
const nodeDir = sysPath.split(';').map((d) => d.trim()).filter(Boolean).find((d) => fs.existsSync(path.join(d, 'node.exe')));
if (nodeDir) {
  const exe = path.join(nodeDir, 'node.exe');
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout || '';
  log(`node for the companion: ${exe} (${v.trim() || 'version unknown'})`);
} else {
  log('warning: no node.exe on the system PATH; with no companion running the window will show the "needs Node.js 22" page');
}
