// usage/ledger.jsonl: one line per API attempt (ok or not).
// Synchronous I/O on purpose: the budget gate reads spend and reserves in the
// same event-loop turn, so two concurrent runs cannot both pass a stale check.

import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_FIELDS = ['ts', 'id', 'runId', 'attempt', 'task', 'projectId', 'taskId', 'model', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'pricingVersion', 'durationMs', 'ok', 'error', 'cancelled'];

export function createLedger(dataDir) {
  const file = path.join(dataDir, 'usage', 'ledger.jsonl');

  function append(line) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = Object.fromEntries(LEDGER_FIELDS.map((k) => [k, line[k] ?? null]));
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  function readAll() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip a torn line rather than fail the studio */ }
    }
    return out;
  }

  return { file, append, readAll };
}

/** True when the line's ts falls inside cycle {start,end} (YYYY-MM-DD, inclusive); no bounds = everything. */
export function inCycle(line, cycle) {
  const day = String(line.ts || '').slice(0, 10);
  if (cycle?.start && day < cycle.start) return false;
  if (cycle?.end && day > cycle.end) return false;
  return true;
}

export function aggregate(lines) {
  const totals = { costUsd: 0, calls: 0, byModel: {}, byTask: {}, byProject: {} };
  const bump = (map, key, cost) => {
    const k = key ?? '(none)';
    map[k] ??= { costUsd: 0, calls: 0 };
    map[k].costUsd += cost;
    map[k].calls += 1;
  };
  for (const l of lines) {
    const cost = Number(l.costUsd) || 0;
    totals.costUsd += cost;
    totals.calls += 1;
    bump(totals.byModel, l.model, cost);
    bump(totals.byTask, l.task, cost);
    bump(totals.byProject, l.projectId, cost);
  }
  const r = (n) => Math.round(n * 1e9) / 1e9;
  totals.costUsd = r(totals.costUsd);
  for (const m of [totals.byModel, totals.byTask, totals.byProject]) for (const v of Object.values(m)) v.costUsd = r(v.costUsd);
  return totals;
}
