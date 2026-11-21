// The studio's own first references (docs/ARCHITECTURE.md section 25): nothing invented. Each entry is a link, a
// piece of code or a convention this repository already records, and its `source` line says where. The two links
// are the only public documentation addresses the sources name; their titles are fetched when they are added.
// scripts/seed-studio-references.mjs writes them once into the studio folder's .studio/references.json, and only
// into a list that holds nothing; from then on they are the person's to edit or remove.
import { addRef, listRefs } from './references.mjs';

export const STUDIO_REFERENCES = [
  { kind: 'link', url: 'https://code.claude.com/docs/en/authentication',
    useFor: 'how to sign in using the official Claude Code CLI',
    tags: ['claude code', 'sign-in'], source: 'server/lib/account-login.mjs' },
  { kind: 'link', url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    useFor: 'the prices of the bounded API utilities, per million tokens',
    tags: ['api', 'pricing'], source: 'server/api-utility/pricing.mjs (verified 2026-11-03); docs/evidence/VERIFICATION.md' },
  { kind: 'snippet', title: 'One write queue per project folder', language: 'js',
    text: [
      'const queues = new Map(); // project folder -> the end of its queue, so two writes never read the same list',
      'function queued(projectPath, run) {',
      '  const done = (queues.get(projectPath) || Promise.resolve()).then(run);',
      '  const tail = done.catch(() => {});',
      '  queues.set(projectPath, tail);',
      '  tail.then(() => { if (queues.get(projectPath) === tail) queues.delete(projectPath); });',
      '  return done;',
      '}',
    ].join('\n'),
    useFor: 'a new .studio record store: read, change and write inside queued(), so two requests at once lose neither',
    tags: ['records', 'server'], source: 'server/lib/rules.mjs, the same in inspiration.mjs and references.mjs' },
  { kind: 'note', title: 'The companion\'s tools',
    text: 'One MCP server over the studio\'s own HTTP API, shared by every brain: bin/atelier-mcp.mjs, MCP over stdio written by hand (JSON-RPC 2.0, protocol 2025-06-18), tools in server/lib/mcp/tools.mjs named atelier_<verb>_<noun>. Every tool talks to a running studio with fetch and answers plain text naming the project it acted on; nothing there pushes, deletes, restores, exports or spends on the API.',
    useFor: 'adding or changing an MCP tool', tags: ['mcp', 'tools'], source: 'docs/ARCHITECTURE.md section 11; the head of server/lib/mcp/tools.mjs' },
  { kind: 'note', title: 'Server conventions for a record',
    text: 'Every project file access goes through insideProject(); records are written atomically; status is derived from evidence (events, git), never set by a claim.',
    useFor: 'any server change that reads or writes a project\'s files or records', tags: ['records', 'server'], source: 'CLAUDE.md, Conventions' },
];

/** Write the seeds into a project that keeps no references yet, oldest first so the list reads in the order above.
 *  Answers { seeded } or { seeded: 0, kept } when the list already holds something. opts.preview: a test's own fetch. */
export async function seedReferences(projectPath, seeds = STUDIO_REFERENCES, opts = {}) {
  const have = await listRefs(projectPath);
  if (have.length) return { seeded: 0, kept: have.length };
  for (const seed of [...seeds].reverse()) await addRef(projectPath, seed, opts);
  return { seeded: seeds.length };
}
