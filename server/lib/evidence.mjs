// Model-participation evidence: tally the model ids recorded in Claude Code
// session transcripts on this machine, plus the headless probe outputs saved
// under docs/evidence. Read-only; nothing here calls a model.
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';
import fs from 'node:fs';
import { STUDIO_DIR } from './paths.mjs';
import { exists, readJson } from './fsutil.mjs';

export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const MODEL_RE = /"model":"(claude-[a-z0-9.-]+)"/g;

async function tallyFile(file, maxBytes = 64 * 1024 * 1024) {
  const stat = await fsp.stat(file);
  if (stat.size > maxBytes) return { file, skipped: 'too large', bytes: stat.size };
  const models = {};
  let messages = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"model":"claude-')) continue;
    let m;
    MODEL_RE.lastIndex = 0;
    while ((m = MODEL_RE.exec(line))) {
      models[m[1]] = (models[m[1]] || 0) + 1;
      messages++;
    }
  }
  return { file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), messages, models };
}

/** Walk <config>/projects/**.jsonl modified within `days`. */
export async function sessionEvidence({ days = 7, limit = 60 } = {}) {
  const root = path.join(CLAUDE_CONFIG_DIR, 'projects');
  if (!(await exists(root))) return { root, sessions: [], note: 'No Claude Code projects directory found' };
  const cutoff = Date.now() - days * 86400 * 1000;
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs >= cutoff) found.push({ p, mtime: st.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const f of found.slice(0, limit)) {
    const t = await tallyFile(f.p);
    if (t.messages) sessions.push({ ...t, file: path.relative(root, f.p) });
  }
  const totals = {};
  for (const s of sessions) for (const [m, c] of Object.entries(s.models || {})) totals[m] = (totals[m] || 0) + c;
  return { root, days, sessions, totals };
}

export async function probeEvidence() {
  const dir = path.join(STUDIO_DIR, 'docs', 'evidence');
  if (!(await exists(dir))) return [];
  const names = (await fsp.readdir(dir)).filter((n) => n.startsWith('probe-') && n.endsWith('.json'));
  const out = [];
  for (const n of names) {
    const data = await readJson(path.join(dir, n), null);
    if (!data) continue;
    out.push({
      file: n,
      sessionId: data.session_id || null,
      result: typeof data.result === 'string' ? data.result.slice(0, 200) : null,
      models: Object.fromEntries(Object.entries(data.modelUsage || {}).map(([k, v]) => [k, { canonical: v.canonicalModel, provider: v.provider, inputTokens: v.inputTokens, outputTokens: v.outputTokens }])),
      capturedAt: data.capturedAt || null,
    });
  }
  return out;
}

export async function modelEvidence(opts) {
  const [probes, sessions] = await Promise.all([probeEvidence(), sessionEvidence(opts)]);
  return { probes, ...sessions, generatedAt: new Date().toISOString() };
}
