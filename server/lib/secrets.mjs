// Budget keys belong to the studio. Subscription credentials belong to the installed provider CLIs.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { DATA_DIR } from './paths.mjs';
import { randomUUID } from 'node:crypto';
import { ensureDir } from './fsutil.mjs';

export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

async function readSecrets() {
  try { return JSON.parse(await fsp.readFile(SECRETS_FILE, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) throw new Error('The local secrets file contains invalid JSON.');
    throw err;
  }
}

// Serialize removals and key edits so two Settings windows cannot restore a removed credential.
let writing = Promise.resolve();
function editSecrets(edit) {
  const next = writing.then(async () => {
    const data = await readSecrets();
    edit(data);
    await ensureDir(DATA_DIR);
    const tmp = SECRETS_FILE + '.' + randomUUID() + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
      await fsp.rename(tmp, SECRETS_FILE);
    } finally { await fsp.rm(tmp, { force: true }); }
  });
  writing = next.catch(() => {});
  return next;
}

export async function getApiKey() {
  const fromEnv = process.env.STUDIO_ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const data = await readSecrets();
  const key = data?.STUDIO_ANTHROPIC_API_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}

export async function keySource() {
  if (process.env.STUDIO_ANTHROPIC_API_KEY?.trim()) return 'env';
  const data = await readSecrets();
  return data?.STUDIO_ANTHROPIC_API_KEY ? 'secrets.json' : null;
}

/** Store a key the user pasted into Settings. Overwrites; never echoes. */
export async function setApiKey(key) {
  const value = String(key || '').trim();
  await editSecrets(data => {
    if (value) data.STUDIO_ANTHROPIC_API_KEY = value;
    else delete data.STUDIO_ANTHROPIC_API_KEY;
  });
  return { configured: Boolean(value) };
}

// Older builds accepted a pasted token. Only its presence is reported so the owner can remove it.
export async function claudeTokenInfo() {
  return { saved: Boolean((await readSecrets())?.CLAUDE_CODE_OAUTH_TOKEN) };
}

export async function removeLegacyToken() {
  await editSecrets(data => {
    delete data.CLAUDE_CODE_OAUTH_TOKEN;
    delete data.CLAUDE_CODE_OAUTH_TOKEN_SAVED_AT;
  });
  return { saved: false };
}

export function redact(text) {
  return String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
}
