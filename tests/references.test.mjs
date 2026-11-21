// References (t_yrm68pllr3; docs/ARCHITECTURE.md section 25). Risks covered: an entry of each kind is stored in
// .studio/references.json as written and survives edit and removal; a link's title comes through the guarded fetch
// with no image asked for, and a private address is refused with a sentence that writes nothing; oversize text is
// refused (413) and writes nothing; two writes at once lose neither; a brief lists only the entries that match the
// request, tag matches first, capped, and says so when none matches; the briefing names the count; the watcher
// reports a hand edit; and through a real server process the routes, two projects kept apart, a new task's brief and
// atelier_read_references with a tag, a search and one entry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { addRef, patchRef, removeRef, listRefs, refsAnswer, checkText, checkLanguage, checkTitle, checkKind, refsCount, refLine, refFull, fenced, wordsOf, matchRefs, briefLines, briefRefs, briefingLine, taskWords, findRefs, REF_KINDS, REF_ID, MAX_REFS, TEXT_MAX, TITLE_MAX, BRIEF_REFS, BRIEF_SNIPPET_CHARS } from '../server/lib/references.mjs';
import { STUDIO_REFERENCES, seedReferences } from '../server/lib/references-seed.mjs';
import { fetchLinkPreview, isPrivateAddress } from '../server/lib/link-preview.mjs';
import { renderBrief } from '../server/lib/tasks.mjs';
import { watchEvent } from '../server/lib/watch-events.mjs';
import { createTools } from '../server/lib/mcp/tools.mjs';
import { handleMessage } from '../server/lib/mcp/stdio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpProject = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-refs-'));
  await fsp.mkdir(path.join(dir, '.studio'), { recursive: true });
  return dir;
};
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const stored = async (dir) => JSON.parse(await fsp.readFile(path.join(dir, '.studio', 'references.json'), 'utf8'));
const page = (title) => async () => ({ ok: true, url: 'https://example.com/x', title, description: 'What the page says.', site: 'Example Docs', image: null });

// ---------- the store ----------
test('references: a link, a snippet, a prompt and a note; kept in .studio/references.json newest first; edit and remove', async () => {
  const dir = await tmpProject();
  try {
    assert.deepEqual(await listRefs(dir), [], 'no file yet is no entries');
    const asked = [];
    const link = await addRef(dir, { kind: 'Link', url: 'https://example.com/docs/mcp', useFor: '  the companion\'s   tools ', tags: ['MCP', '#docs', 'mcp'], source: 'docs/ARCHITECTURE.md section 11' }, { preview: async (url, opts) => { asked.push([url, opts]); return (await page('Model Context Protocol: tools'))(); } });
    assert.match(link.id, REF_ID);
    assert.deepEqual(asked, [['https://example.com/docs/mcp', { image: false }]], 'the title is asked for with no image');
    assert.deepEqual([link.kind, link.url, link.title, link.site, link.description, link.preview.ok], ['link', 'https://example.com/docs/mcp', 'Model Context Protocol: tools', 'Example Docs', 'What the page says.', true]);
    assert.deepEqual([link.useFor, link.tags, link.source], ['the companion\'s tools', ['mcp', 'docs'], 'docs/ARCHITECTURE.md section 11']);
    const snippet = await addRef(dir, { kind: 'snippet', title: ' Atomic   write ', language: 'JS', text: '\n\r\n  const tmp = `${file}.tmp`;\r\n  await rename(tmp, file);\n\n  ' });
    assert.deepEqual([snippet.title, snippet.language, snippet.text], ['Atomic write', 'js', '  const tmp = `${file}.tmp`;\n  await rename(tmp, file);'], 'the code keeps its indentation; line ends become \\n; the blank lines around it go');
    const prompt = await addRef(dir, { kind: 'prompt', title: 'Review a diff', text: '  Review this diff for correctness.\nName each fault with its line.  ' });
    assert.equal(prompt.text, 'Review this diff for correctness.\nName each fault with its line.');
    const note = await addRef(dir, { kind: 'note', text: 'Chips are for states only.' });
    assert.deepEqual([note.title, note.text], ['', 'Chips are for states only.'], 'a note may have no title');
    const file = await stored(dir);
    assert.deepEqual(Object.keys(file), ['entries']);
    assert.deepEqual(file.entries.map((e) => e.id), [note.id, prompt.id, snippet.id, link.id], 'a new entry goes first');
    assert.deepEqual(Object.keys(file.entries[2]), ['id', 'kind', 'title', 'text', 'language', 'useFor', 'source', 'tags', 'createdAt', 'updatedAt']);
    assert.deepEqual(Object.keys(file.entries[3]), ['id', 'kind', 'title', 'url', 'description', 'site', 'preview', 'useFor', 'source', 'tags', 'createdAt', 'updatedAt']);

    const edited = await patchRef(dir, snippet.id, { useFor: 'every record write', tags: ['records'] });
    assert.deepEqual([edited.useFor, edited.tags, edited.title, edited.text, edited.createdAt], ['every record write', ['records'], 'Atomic write', snippet.text, snippet.createdAt], 'only what was sent changes');
    assert.equal((await patchRef(dir, note.id, { title: 'Chips' })).title, 'Chips');
    // A link whose address changes gets the new page's title; a typed title stays; an emptied one asks the page again.
    const moved = await patchRef(dir, link.id, { url: 'https://example.com/docs/tools' }, { preview: page('Tools') });
    assert.deepEqual([moved.url, moved.title], ['https://example.com/docs/tools', 'Tools']);
    assert.equal((await patchRef(dir, link.id, { title: 'MCP tools, the spec' }, { preview: () => { throw new Error('not asked'); } })).title, 'MCP tools, the spec', 'a title alone fetches nothing');
    assert.equal((await patchRef(dir, link.id, { title: '', refetch: true }, { preview: page('Tools again') })).title, 'Tools again');
    const failed = await patchRef(dir, link.id, { refetch: true }, { preview: async () => ({ ok: false, reason: 'No preview: the page answered 403' }) });
    assert.deepEqual([failed.title, failed.preview.ok, failed.preview.reason], ['Tools again', false, 'No preview: the page answered 403'], 'a page that refuses leaves the title and says why');
    const answer = await refsAnswer(dir);
    assert.deepEqual([answer.kinds, answer.where, answer.entries.length, answer.limits.entries, answer.limits.text], [REF_KINDS, { file: '.studio/references.json' }, 4, MAX_REFS, TEXT_MAX]);

    assert.deepEqual(await removeRef(dir, prompt.id), { removed: prompt.id });
    assert.deepEqual((await listRefs(dir)).map((e) => e.id), [note.id, snippet.id, link.id]);
    await assert.rejects(() => removeRef(dir, prompt.id), { status: 404 });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a link whose page gives nothing is still kept, as a plain link that says why', async () => {
  const dir = await tmpProject();
  try {
    const plain = await addRef(dir, { kind: 'link', url: 'https://smith.example.com/docs' }, { preview: async () => ({ ok: false, reason: 'No preview: it did not answer within 8 s' }) });
    assert.deepEqual([plain.title, plain.site, plain.preview.ok, plain.preview.reason], ['', 'smith.example.com', false, 'No preview: it did not answer within 8 s']);
    const typed = await addRef(dir, { kind: 'link', url: 'https://example.com/a', title: 'My own name' }, { preview: page('The page\'s name') });
    assert.equal(typed.title, 'My own name', 'a typed title wins');
    assert.equal((await addRef(dir, { kind: 'link', url: 'https://example.com/b' }, { preview: page('t'.repeat(200)) })).title.length, TITLE_MAX, 'a fetched title is cut to the limit');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('refusals are sentences and write nothing: unsafe links, oversize text, a missing title, a bad language, too many tags', async () => {
  const dir = await tmpProject();
  try {
    const kept = await addRef(dir, { kind: 'note', text: 'kept' });
    const before = await fsp.readFile(path.join(dir, '.studio', 'references.json'), 'utf8');
    const refused = async (body, status, code, words) => {
      await assert.rejects(() => addRef(dir, body, { preview: () => { throw new Error('a refused link is never fetched'); } }), (err) => err.status === status && err.code === code && words.test(err.message), JSON.stringify(body).slice(0, 80));
    };
    await refused({ kind: 'link', url: 'http://127.0.0.1:4747/api/state' }, 400, 'unsafe_link', /private or local address \(127\.0\.0\.1\); the studio does not fetch or keep those/);
    await refused({ kind: 'link', url: 'http://localhost/' }, 400, 'unsafe_link', /private or local address \(localhost\)/);
    await refused({ kind: 'link', url: 'http://169.254.169.254/latest/meta-data/' }, 400, 'unsafe_link', /private or local/);
    await refused({ kind: 'link', url: 'http://[::1]/' }, 400, 'unsafe_link', /private or local/);
    await refused({ kind: 'link', url: 'file:///C:/Windows/win.ini' }, 400, 'unsafe_link', /Only http and https links/);
    await refused({ kind: 'link', url: 'https://user:pw@example.com/' }, 400, 'unsafe_link', /user name or password/);
    await refused({ kind: 'link', url: '' }, 400, 'invalid_input', /needs a url/);
    await refused({ kind: 'snippet', title: 'Big', text: 'x'.repeat(TEXT_MAX.snippet + 1) }, 413, 'too_large', /^A snippet is at most 20,000 characters; this one is 20,001\. Keep the part to build from, or link to the rest\.$/);
    await refused({ kind: 'prompt', title: 'Big', text: 'x'.repeat(TEXT_MAX.prompt + 5) }, 413, 'too_large', /^A prompt is at most 8,000 characters; this one is 8,005\./);
    await refused({ kind: 'note', text: 'x'.repeat(TEXT_MAX.note + 1) }, 413, 'too_large', /^A note is at most 4,000 characters/);
    await refused({ kind: 'snippet', text: 'const a = 1;' }, 400, 'invalid_input', /^A snippet needs a title to find it by$/);
    await refused({ kind: 'prompt', title: '  ', text: 'Do it.' }, 400, 'invalid_input', /^A prompt needs a title to find it by$/);
    await refused({ kind: 'snippet', title: 'No code', text: '   \n ' }, 400, 'invalid_input', /^A snippet needs its code$/);
    await refused({ kind: 'note', text: '' }, 400, 'invalid_input', /^A note needs its words$/);
    await refused({ kind: 'note', text: 'bell \u0007 here' }, 400, 'invalid_input', /plain text; this one holds a control character/);
    await refused({ kind: 'snippet', title: 'T', text: 'x', language: 'java script' }, 400, 'invalid_input', /A language is one short word such as js, css or bash/);
    await refused({ kind: 'note', text: 'x', title: 't'.repeat(TITLE_MAX + 1) }, 400, 'invalid_input', /A title is at most 120 characters; this one is 121/);
    await refused({ kind: 'note', text: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, 400, 'invalid_input', /^a reference takes at most 6 tags; this one names 7$/);
    await refused({ kind: 'note', text: 'x', tags: ['a,b'] }, 400, 'invalid_input', /a tag has no comma/);
    await refused({ kind: 'image', text: 'x' }, 400, 'invalid_input', /Choose what the reference is: link, snippet, prompt, note/);
    await refused({ text: 'x' }, 400, 'invalid_input', /Choose what the reference is/);
    await assert.rejects(() => patchRef(dir, kept.id, { kind: 'prompt' }), { status: 400, message: 'A reference keeps its kind; this one is a note' });
    await assert.rejects(() => patchRef(dir, kept.id, { text: 'x'.repeat(TEXT_MAX.note + 1) }), { status: 413 });
    await assert.rejects(() => patchRef(dir, 'ref_nothere1234', { title: 'x' }), { status: 404 });
    await assert.rejects(() => patchRef(dir, '../project', { title: 'x' }), { status: 404 });
    await assert.rejects(() => removeRef(dir, 'rule_abcd1234'), { status: 404 });
    assert.equal(await fsp.readFile(path.join(dir, '.studio', 'references.json'), 'utf8'), before, 'no refusal wrote anything');
    // The checks on their own.
    assert.equal(checkKind(' NOTE '), 'note');
    assert.equal(checkLanguage(' C++ '), 'c++');
    assert.equal(checkLanguage(''), '');
    assert.equal(checkTitle('', 'note'), '');
    assert.equal(checkText('a\r\nb\rc  \n\n', 'note'), 'a\nb\nc');
    assert.equal(checkText('\tkeeps a tab', 'snippet'), '\tkeeps a tab');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('two writes at once lose neither; a full list refuses the next; a damaged entry is left out', async () => {
  const dir = await tmpProject();
  try {
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => addRef(dir, { kind: 'note', text: `note ${i}` })));
    assert.equal(new Set((await listRefs(dir)).map((e) => e.id)).size, 12);
    await Promise.all([patchRef(dir, made[0].id, { title: 'a' }), patchRef(dir, made[1].id, { title: 'b' }), removeRef(dir, made[2].id)]);
    const now = await listRefs(dir);
    assert.deepEqual([now.length, now.find((e) => e.id === made[0].id).title, now.find((e) => e.id === made[1].id).title], [11, 'a', 'b']);
    const full = Array.from({ length: MAX_REFS }, (_, i) => ({ id: `ref_full${String(i).padStart(4, '0')}`, kind: 'note', title: '', text: `n${i}`, useFor: '', source: '', tags: [] }));
    await fsp.writeFile(path.join(dir, '.studio', 'references.json'), JSON.stringify({ entries: [...full, { id: 'nope', kind: 'note', text: 'bad id' }, { id: 'ref_nokind01', text: 'no kind' }, { id: 'ref_nourl001', kind: 'link' }, { id: 'ref_script01', kind: 'link', url: 'javascript:alert(1)', title: 'Docs' }, null] }));
    assert.equal((await listRefs(dir)).length, MAX_REFS, 'what is not an entry is left out, a link that is no http(s) address too');
    await assert.rejects(() => addRef(dir, { kind: 'note', text: 'one more' }), { status: 409, code: 'references_full', message: /at most 300 references; remove one first/ });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------- the title through the guarded fetch, against a server of this test ----------
let site;
let siteBase;
const requests = [];
const loopbackOnly = (ip) => ip !== '127.0.0.1' && isPrivateAddress(ip); // everything private but this test's own server
before(async () => {
  site = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/docs') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><head><title>Docs &amp; guides</title><meta property="og:site_name" content="Example"><meta property="og:image" content="/og.png"></head><body>hi</body></html>'); }
    if (req.url === '/to-private') { res.writeHead(302, { location: 'http://10.0.0.7/admin' }); return res.end(); }
    res.writeHead(404, {}); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteBase = `http://127.0.0.1:${site.address().port}`;
});
after(() => { site?.closeAllConnections?.(); site?.close(); });

test('a reference link reads the page\'s title through the guard and never asks for its preview image', async () => {
  const dir = await tmpProject();
  try {
    const preview = (url, opts) => fetchLinkPreview(url, { ...opts, guard: loopbackOnly });
    // The store's own check refuses this test's loopback address, so the fetch is tried directly, then through addRef by a public name.
    const got = await preview(`${siteBase}/docs`, { image: false });
    assert.deepEqual([got.ok, got.title, got.site, got.image], [true, 'Docs & guides', 'Example', null]);
    assert.deepEqual(requests, ['/docs'], 'the page alone was asked for: no /og.png');
    const withImage = await fetchLinkPreview(`${siteBase}/docs`, { guard: loopbackOnly });
    assert.equal(withImage.image, null, 'the board\'s fetch still asks (here the image is a 404)');
    assert.ok(requests.includes('/og.png'));
    const away = await preview(`${siteBase}/to-private`, { image: false });
    assert.deepEqual([away.ok, away.reason], [false, 'No preview: it redirects to a private or local address, which the studio does not follow']);
    await assert.rejects(() => addRef(dir, { kind: 'link', url: `${siteBase}/docs` }), { status: 400, code: 'unsafe_link' }, 'the store itself refuses a loopback address before any fetch');
    const entry = await addRef(dir, { kind: 'link', url: 'https://docs.example.com/guide' }, { preview: (url, opts) => preview(`${siteBase}/docs`, opts) });
    assert.deepEqual([entry.url, entry.title, entry.site], ['https://docs.example.com/guide', 'Docs & guides', 'Example'], 'the address stays the one the person gave');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------- the words ----------
const REFS = [
  { id: 'ref_note0001', kind: 'note', title: '', text: 'Chips are for states only; kinds and modes are plain words.', useFor: '', source: 'docs/DESIGN.md section 1', tags: [], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z' },
  { id: 'ref_prompt01', kind: 'prompt', title: 'Review a diff', text: 'Review this diff for correctness.\nName each fault with its line.', useFor: 'a second opinion before a version is kept', source: '', tags: ['review'], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z' },
  { id: 'ref_snip0001', kind: 'snippet', title: 'Atomic JSON write', text: 'const tmp = `${file}.tmp`;\nawait fsp.writeFile(tmp, text);\nawait fsp.rename(tmp, file);', language: 'js', useFor: 'every record write', source: 'server/lib/fsutil.mjs', tags: ['records', 'file system'], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z' },
  { id: 'ref_link0001', kind: 'link', title: 'MCP tools', url: 'https://example.com/docs/mcp', description: 'How a server lists and runs tools.', site: 'Example Docs', preview: { ok: true }, useFor: 'the companion\'s tools', source: 'docs/ARCHITECTURE.md section 11', tags: ['mcp'], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z' },
  { id: 'ref_link0002', kind: 'link', title: '', url: 'https://example.com/pricing', description: '', site: 'example.com', preview: { ok: false, reason: 'No preview: the page answered 403' }, useFor: '', source: '', tags: [], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z' },
];

test('the count, the briefing\'s line and one entry in one line', () => {
  assert.equal(refsCount(REFS), '5 entries (2 links, 1 snippet, 1 prompt, 1 note)');
  assert.equal(refsCount([REFS[0]]), '1 entry (1 note)');
  assert.equal(refsCount([]), 'no entries');
  assert.equal(briefingLine(REFS), 'References: 5 entries (2 links, 1 snippet, 1 prompt, 1 note) in `.studio/references.json`; atelier_read_references searches them');
  assert.equal(briefingLine([]), "References: none yet (`.studio/references.json`; the studio's Inspiration view keeps them under References)");
  assert.equal(refLine(REFS[3]), 'link ref_link0001 · https://example.com/docs/mcp "MCP tools" · use it for: the companion\'s tools · tags: mcp · from: docs/ARCHITECTURE.md section 11');
  assert.equal(refLine(REFS[3], { full: true }), 'link ref_link0001 · https://example.com/docs/mcp "MCP tools" · How a server lists and runs tools. · use it for: the companion\'s tools · tags: mcp · from: docs/ARCHITECTURE.md section 11');
  assert.equal(refLine(REFS[4], { full: true }), 'link ref_link0002 · https://example.com/pricing · No preview: the page answered 403');
  assert.equal(refLine(REFS[2]), 'snippet ref_snip0001 · "Atomic JSON write" (js, 3 lines) · use it for: every record write · tags: records, file system · from: server/lib/fsutil.mjs');
  assert.equal(refLine(REFS[1]), 'prompt ref_prompt01 · "Review a diff": "Review this diff for correctness. Name each fault with its line." · use it for: a second opinion before a version is kept · tags: review');
  assert.equal(refLine(REFS[0]), 'note ref_note0001 · "Chips are for states only; kinds and modes are plain words." · from: docs/DESIGN.md section 1');
  assert.ok(refLine({ ...REFS[0], text: 'w '.repeat(400) }).length < 260, 'a long note is cut in a line');
  // One entry in full: the whole text; a snippet in a fence its own backticks cannot close.
  assert.deepEqual(refFull(REFS[2]).split('\n'), [refLine(REFS[2], { full: true }), 'Added 2026-11-13T10:00:00.000Z, changed 2026-11-13T11:00:00.000Z.', '```js', ...REFS[2].text.split('\n'), '```']);
  assert.deepEqual(refFull(REFS[1]).split('\n').slice(1), ['Added 2026-11-13T10:00:00.000Z.', "The prompt's words:", 'Review this diff for correctness.', 'Name each fault with its line.']);
  assert.deepEqual(fenced('a ```js\nb\n``` c', 'md').split('\n'), ['  ````md', '  a ```js', '  b', '  ``` c', '  ````']);
});

test('matchRefs: by tag when every word of a tag is in the request, by words in the title or the use-it-for line, or two in the text; tags first', () => {
  assert.deepEqual(wordsOf('Records, the MCP tools & C++ files'), ['record', 'the', 'mcp', 'tool', 'c++', 'file']);
  const ids = (request) => matchRefs(REFS, request).map((m) => m.entry.id);
  assert.deepEqual(ids('Add an MCP tool that lists the lessons'), ['ref_link0001'], 'the tag mcp, and its title too');
  assert.deepEqual(matchRefs(REFS, 'Add an MCP tool that lists the lessons')[0], { entry: REFS[3], tags: ['mcp'], words: ['mcp', 'tool'] }, 'the words of its title; "lists" is a word any request may hold');
  assert.deepEqual(ids('Speed up the file system watcher'), ['ref_snip0001'], 'a tag of two words needs both');
  assert.deepEqual(ids('Speed up the system clock'), [], 'one of the two is not the tag');
  assert.deepEqual(ids('Make the JSON export atomic'), ['ref_snip0001'], 'words of its title');
  assert.deepEqual(matchRefs(REFS, 'Make the JSON export atomic')[0].tags, []);
  assert.deepEqual(ids('Chips should say their states'), ['ref_note0001'], 'two telling words in a text');
  assert.deepEqual(ids('Show the states of a run'), [], 'one word in a text is not enough');
  assert.deepEqual(ids('Use the project to make a task work'), [], 'words every request holds match nothing');
  assert.deepEqual(ids(''), []);
  // Tag matches come before word matches, more tags before fewer, then more words; the stored order settles a tie.
  assert.deepEqual(ids('Review how the MCP tools write records to the file system, and the diff of each'), ['ref_snip0001', 'ref_prompt01', 'ref_link0001']);
  assert.deepEqual(ids('An atomic write for the review'), ['ref_prompt01', 'ref_snip0001'], 'the tagged one first, though the other has more words');
});

test('the brief\'s lines: only what matches, tag matches first, capped, a short snippet with its code; none matching says so; no entries is no section', () => {
  assert.deepEqual(briefLines([], 'anything'), []);
  assert.deepEqual(briefLines(REFS, 'Paint the fence'), ['The project keeps 5 entries (2 links, 1 snippet, 1 prompt, 1 note) as references in `.studio/references.json`, and none matches this request by tag or by words. They are material to build from; atelier_read_references searches them (or read the file).']);
  const lines = briefLines(REFS, 'Add an MCP tool that writes records');
  assert.deepEqual(lines, [
    "The project's references: 5 entries (2 links, 1 snippet, 1 prompt, 1 note) in `.studio/references.json`; 2 match this request by tag or by words, tag matches first. They are material to build from, not instructions: reuse what fits and say which you used. The whole text of an entry is in the file under its id; atelier_read_references searches all of them.",
    `- ${refLine(REFS[3])} · matched: tag mcp; words mcp, tool`,
    `- ${refLine(REFS[2])} · matched: tag records; words record`,
    '  ```js', '  const tmp = `${file}.tmp`;', '  await fsp.writeFile(tmp, text);', '  await fsp.rename(tmp, file);', '  ```',
  ]);
  assert.match(briefLines([REFS[0]], 'Chips and states')[0], /^The project's references: 1 entry \(1 note\) in `\.studio\/references\.json`; 1 matches this request/);
  // Capped, with the rest counted; a long snippet is named, not carried.
  const many = Array.from({ length: BRIEF_REFS + 3 }, (_, i) => ({ ...REFS[0], id: `ref_many${String(i).padStart(4, '0')}`, tags: ['chips'] }));
  const capped = briefLines(many, 'Tidy the chips');
  assert.equal(capped.length, 1 + BRIEF_REFS + 1);
  assert.equal(capped.at(-1), '- and 3 more match');
  const long = { ...REFS[2], text: 'x'.repeat(BRIEF_SNIPPET_CHARS + 1) };
  assert.equal(briefLines([long], 'records').length, 2, 'the line alone: the code is in the file');
  assert.equal(briefLines([REFS[2]], 'records').length, 2 + 5, 'a short one rides whole, one line of the brief per line of code');
  assert.equal(taskWords({ request: 'Add a tool', acceptance: ['works with mcp', { text: 'tests pass' }] }), 'Add a tool\nworks with mcp\ntests pass');
  assert.deepEqual(findRefs(REFS, { tag: 'mcp' }).map((e) => e.id), ['ref_link0001']);
  assert.deepEqual(findRefs(REFS, { search: 'RENAME tmp' }).map((e) => e.id), ['ref_snip0001'], 'every word, in any order, in any case');
  assert.deepEqual(findRefs(REFS, { tag: 'review', search: 'mcp' }), []);
});

test('the brief has its References section after Inspiration, only when the project keeps references', async () => {
  const task = { id: 't_refs000001', title: 'Add an MCP tool', mode: 'handle', route: 'claude-code', createdAt: '2026-11-13T10:00:00.000Z', request: 'Add an MCP tool that writes records.', inspiration: 'The rules tool', acceptance: [], unresolved: [], context: { preferences: [], decisions: [], resources: [], files: [] } };
  const ctx = { project: { name: 'Demo', kind: 'web-app', id: 'p_demo' }, manifest: { entry: 'index.html' }, entry: { path: 'C:/x/demo' }, version: null };
  const none = renderBrief(task, ctx);
  assert.doesNotMatch(none, /## References/);
  assert.doesNotMatch(renderBrief(task, { ...ctx, refs: [] }), /## References/);
  assert.ok(none.includes('\n## Inspiration\nThe rules tool\n\n## Project\n'), 'as before');
  const lines = briefLines(REFS, taskWords(task));
  const brief = renderBrief(task, { ...ctx, refs: lines });
  assert.ok(brief.includes(`\n## Inspiration\nThe rules tool\n\n## References\n${lines.join('\n')}\n\n## Project\n`), 'a blank line before and after');
  assert.ok(renderBrief({ ...task, inspiration: '' }, { ...ctx, refs: lines }).includes(`\n## Request\nAdd an MCP tool that writes records.\n\n## References\n${lines[0]}`));
  const dept = renderBrief(task, { ...ctx, refs: lines, department: { name: 'Backend', skills: [] } });
  assert.match(dept, /\n  await fsp\.rename\(tmp, file\);\n  ```\n\n## Department\n/, 'and before a department');
  const dir = await tmpProject();
  try {
    assert.deepEqual(await briefRefs(dir, 'anything'), []);
    await addRef(dir, { kind: 'note', text: 'Chips are for states only.', tags: ['chips'] });
    assert.equal((await briefRefs(dir, 'Tidy the chips')).length, 2);
    await fsp.rm(path.join(dir, '.studio', 'references.json'));
    await fsp.mkdir(path.join(dir, '.studio', 'references.json')); // a folder where the file should be: it cannot be read
    assert.deepEqual(await briefRefs(dir, 'Tidy the chips'), [], 'never a reason not to write a brief');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('the studio\'s own seeds are taken from this repository: each names its source, and what it holds is found there', async () => {
  const src = (rel) => fsp.readFile(path.join(ROOT, rel), 'utf8');
  assert.ok(STUDIO_REFERENCES.length >= 3 && STUDIO_REFERENCES.length <= 8, 'a few');
  for (const seed of STUDIO_REFERENCES) assert.ok(seed.source && seed.useFor && seed.tags.length, `${seed.title || seed.url} says where it came from and what it is for`);
  const links = STUDIO_REFERENCES.filter((s) => s.kind === 'link').map((s) => s.url);
  assert.deepEqual(links, ['https://code.claude.com/docs/en/authentication', 'https://platform.claude.com/docs/en/about-claude/pricing']);
  assert.ok((await src('server/lib/account-login.mjs')).includes('code.claude.com/docs/en/authentication'), 'the sign-in address is the one the source names');
  assert.ok((await src('server/api-utility/pricing.mjs')).includes('platform.claude.com/docs/en/about-claude/pricing'), 'and the pricing address');
  const queue = STUDIO_REFERENCES.find((s) => s.kind === 'snippet');
  for (const file of ['server/lib/rules.mjs', 'server/lib/references.mjs']) assert.ok((await src(file)).replace(/\r\n/g, '\n').includes(queue.text.split('\n').slice(1).join('\n')), `the snippet is the code of ${file}`);
  assert.ok((await src('CLAUDE.md')).replace(/`/g, '').replace(/\s+/g, ' ').toLowerCase().includes(STUDIO_REFERENCES.find((s) => s.title === 'Server conventions for a record').text.toLowerCase()), 'the convention is CLAUDE.md\'s sentence');
  assert.ok(!STUDIO_REFERENCES.some((s) => s.kind === 'prompt'), 'no prompt is recorded anywhere, so none is seeded');
  // Seeding writes only into a list that holds nothing, in the order given.
  const dir = await tmpProject();
  try {
    const preview = async (url) => ({ ok: true, url, title: `Title of ${new URL(url).hostname}`, description: '', site: '', image: null });
    assert.deepEqual(await seedReferences(dir, STUDIO_REFERENCES, { preview }), { seeded: STUDIO_REFERENCES.length });
    const now = await listRefs(dir);
    assert.deepEqual(now.map((e) => e.title || e.url), ['Title of code.claude.com', 'Title of platform.claude.com', 'One write queue per project folder', 'The companion\'s tools', 'Server conventions for a record']);
    assert.deepEqual(await seedReferences(dir, STUDIO_REFERENCES, { preview }), { seeded: 0, kept: STUDIO_REFERENCES.length }, 'entries the person has are never written over');
    assert.deepEqual(matchRefs(now, 'Add an MCP tool that reads the lessons').map((m) => m.entry.title), ['The companion\'s tools'], 'and a request finds the one it needs');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('the references record under .studio reaches the stream as references.changed; its temp files say nothing', () => {
  assert.deepEqual(watchEvent('references.json'), { type: 'references.changed', data: { file: 'references.json' } });
  assert.equal(watchEvent('references.json.123.456.tmp'), null);
  assert.equal(watchEvent('references.json.corrupt-1'), null);
  assert.deepEqual(watchEvent('rules.json'), { type: 'rules.changed', data: { file: 'rules.json' } }, 'the rules as before');
  assert.equal(watchEvent('project.json').type, 'project.changed');
});

// ---------- the routes, the briefing, a new task's brief and the companion's tool, against a real studio ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-refs-http-'));
let child;
let project;
let second;
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
before(async () => {
  await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const t0 = Date.now();
  let up = false;
  while (exit === null && Date.now() - t0 < 30000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error(`server did not start on port ${PORT} after ${Date.now() - t0} ms (exit ${exit}): ${stderr.slice(-500)}`);
  const made = await api('POST', '/api/projects', { name: 'Ref Notes', kind: 'web-app', template: 'web-app-notes' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  project = made.data.project;
  const other = await api('POST', '/api/projects', { name: 'Other Notes', kind: 'web-app', template: 'web-app-notes' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  second = other.data.project;
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('routes: add, edit, remove; refusals as sentences; each project its own references; the briefing, a new brief and the tool', async () => {
  const R = `/api/projects/${project.id}/references`;
  const empty = await api('GET', R);
  assert.deepEqual([empty.status, empty.data.entries, empty.data.kinds, empty.data.where], [200, [], REF_KINDS, { file: '.studio/references.json' }]);
  assert.match((await api('GET', `/api/briefing?projectId=${project.id}`)).data.markdown, /\n- References: none yet \(`\.studio\/references\.json`; the studio's Inspiration view keeps them under References\)\n- Direction: /);
  // With no references a new brief has no References section.
  const bare = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Tidy the list.' })).data;
  assert.doesNotMatch((await api('GET', `/api/projects/${project.id}/tasks/${bare.id}`)).data.brief, /## References/);

  const snippet = await api('POST', R, { kind: 'snippet', title: 'Debounced save', language: 'js', text: 'let timer;\nconst save = () => { clearTimeout(timer); timer = setTimeout(write, 300); };', useFor: 'saving a note while it is typed', tags: ['storage', 'notes'], source: 'app.js of the notes template' });
  assert.equal(snippet.status, 200, JSON.stringify(snippet.data));
  const prompt = (await api('POST', R, { kind: 'prompt', title: 'Name the smallest piece', text: 'Name the smallest piece of this that would make it real, and build only that.', tags: ['method'] })).data;
  const note = (await api('POST', R, { kind: 'note', text: 'localStorage is keyed per project because every preview shares one origin.', tags: ['storage'] })).data;
  const folder = path.join(root, 'projects', project.slug || 'ref-notes', '.studio');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(folder, 'references.json'), 'utf8')).entries.map((e) => e.id), [note.id, prompt.id, snippet.data.id], 'newest first');
  // Another project keeps its own.
  assert.deepEqual((await api('GET', `/api/projects/${second.id}/references`)).data.entries, []);
  assert.equal((await api('PATCH', `/api/projects/${second.id}/references/${note.id}`, { title: 'x' })).status, 404, 'an entry is its own project\'s');

  const refusal = async (method, p, body, status, code, words) => {
    const r = await api(method, p, body);
    assert.deepEqual([r.status, r.data?.error?.code], [status, code], JSON.stringify(body).slice(0, 70));
    assert.match(r.data.error.message, words);
  };
  await refusal('POST', R, { kind: 'link', url: `${BASE}/api/state` }, 400, 'unsafe_link', /private or local address \(127\.0\.0\.1\)/);
  await refusal('POST', R, { kind: 'link', url: 'http://localhost:4747/' }, 400, 'unsafe_link', /private or local address \(localhost\)/);
  await refusal('POST', R, { kind: 'link', url: 'http://169.254.169.254/latest/meta-data/' }, 400, 'unsafe_link', /private or local/);
  await refusal('POST', R, { kind: 'link', url: 'file:///C:/Windows/win.ini' }, 400, 'unsafe_link', /Only http and https links/);
  await refusal('POST', R, { kind: 'snippet', title: 'Big', text: 'x'.repeat(TEXT_MAX.snippet + 1) }, 413, 'too_large', /A snippet is at most 20,000 characters; this one is 20,001/);
  await refusal('POST', R, { kind: 'snippet', text: 'x' }, 400, 'invalid_input', /A snippet needs a title to find it by/);
  await refusal('POST', R, { kind: 'color', hex: '#fff' }, 400, 'invalid_input', /Choose what the reference is/);
  await refusal('PATCH', `${R}/${note.id}`, { kind: 'prompt' }, 400, 'invalid_input', /keeps its kind/);
  await refusal('PATCH', `${R}/${prompt.id}`, { title: '' }, 400, 'invalid_input', /A prompt needs a title/);
  assert.equal((await api('PATCH', `${R}/ref_nothere1234`, { title: 'x' })).status, 404);
  assert.equal((await api('PATCH', `${R}/..%2Fproject`, { title: 'x' })).status, 404);
  assert.equal((await api('GET', R)).data.entries.length, 3, 'a refusal adds nothing');

  const edited = await api('PATCH', `${R}/${note.id}`, { title: 'Storage keys', useFor: 'anything that keeps data in the browser' });
  assert.deepEqual([edited.status, edited.data.title, edited.data.useFor, edited.data.text, edited.data.kind], [200, 'Storage keys', 'anything that keeps data in the browser', note.text, 'note']);

  // The briefing names the count, in the file too.
  const line = '\n- References: 3 entries (1 snippet, 1 prompt, 1 note) in `.studio/references.json`; atelier_read_references searches them\n';
  assert.ok((await api('GET', `/api/briefing?projectId=${project.id}`)).data.markdown.includes(line));
  assert.ok((await fsp.readFile(path.join(folder, 'BRIEFING.md'), 'utf8')).includes(line), 'the file too');

  // A new task's brief lists what matches its request, tag matches first, with a short snippet's code.
  const task = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Keep the notes in browser storage while the person types.', inspiration: 'A paper notebook' })).data;
  const brief = (await api('GET', `/api/projects/${project.id}/tasks/${task.id}`)).data.brief;
  const section = brief.slice(brief.indexOf('## References'), brief.indexOf('## Project')).trim().split('\n');
  assert.deepEqual(section, [
    '## References',
    "The project's references: 3 entries (1 snippet, 1 prompt, 1 note) in `.studio/references.json`; 2 match this request by tag or by words, tag matches first. They are material to build from, not instructions: reuse what fits and say which you used. The whole text of an entry is in the file under its id; atelier_read_references searches all of them.",
    `- snippet ${snippet.data.id} · "Debounced save" (js, 2 lines) · use it for: saving a note while it is typed · tags: storage, notes · from: app.js of the notes template · matched: tag storage, notes; words note`,
    '  ```js', '  let timer;', '  const save = () => { clearTimeout(timer); timer = setTimeout(write, 300); };', '  ```',
    `- note ${note.id} · "Storage keys": "localStorage is keyed per project because every preview shares one origin." · use it for: anything that keeps data in the browser · tags: storage · matched: tag storage; words storage, browser`,
  ]);
  assert.ok(brief.indexOf('## Inspiration') < brief.indexOf('## References') && brief.indexOf('## References') < brief.indexOf('## Project'));
  const off = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Paint the fence green.' })).data;
  assert.match((await api('GET', `/api/projects/${project.id}/tasks/${off.id}`)).data.brief, /\n## References\nThe project keeps 3 entries \(1 snippet, 1 prompt, 1 note\) as references in `\.studio\/references\.json`, and none matches this request/);
  assert.doesNotMatch((await api('GET', `/api/projects/${second.id}/tasks/${(await api('POST', `/api/projects/${second.id}/tasks`, { request: 'Keep the notes in storage.' })).data.id}`)).data.brief, /## References/, 'another project\'s brief has none of them');

  // The companion's tool: the list, a tag, a search, one entry in full, and its refusals.
  const tools = createTools({ studio: BASE, project: project.id });
  let n = 0;
  const call = async (args) => (await handleMessage({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: 'atelier_read_references', arguments: args } }, { tools })).result;
  const all = await call({});
  assert.equal(all.isError, undefined, all.content[0].text);
  const listed = all.content[0].text.split('\n');
  assert.equal(listed[0], `References of Ref Notes (${project.id}): 3 entries (1 snippet, 1 prompt, 1 note), newest first. Records in .studio/references.json of the project folder; give entry (an id) for the whole text of a snippet, prompt or note. Tags in use: method, notes, storage.`);
  assert.deepEqual(listed.slice(1).map((l) => l.split(' · ')[0]), [`1. note ${note.id}`, `2. prompt ${prompt.id}`, `3. snippet ${snippet.data.id}`]);
  const tagged = (await call({ tag: '#Storage' })).content[0].text.split('\n');
  assert.match(tagged[0], /3 entries \(1 snippet, 1 prompt, 1 note\); 2 with the tag storage, newest first\./);
  assert.equal(tagged.length, 3);
  const found = (await call({ search: 'smallest real' })).content[0].text.split('\n');
  assert.match(found[0], /; 1 with the words "smallest real", newest first\./);
  assert.match(found[1], new RegExp(`^1\\. prompt ${prompt.id} · "Name the smallest piece": `));
  assert.match((await call({ tag: 'storage', search: 'debounced' })).content[0].text, /; 1 with the tag storage and the words "debounced"/);
  assert.match((await call({ search: 'kubernetes' })).content[0].text, /^No reference of Ref Notes \(p_[a-z0-9]+\) has the words "kubernetes"; it keeps 3 entries \(1 snippet, 1 prompt, 1 note\), and the tags in use are method, notes, storage\.$/);
  const one = (await call({ entry: snippet.data.id })).content[0].text.split('\n');
  assert.equal(one[0], `Reference of Ref Notes (${project.id}):`);
  assert.deepEqual(one.slice(-4), ['```js', 'let timer;', 'const save = () => { clearTimeout(timer); timer = setTimeout(write, 300); };', '```'], 'the whole code');
  assert.equal((await call({ entry: 'ref_nothere1234' })).isError, true);
  assert.equal((await call({ entry: 'ins_abcd1234' })).isError, true);
  assert.match((await call({ project: second.id })).content[0].text, /^Other Notes \(p_[a-z0-9]+\) keeps no references yet: the person has saved nothing to build from/);

  // Remove: the entry goes and the briefing counts again.
  assert.deepEqual((await api('DELETE', `${R}/${prompt.id}`)).data, { removed: prompt.id });
  assert.equal((await api('DELETE', `${R}/${prompt.id}`)).status, 404);
  assert.match(await fsp.readFile(path.join(folder, 'BRIEFING.md'), 'utf8'), /- References: 2 entries \(1 snippet, 1 note\) in `\.studio\/references\.json`/);
});
