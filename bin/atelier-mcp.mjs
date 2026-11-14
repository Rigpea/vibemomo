#!/usr/bin/env node
// Atelier's MCP server over stdio: the companion's tools (server/lib/mcp/tools.mjs) for any brain that speaks
// MCP; a Chat session with Studio tools on attaches it (server/lib/console.mjs). It talks to a running studio
// over HTTP, so start the studio first. stdout carries protocol messages only; logs go to stderr.
//   node bin/atelier-mcp.mjs [--studio http://127.0.0.1:4747] [--project p_…] [--session cs_…]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../server/lib/mcp/stdio.mjs';
import { createTools, DEFAULT_STUDIO, SERVER_INSTRUCTIONS } from '../server/lib/mcp/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (line) => process.stderr.write(`[atelier-mcp] ${line}\n`);

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('Usage: node bin/atelier-mcp.mjs [--studio <origin>] [--project <id>] [--session <cs_id>]\nAn MCP server over stdio (protocol 2025-06-18) with the studio\'s tools; needs the studio running.\n');
  process.exit(0);
}
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) { log(`${name} needs a value`); process.exit(2); }
  return v;
};
const studio = opt('--studio') || DEFAULT_STUDIO;
const project = opt('--project');
// The console session this server belongs to (server/lib/console.mjs studioMcpConfig): the manager a started task's
// worker reports back to. Without it the report goes to the task project's Companion session.
const fromEnv = process.env.ATELIER_SESSION_ID || null;
if (fromEnv && !/^cs_[a-z0-9]+$/.test(fromEnv)) log('ATELIER_SESSION_ID is not a console session id (cs_…); left out');
const session = opt('--session') || (fromEnv && /^cs_[a-z0-9]+$/.test(fromEnv) ? fromEnv : null);
if (!/^https?:\/\/[^\s/]+$/i.test(studio.replace(/\/+$/, ''))) { log(`--studio must be an origin like ${DEFAULT_STUDIO}`); process.exit(2); }
if (project && !/^p_[a-z0-9]+$/.test(project)) { log('--project must be a project id (p_…)'); process.exit(2); }
if (session && !/^cs_[a-z0-9]+$/.test(session)) { log('--session must be a console session id (cs_…)'); process.exit(2); }

let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version; } catch { /* keep 0.0.0 */ }

log(`v${version} · studio ${studio}${project ? ` · project ${project}` : ' · no project bound'}${session ? ` · session ${session}` : ''}`);
await serveStdio({
  input: process.stdin,
  output: process.stdout,
  tools: createTools({ studio, project, session }),
  serverInfo: { name: 'atelier', version },
  instructions: SERVER_INSTRUCTIONS,
  log,
});
