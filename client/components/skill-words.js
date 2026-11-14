// Claude Code skills, the pure parts shared by the server (server/lib/skills.mjs) and the Skills tab
// (components/skills-panel.js): the SKILL.md frontmatter reader, the category table and its inference, grouping,
// the filter and the words for where a skill lives. No DOM, no file access.

/** The categories in the order the tab shows them. Other is last and catches what no keyword names. */
export const CATEGORIES = ['Design', 'UX', 'Backend', 'Frontend/Code', 'Testing & review', 'Docs & writing', 'Other'];

// Keywords per category, matched as whole words (a trailing s is allowed) in the name and the description.
// A word in the name counts three times as much as one in the description; ties go to the earlier category.
export const KEYWORDS = {
  Design: ['design', 'visual', 'ui', 'layout', 'colour', 'color', 'palette', 'typography', 'font', 'animation',
    'motion', 'art', 'illustration', 'icon', 'brand', 'branding', 'style', 'theme', 'chart', 'dataviz', 'graphic',
    'logo', 'figma', 'svg', 'image', 'canvas', 'aesthetic', 'mockup', 'slide', 'deck', 'presentation'],
  UX: ['ux', 'flow', 'journey', 'usability', 'accessibility', 'a11y', 'onboarding', 'copy', 'microcopy', 'wording',
    'user research', 'persona', 'interaction', 'navigation', 'wireframe', 'information architecture', 'empty state'],
  'Frontend/Code': ['frontend', 'front-end', 'react', 'vue', 'svelte', 'css', 'html', 'javascript', 'typescript',
    'component', 'browser', 'dom', 'web app', 'coding', 'refactor', 'build', 'bundler', 'cli', 'script',
    'keybinding', 'config', 'configure', 'setup', 'set up', 'git', 'plugin', 'hook', 'subagent', 'command',
    'slash command', 'frontmatter', 'automation'],
  Backend: ['backend', 'back-end', 'api', 'server', 'database', 'db', 'sql', 'postgres', 'auth', 'authentication',
    'oauth', 'infrastructure', 'infra', 'deploy', 'deployment', 'docker', 'kubernetes', 'cloud', 'queue', 'cache',
    'endpoint', 'webhook', 'mcp', 'sdk', 'cron', 'storage', 'token', 'bot'],
  'Testing & review': ['test', 'testing', 'tests', 'review', 'reviewer', 'qa', 'debug', 'debugging', 'verify',
    'verification', 'audit', 'security', 'lint', 'coverage', 'regression', 'eval', 'evals', 'benchmark'],
  'Docs & writing': ['doc', 'docs', 'documentation', 'writing', 'write', 'writer', 'readme', 'guide', 'report',
    'article', 'blog', 'essay', 'notes', 'changelog', 'release notes', 'pdf', 'docx', 'word', 'markdown', 'research',
    'summary', 'summarize', 'letter', 'email'],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.fromEntries(Object.entries(KEYWORDS).map(([cat, words]) =>
  [cat, words.map((w) => new RegExp(`(?:^|[^a-z0-9])${esc(w).replace(/ /g, '[\\s_-]+')}s?(?=$|[^a-z0-9])`, 'i'))]));

/** The category a skill's own field names, matched loosely ("design", "Testing", "docs", "front-end"), else null. */
export function categoryFromField(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : String(value).split(',');
  for (const raw of list) {
    const v = String(raw).trim().toLowerCase().replace(/[^a-z0-9& /-]/g, '');
    if (!v) continue;
    const exact = CATEGORIES.find((c) => c.toLowerCase() === v);
    if (exact) return exact;
    for (const cat of CATEGORIES.slice(0, -1)) if (PATTERNS[cat].some((re) => re.test(v))) return cat;
  }
  return null;
}

/** Score each category by its keywords in the name (x3) and the description (x1); the best wins, Other when none. */
export function inferCategory(name = '', description = '') {
  const n = String(name || '').replace(/[-_]+/g, ' ');
  const d = String(description || '');
  let best = 'Other';
  let top = 0;
  for (const cat of CATEGORIES.slice(0, -1)) {
    let score = 0;
    for (const re of PATTERNS[cat]) {
      if (re.test(n)) score += 3;
      if (re.test(d)) score += 1;
    }
    if (score > top) { top = score; best = cat; }
  }
  return best;
}

/** A skill's category and how it was found: its own category field, then its tags, then the keywords. */
export function categoryOf(meta = {}) {
  const own = categoryFromField(meta.category);
  if (own) return { category: own, from: 'category' };
  const tagged = categoryFromField(meta.tags);
  if (tagged) return { category: tagged, from: 'tags' };
  return { category: inferCategory(meta.name, meta.description), from: 'keywords' };
}

const unquote = (v) => {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1)) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  if ((s.startsWith("'") && s.endsWith("'") && s.length > 1)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};

/**
 * Read the YAML frontmatter at the top of a SKILL.md: plain `key: value`, quoted values, folded (>) and literal (|)
 * blocks, indented continuation lines, and lists as [a, b] or `- item` lines. Answers { meta, body, hasFrontmatter }.
 * Enough for skill files; not a YAML parser.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src, hasFrontmatter: false };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    const more = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^\s*-\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      if (lines[i + 1].trim() === '' && !(i + 2 < lines.length && /^\s+\S/.test(lines[i + 2]))) { i++; continue; }
      more.push(lines[++i]);
    }
    if (/^[>|][+-]?$/.test(value)) {
      const parts = more.map((l) => l.trim());
      meta[key] = value.startsWith('>') ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else if (!value && more.length && more.every((l) => /^\s*-\s/.test(l) || !l.trim())) {
      meta[key] = more.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s/, '')));
    } else if (/^\[.*\]$/.test(value)) {
      meta[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      meta[key] = [unquote(value), ...more.map((l) => l.trim())].filter(Boolean).join(' ');
    }
  }
  return { meta, body: src.slice(m[0].length), hasFrontmatter: true };
}

/** A skill's folder name as Claude Code reads it: letters, digits, dot, dash, underscore, not starting with a dot. */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why a SKILL.md cannot be installed, in the person's words, or null when it can. */
export function skillProblem(meta, hasFrontmatter) {
  if (!hasFrontmatter) return 'SKILL.md has no frontmatter: it must start with --- and name: and description: lines.';
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) return 'SKILL.md has no name: in its frontmatter.';
  if (!SKILL_NAME.test(name)) return `The name "${name.slice(0, 80)}" cannot be a folder name: use letters, digits, dots, dashes or underscores (at most 64).`;
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) return 'SKILL.md has no description: in its frontmatter; Claude reads it to decide when to use the skill.';
  return null;
}

/** The first sentence or line of a description, cut to `max` characters. */
export function oneLine(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(s)?.[1] || s;
  return sentence.length > max ? `${sentence.slice(0, max - 1).replace(/[\s,;:.]+$/, '')}…` : sentence;
}

/** The source chip's words and its long form for a skill's source record { kind, plugin }. */
export function sourceWords(source = {}) {
  if (source.kind === 'project') return { chip: 'Project', where: 'this project\'s .claude/skills folder' };
  if (source.kind === 'user') return { chip: 'Your skills', where: 'your own skills folder, for every project' };
  if (source.kind === 'plugin') return { chip: `Plugin ${source.plugin || ''}`.trim(), where: `the installed Claude Code plugin ${source.plugin || ''}`.trim() };
  return { chip: 'Unknown', where: 'an unknown place' };
}

/** Skills whose name, description, category or source holds every word of the filter. */
export function filterSkills(skills, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return skills;
  return skills.filter((s) => {
    const hay = `${s.name} ${s.description} ${s.category} ${sourceWords(s.source).chip}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** [[category, skills]] in CATEGORIES order, empty categories left out, skills by name inside each. */
export function groupSkills(skills) {
  const by = new Map(CATEGORIES.map((c) => [c, []]));
  for (const s of skills) (by.get(s.category) || by.get('Other')).push(s);
  return [...by].filter(([, list]) => list.length).map(([c, list]) => [c, [...list].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))]);
}
