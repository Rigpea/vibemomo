// The worker and companion usage tally (docs/ARCHITECTURE.md section 17): counted from the studio's own console
// session records (server/lib/console.mjs: <data>/console/cs_*.json), nothing else. A turn counts in a window when it
// ended inside it; its tokens and cost are the figures Claude Code's result event reported for that turn (usage,
// modelUsage, total_cost_usd), kept as recorded and never estimated. The studio does not know the plan's limits or what
// is left of them, so nothing here says so. Codex sessions are counted apart, with no cost: Codex reports none.
// Pure: tallyUsage(records, { now }).
import { CONSOLE_MODELS } from './models.mjs';

const HOUR = 3600 * 1000;
export const USAGE_WINDOWS = [{ id: '24h', label: 'Last 24 hours', ms: 24 * HOUR }, { id: '7d', label: 'Last 7 days', ms: 7 * 24 * HOUR }];
export const USAGE_KINDS = ['worker', 'companion', 'other'];

/** worker: run by the manager's queue; companion: a Companion (manager) session; other: any other Claude Code session of the studio. */
export const sessionKind = (rec) => (rec?.worker === true ? 'worker' : rec?.context === 'companion' ? 'companion' : 'other');

/** A model id as Claude Code reports it ("claude-opus-5-5[1m]", a dated id) as the studio's id for it, else null. */
export function studioModelId(reported) {
  const r = String(reported || '');
  return [...CONSOLE_MODELS].sort((a, b) => b.length - a.length).find((m) => r === m || r.startsWith(m)) || null;
}

/** The model a turn ran on: what Claude Code reported for the turn, else the session's own model, else 'unknown'. */
export const turnModel = (rec, turn) => studioModelId(turn?.model) || studioModelId(rec?.model) || (typeof rec?.model === 'string' && rec.model ? rec.model : 'unknown');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Codex sessions (server/lib/codex.mjs) are counted apart from Claude Code's: another login, another plan, and no
// cost figure at all, because `codex exec` reports none. worker: a Codex worker; other: the Codex tab and any other.
export const CODEX_KINDS = ['worker', 'other'];
export const CODEX_NO_COST = 'Codex reports no cost';

/** One window of Codex turns: { sessions, turns, apiKeyTurns, rows: [{ kind, model, effort, sessions, turns, turnsWithTokens, tokens | null }] }.
 *  tokens: { input, output, cachedInput, reasoningOutput } as Codex's turn.completed gave them (cachedInput is part of input). */
function tallyCodex(list, since, now) {
  const rows = new Map();
  const sessions = new Set();
  let turns = 0;
  let apiKeyTurns = 0;
  for (const rec of list) {
    const kind = rec.worker === true ? 'worker' : 'other';
    for (const turn of rec.turns || []) {
      if (turn.role === 'user' || turn.refused) continue;
      const at = Date.parse(turn.at);
      if (!(at > since && at <= now)) continue;
      const model = (typeof turn.model === 'string' && turn.model) || (typeof rec.model === 'string' && rec.model) || 'Codex\'s default model';
      const effort = (typeof turn.effort === 'string' && turn.effort) || (typeof rec.effort === 'string' && rec.effort) || null;
      const key = `${kind} ${model} ${effort}`;
      if (!rows.has(key)) rows.set(key, { kind, model, effort, sessionIds: new Set(), turns: 0, turnsWithTokens: 0, tokens: { input: 0, output: 0, cachedInput: 0, reasoningOutput: 0 } });
      const row = rows.get(key);
      row.sessionIds.add(rec.id);
      row.turns++;
      sessions.add(rec.id);
      turns++;
      if (turn.login === 'api-key') apiKeyTurns++;
      if (turn.usage && typeof turn.usage === 'object') {
        row.turnsWithTokens++;
        row.tokens.input += num(turn.usage.input_tokens);
        row.tokens.output += num(turn.usage.output_tokens);
        row.tokens.cachedInput += num(turn.usage.cache_read_input_tokens);
        row.tokens.reasoningOutput += num(turn.usage.reasoning_output_tokens);
      }
    }
  }
  const out = [...rows.values()].map(({ sessionIds, ...r }) => ({ ...r, sessions: sessionIds.size, tokens: r.turnsWithTokens ? r.tokens : null }))
    .sort((a, b) => CODEX_KINDS.indexOf(a.kind) - CODEX_KINDS.indexOf(b.kind) || b.turns - a.turns || a.model.localeCompare(b.model));
  return { sessions: sessions.size, turns, apiKeyTurns, rows: out };
}

/**
 * records: full console session records (with turns). projectId: only that project's sessions (null: all).
 * -> { generatedAt, projectId, sessionsRead, windows: [{ id, label, since, sessions, turns, rows, answering }] }.
 * rows: one per kind and model, { kind, model, sessions, turns, turnsWithTokens, tokens | null, turnsWithCost,
 * costUsd | null }; tokens and costUsd are null when no turn of the row recorded them. answering: Claude Code's
 * modelUsage summed by the model that answered (sub-agents included), [] when no turn recorded it.
 * Every figure above is Claude Code's alone. Each window also has codex: the Codex sessions of the same window, apart
 * (tallyCodex), and the tally has codexSessionsRead.
 */
export function tallyUsage(records, { now = Date.now(), projectId = null } = {}) {
  const mine = (records || []).filter((r) => r && (!projectId || r.projectId === projectId));
  const list = mine.filter((r) => r.backend === 'claude-code');
  const codexList = mine.filter((r) => r.backend === 'codex');
  const windows = USAGE_WINDOWS.map((w) => {
    const since = now - w.ms;
    const rows = new Map(); // `${kind} ${model}` -> row
    const answering = new Map(); // reported model -> tokens and cost
    const sessions = new Set();
    let turns = 0;
    for (const rec of list) {
      const kind = sessionKind(rec);
      for (const turn of rec.turns || []) {
        if (turn.role === 'user' || turn.refused) continue;
        const at = Date.parse(turn.at);
        if (!(at > since && at <= now)) continue;
        const model = turnModel(rec, turn);
        const key = `${kind} ${model}`;
        if (!rows.has(key)) rows.set(key, { kind, model, sessionIds: new Set(), turns: 0, turnsWithTokens: 0, tokens: emptyTokens(), turnsWithCost: 0, costUsd: 0 });
        const row = rows.get(key);
        row.sessionIds.add(rec.id);
        row.turns++;
        sessions.add(rec.id);
        turns++;
        if (turn.usage && typeof turn.usage === 'object') {
          row.turnsWithTokens++;
          row.tokens.input += num(turn.usage.input_tokens);
          row.tokens.output += num(turn.usage.output_tokens);
          row.tokens.cacheRead += num(turn.usage.cache_read_input_tokens);
          row.tokens.cacheWrite += num(turn.usage.cache_creation_input_tokens);
        }
        if (typeof turn.costUsd === 'number') { row.turnsWithCost++; row.costUsd += turn.costUsd; }
        for (const [reported, u] of Object.entries(turn.modelUsage && typeof turn.modelUsage === 'object' ? turn.modelUsage : {})) {
          if (!u || typeof u !== 'object') continue;
          if (!answering.has(reported)) answering.set(reported, { model: reported, ...emptyTokens(), costUsd: 0 });
          const a = answering.get(reported);
          a.input += num(u.inputTokens);
          a.output += num(u.outputTokens);
          a.cacheRead += num(u.cacheReadInputTokens);
          a.cacheWrite += num(u.cacheCreationInputTokens);
          a.costUsd += num(u.costUSD);
        }
      }
    }
    const out = [...rows.values()].map(({ sessionIds, ...r }) => ({
      ...r, sessions: sessionIds.size,
      tokens: r.turnsWithTokens ? r.tokens : null,
      costUsd: r.turnsWithCost ? Math.round(r.costUsd * 1e6) / 1e6 : null,
    })).sort((a, b) => USAGE_KINDS.indexOf(a.kind) - USAGE_KINDS.indexOf(b.kind) || b.turns - a.turns || a.model.localeCompare(b.model));
    return {
      id: w.id, label: w.label, since: new Date(since).toISOString(), sessions: sessions.size, turns, rows: out,
      answering: [...answering.values()].map((a) => ({ ...a, costUsd: Math.round(a.costUsd * 1e6) / 1e6 })).sort((a, b) => b.output - a.output || a.model.localeCompare(b.model)),
      codex: tallyCodex(codexList, since, now),
    };
  });
  return { generatedAt: new Date(now).toISOString(), projectId: projectId || null, sessionsRead: list.length, codexSessionsRead: codexList.length, windows };
}

const n = (v) => Math.round(v).toLocaleString('en-US');
const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;
const KIND_WORDS = { worker: 'workers', companion: 'companion (manager)', other: 'other studio sessions' };
const tokenWords = (t) => `in ${n(t.input)}, out ${n(t.output)}, cache read ${n(t.cacheRead)}, cache write ${n(t.cacheWrite)}`;

/** One row as a line: the model, who ran on it, sessions and turns, then tokens and cost as recorded, or that they were not. */
export function usageRowWords(r) {
  const some = (have) => (have === r.turns ? '' : ` (recorded for ${have} of ${plural(r.turns, 'turn')})`);
  const tokens = r.tokens ? `tokens${some(r.turnsWithTokens)}: ${tokenWords(r.tokens)}` : 'tokens: not recorded';
  const cost = r.costUsd == null ? 'cost: not recorded' : `cost as Claude Code reported it${some(r.turnsWithCost)}: $${r.costUsd.toFixed(2)}`;
  return `- ${r.model} · ${KIND_WORDS[r.kind] || r.kind}: ${plural(r.sessions, 'session')}, ${plural(r.turns, 'turn')} · ${tokens} · ${cost}`;
}

const CODEX_KIND_WORDS = { worker: 'Codex workers', other: 'the Codex tab and other Codex sessions' };

/** One Codex row as a line: the model and effort, who ran on it, sessions and turns, the tokens Codex gave, and that it gives no cost. */
export function codexRowWords(r) {
  const some = r.turnsWithTokens === r.turns ? '' : ` (recorded for ${r.turnsWithTokens} of ${plural(r.turns, 'turn')})`;
  const tokens = r.tokens ? `tokens${some}: in ${n(r.tokens.input)} (of which cached ${n(r.tokens.cachedInput)}), out ${n(r.tokens.output)} (of which reasoning ${n(r.tokens.reasoningOutput)})` : 'tokens: not recorded';
  return `- ${r.model}${r.effort ? ` at ${r.effort} effort` : ''} · ${CODEX_KIND_WORDS[r.kind] || r.kind}: ${plural(r.sessions, 'session')}, ${plural(r.turns, 'turn')} · ${tokens} · cost: none (${CODEX_NO_COST})`;
}

/** The tally as the manager reads it (atelier_worker_usage). scope: whose sessions, in words. */
export function usageText(tally, { scope = 'every project' } = {}) {
  const out = [`Worker and companion usage of ${scope}, counted from the studio's own Claude Code session records (${plural(tally.sessionsRead, 'record')} read) at ${tally.generatedAt}.`];
  for (const w of tally.windows) {
    out.push('', `${w.label}: ${w.turns ? `${plural(w.sessions, 'session')}, ${plural(w.turns, 'turn')}, by model and who ran on it` : 'no turn of a studio Claude Code session ended in this window'}.`);
    out.push(...w.rows.map(usageRowWords));
    if (w.answering.length) out.push(`By the model that answered, sub-agents included (Claude Code's modelUsage): ${w.answering.map((a) => `${a.model} ${tokenWords(a)}`).join('; ')}.`);
    else if (w.turns) out.push('By the model that answered: not recorded (no turn in this window kept Claude Code\'s modelUsage).');
    // Codex, apart: its sessions and turns are in none of the counts above.
    const c = w.codex;
    if (c) {
      out.push(`Codex, counted apart (the person's Codex CLI login, not Claude Code's plan): ${c.turns ? `${plural(c.sessions, 'session')}, ${plural(c.turns, 'turn')}` : 'no turn of a studio Codex session ended in this window'}.`);
      out.push(...c.rows.map(codexRowWords));
      if (c.apiKeyTurns) out.push(`${n(c.apiKeyTurns)} of these turns ran on an API key saved in Codex, which OpenAI bills; the others ran on the ChatGPT login.`);
    }
  }
  out.push('', 'What this is not: the studio does not know the plan\'s limits or what is left of them, so judge from these counts and from what Claude Code itself tells the person. A turn counts when it ended, by the model Claude Code reported for it; a turn still running, a deleted session and Claude Code run in a terminal or outside the studio are not counted. Cost is the list-price figure in Claude Code\'s result event, not a charge on the plan.');
  if (tally.codexSessionsRead !== undefined) out.push(`Codex (${plural(tally.codexSessionsRead, 'session record')} read): ${CODEX_NO_COST}, so there is no cost figure for it, only sessions, turns and the tokens its turn.completed event gave. The studio does not know the ChatGPT plan's limits or what is left of them either; Codex run outside the studio is not counted.`);
  return out.join('\n');
}
