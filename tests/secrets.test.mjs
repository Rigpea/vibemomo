// The studio's Claude Code sign-in token (decision row 129): the shape check that refuses an API key, saving with a
// date beside the API key, removing only the token, and nothing that returns it. A private data folder; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-secrets-'));
process.env.ATELIER_DATA_DIR = dir;
process.env.STUDIO_ANTHROPIC_API_KEY = '';
const s = await import('../server/lib/secrets.mjs');
const file = path.join(dir, 'secrets.json');

test('claudeTokenProblem refuses an API key and anything that is not one token line; empty is a removal', () => {
  assert.equal(s.claudeTokenProblem(''), null);
  assert.equal(s.claudeTokenProblem('  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz_-0123  '), null);
  assert.match(s.claudeTokenProblem('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), /API key/);
  assert.match(s.claudeTokenProblem('export CLAUDE_CODE_OAUTH_TOKEN=abc def ghi jkl'), /does not look like a token/);
  assert.match(s.claudeTokenProblem('short'), /does not look like a token/);
});

test('setClaudeToken saves it with its date beside the API key; the info says when it ends and never holds it; empty removes only the token', async () => {
  fs.writeFileSync(file, JSON.stringify({ STUDIO_ANTHROPIC_API_KEY: 'sk-ant-api03-keep-this-one' }));
  const info = await s.setClaudeToken('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', new Date('2026-11-07T12:00:00Z'));
  assert.deepEqual(info, { saved: true, savedAt: '2026-11-07T12:00:00.000Z', endsAbout: '2027-11-07T12:00:00.000Z' });
  assert.equal(await s.getClaudeToken(), 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
  assert.equal(await s.getApiKey(), 'sk-ant-api03-keep-this-one', 'the API key is untouched');
  await assert.rejects(s.setClaudeToken('sk-ant-api03-not-a-sign-in-at-all'), /API key/);
  assert.equal(await s.getClaudeToken(), 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', 'a refused paste changes nothing');
  assert.deepEqual(await s.setClaudeToken(''), { saved: false, savedAt: null, endsAbout: null });
  assert.equal(await s.getClaudeToken(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { STUDIO_ANTHROPIC_API_KEY: 'sk-ant-api03-keep-this-one' });
  assert.equal(s.redact('token sk-ant-oat01-abc_def-123 here'), 'token sk-ant-*** here', 'redact covers the token too');
});
