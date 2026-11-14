// Fixed rules (docs/ARCHITECTURE.md section 23): what must stay the same in a project's design while everything
// else is free to change. Records live in <project>/.studio/rules.json as { rules: [...] } in the order they were
// added, on the pattern of the inspiration board (server/lib/inspiration.mjs). A rule is its text, a kind, an optional
// why, and optionally one locked design token: a CSS custom property and the value it keeps. Every path goes through
// insideProject(), and writes are atomic and queued per project folder.
import { HttpError, newId, nowIso, insideProject } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';

export const RULE_KINDS = ['color', 'type', 'layout', 'motion', 'tone', 'behaviour'];
export const MAX_RULES = 60;
export const TEXT_MAX = 200;
export const WHY_MAX = 300;
export const TOKEN_NAME_MAX = 64;
export const TOKEN_VALUE_MAX = 200;
export const RULE_ID = /^rule_[a-z0-9]{4,40}$/;
export const TOKEN_NAME = /^--[A-Za-z0-9_][A-Za-z0-9_-]*$/;
export const RULES_FILE = '.studio/rules.json';
export const LIMITS = { rules: MAX_RULES, text: TEXT_MAX, why: WHY_MAX, tokenName: TOKEN_NAME_MAX, tokenValue: TOKEN_VALUE_MAX };

const rulesFile = (projectPath) => insideProject(projectPath, RULES_FILE, { allowStudio: true });
const bad = (message) => new HttpError(400, 'invalid_input', message);
const notFound = (id) => new HttpError(404, 'not_found', `Rule ${String(id).slice(0, 60)} is not one of this project's fixed rules`);
const isId = (id) => typeof id === 'string' && RULE_ID.test(id);
const shown = (v, max = 40) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const queues = new Map(); // project folder -> the end of its queue, so two writes never read the same list
function queued(projectPath, run) {
  const done = (queues.get(projectPath) || Promise.resolve()).then(run);
  const tail = done.catch(() => {});
  queues.set(projectPath, tail);
  tail.then(() => { if (queues.get(projectPath) === tail) queues.delete(projectPath); });
  return done;
}

// ---------- fields ----------
const oneLine = (v, max, name) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw bad(`${name} is at most ${max} characters; this one is ${s.length}`);
  return s;
};

function checkText(v) {
  const s = oneLine(v, TEXT_MAX, 'A rule');
  if (!s) throw bad('A rule needs its words: one sentence saying what must stay the same');
  return s;
}

export function checkKind(v) {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (k === 'behavior') return 'behaviour';
  if (!RULE_KINDS.includes(k)) throw bad(`Choose what kind of rule it is: ${RULE_KINDS.join(', ')}`);
  return k;
}

/** A CSS custom property name as typed (names are case sensitive): two dashes, then letters, digits, - or _. */
export function checkTokenName(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!TOKEN_NAME.test(s) || s.length > TOKEN_NAME_MAX) {
    throw bad(`A locked token is a CSS custom property such as --accent: two dashes, then letters, digits, - or _ (at most ${TOKEN_NAME_MAX} characters); "${shown(v)}" is not one`);
  }
  return s;
}

/** Quotes and parentheses close, in order; a quote hides what is inside it. */
function closes(s) {
  let depth = 0;
  let quote = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0 && !quote;
}

/**
 * The value a locked token keeps: one CSS value on one line. It is written into style sheets and briefs as it is, so
 * nothing that could end the declaration, open another, hide text or load a file is taken: no ; { } < > \ or !, no
 * comment, no url() or the like, and every quote and parenthesis closes.
 */
export function checkTokenValue(v) {
  if (typeof v !== 'string' || !v.trim()) throw bad('A locked token needs its value, such as #d6a455 or 140ms');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw bad('A token\'s value is plain text on one line; this one holds a control character');
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > TOKEN_VALUE_MAX) throw bad(`A token's value is at most ${TOKEN_VALUE_MAX} characters; this one is ${s.length}`);
  const stop = s.match(/[;{}<>\\!]/);
  if (stop) throw bad(`A token's value is one CSS value: it cannot hold ${stop[0]} (nor any of ; { } < > \\ !)`);
  if (s.includes('/*') || s.includes('*/')) throw bad('A token\'s value cannot hold a comment (/* or */)');
  if (/(^|[^a-z0-9_-])(url|src|image|image-set|cross-fade|element|paint|expression|attr|env)\s*\(/i.test(s) || s.includes('@')) {
    throw bad('A token\'s value cannot load or read anything: no url(), image-set(), attr(), env() or @ rule; give the value itself');
  }
  if (!closes(s)) throw bad('A token\'s value must close every quote and parenthesis it opens');
  return s;
}

/** { name, value } checked, or null for no lock (null, or both fields empty). One without the other is refused. */
export function checkToken(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('token must be { name, value }, or null for no locked token');
  const blank = (x) => x == null || (typeof x === 'string' && !x.trim());
  if (blank(v.name) && blank(v.value)) return null;
  if (blank(v.value)) throw bad(`A locked token needs both its name and its value; ${shown(v.name)} has no value`);
  if (blank(v.name)) throw bad('A locked token needs both its name and its value; this value has no name (such as --accent)');
  return { name: checkTokenName(v.name), value: checkTokenValue(v.value) };
}

// ---------- the list ----------
const validRule = (r) => r && typeof r === 'object' && isId(r.id) && typeof r.text === 'string' && RULE_KINDS.includes(r.kind);
const hasToken = (r) => !!(r.token && typeof r.token.name === 'string' && typeof r.token.value === 'string');

/** Every rule of the project in the order it was added. A missing file is no rules; an entry that is not a rule is left out. */
export async function listRules(projectPath) {
  const data = await readJson(rulesFile(projectPath), { rules: [] });
  return (Array.isArray(data?.rules) ? data.rules : []).filter(validRule).map((r) => ({ ...r, token: hasToken(r) ? { name: r.token.name, value: r.token.value } : null }));
}
const save = (projectPath, rules) => writeJson(rulesFile(projectPath), { rules });

/** The tokens the rules lock, one entry per rule that locks one: [{ name, value, ruleId, text }]. What a settings
 *  screen or a worker must leave at this value. */
export const lockedTokens = (rules) => rules.filter(hasToken).map((r) => ({ name: r.token.name, value: r.token.value, ruleId: r.id, text: r.text }));

/** GET's answer: the rules, the kinds in their order, the limits the client names in its own sentences, the locks. */
export async function rulesAnswer(projectPath) {
  const rules = await listRules(projectPath);
  return { rules, kinds: [...RULE_KINDS], limits: { ...LIMITS }, locked: lockedTokens(rules), where: { file: RULES_FILE } };
}

/** One token, one rule: a second rule locking the same property would give it two answers. */
function checkFree(rules, token, exceptId = null) {
  const other = token ? rules.find((r) => r.id !== exceptId && hasToken(r) && r.token.name === token.name) : null;
  if (other) throw new HttpError(409, 'token_locked', `${token.name} is already locked to ${other.token.value} by the rule "${shown(other.text, 80)}"; change that rule, or take its lock off first`);
}

/** Add a rule. body: { text, kind, why?, token?: { name, value } }. It goes last. */
export async function addRule(projectPath, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const now = nowIso();
  const rule = { id: newId('rule'), text: checkText(b.text), kind: checkKind(b.kind), why: oneLine(b.why, WHY_MAX, 'why'), token: checkToken(b.token), createdAt: now, updatedAt: now };
  return queued(projectPath, async () => {
    const rules = await listRules(projectPath);
    if (rules.length >= MAX_RULES) throw new HttpError(409, 'rules_full', `A project keeps at most ${MAX_RULES} fixed rules; remove one first`);
    checkFree(rules, rule.token);
    rules.push(rule);
    await save(projectPath, rules);
    return rule;
  });
}

/** Change a rule in place: any of text, kind, why, token (null takes the lock off). */
export async function patchRule(projectPath, id, body) {
  if (!isId(id)) throw notFound(id);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const has = (k) => Object.hasOwn(b, k);
  const patch = {};
  if (has('text')) patch.text = checkText(b.text);
  if (has('kind')) patch.kind = checkKind(b.kind);
  if (has('why')) patch.why = oneLine(b.why, WHY_MAX, 'why');
  if (has('token')) patch.token = checkToken(b.token);
  return queued(projectPath, async () => {
    const rules = await listRules(projectPath);
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw notFound(id);
    if (has('token')) checkFree(rules, patch.token, id);
    Object.assign(rule, patch, { updatedAt: nowIso() });
    await save(projectPath, rules);
    return rule;
  });
}

export async function removeRule(projectPath, id) {
  if (!isId(id)) throw notFound(id);
  return queued(projectPath, async () => {
    const rules = await listRules(projectPath);
    if (!rules.some((r) => r.id === id)) throw notFound(id);
    await save(projectPath, rules.filter((r) => r.id !== id));
    return { removed: id };
  });
}

// ---------- words: the briefing's section, the brief's section, the companion's tool ----------
/** "9 rules (4 lock a design token)", "1 rule", or "no rules". */
export function rulesCount(rules) {
  if (!rules.length) return 'no rules';
  const locks = rules.filter(hasToken).length;
  return `${rules.length} rule${rules.length === 1 ? '' : 's'}${locks ? ` (${locks} lock${locks === 1 ? 's' : ''} a design token)` : ''}`;
}

/** The rules by kind in the kinds' own order, the order they were added within a kind. */
export const byKind = (rules) => RULE_KINDS.flatMap((k) => rules.filter((r) => r.kind === k));

/** One rule in one line: its kind, its words, the token it locks, why. full: the companion's tool, which also gets the id. */
export function ruleLine(r, { full = false } = {}) {
  return `${r.kind}${full ? ` ${r.id}` : ''} · ${r.text}${hasToken(r) ? ` · locked: \`${r.token.name}: ${r.token.value}\`` : ''}${r.why ? ` · why: ${r.why}` : ''}`;
}

/** The brief's lines under "Must stay the same": what the rules are for and what to do when one is in the way, then
 *  every rule by kind. With no rules, one sentence saying so. */
export function briefLines(rules) {
  if (!rules.length) return [`No fixed rules are recorded for this project (\`${RULES_FILE}\`; the studio's Inspiration view keeps them under Fixed rules).`];
  return [
    `The project's fixed rules: ${rulesCount(rules)} in \`${RULES_FILE}\`. They are the person's, and only the person changes them; everything else is free to change. Keep to every one in this task, and leave a locked token at its exact value. If the request cannot be done without breaking one, or asks to change one, ask with task question instead of breaking it.`,
    ...byKind(rules).map((r) => `- ${ruleLine(r)}`),
  ];
}

/** The briefing's lines under "Must stay the same": the count, where the rules live and the tool, then the rules. */
export function briefingLines(rules) {
  if (!rules.length) return [`- _no fixed rules yet_ (\`${RULES_FILE}\`; the studio's Inspiration view keeps them under Fixed rules)`];
  return [
    `The project's fixed rules: ${rulesCount(rules)} in \`${RULES_FILE}\`; atelier_read_rules reads them. Keep to them unless the person says otherwise; a locked token keeps its exact value.`,
    ...byKind(rules).map((r) => `- ${ruleLine(r)}`),
  ];
}

/** The rules for a brief, never a reason not to write one: a list that cannot be read says so instead of reading as none. */
export async function briefRules(projectPath) {
  try { return briefLines(await listRules(projectPath)); } catch { return [`The project's fixed rules could not be read from \`${RULES_FILE}\`. Ask with task question before changing the look.`]; }
}
