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

test('removing an old subscription token preserves concurrent Budget changes', async () => {
  fs.writeFileSync(file, JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: 'legacy-test', CLAUDE_CODE_OAUTH_TOKEN_SAVED_AT: 'earlier', STUDIO_ANTHROPIC_API_KEY: 'old-budget' }));
  assert.deepEqual(await s.claudeTokenInfo(), { saved: true });
  await Promise.all([s.removeLegacyToken(), s.setApiKey('new-budget')]);
  assert.deepEqual(await s.claudeTokenInfo(), { saved: false });
  assert.equal(await s.getApiKey(), 'new-budget');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { STUDIO_ANTHROPIC_API_KEY: 'new-budget' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
