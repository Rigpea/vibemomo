// The studio API key: env STUDIO_ANTHROPIC_API_KEY, else ~/.atelier/secrets.json. And the studio's Claude Code
// sign-in (decision row 129): a one-year token the person made with `claude setup-token` and pasted in Settings.
// Both are read on demand, never cached in a global, never returned by any endpoint.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { DATA_DIR } from './paths.mjs';
import { readJson, writeJson, ensureDir } from './fsutil.mjs';

export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

export async function getApiKey() {
  const fromEnv = process.env.STUDIO_ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const data = await readJson(SECRETS_FILE, null);
  const key = data?.STUDIO_ANTHROPIC_API_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}

export async function keySource() {
  if (process.env.STUDIO_ANTHROPIC_API_KEY?.trim()) return 'env';
  const data = await readJson(SECRETS_FILE, null);
  return data?.STUDIO_ANTHROPIC_API_KEY ? 'secrets.json' : null;
}

/** Store a key the user pasted into Settings. Overwrites; never echoes. */
export async function setApiKey(key) {
  await ensureDir(DATA_DIR);
  const data = (await readJson(SECRETS_FILE, null)) || {};
  if (!key) delete data.STUDIO_ANTHROPIC_API_KEY;
  else data.STUDIO_ANTHROPIC_API_KEY = String(key).trim();
  await writeJson(SECRETS_FILE, data);
  try {
    await fsp.chmod(SECRETS_FILE, 0o600);
  } catch {
    /* Windows ignores POSIX modes; the file sits in the user profile */
  }
  return { configured: Boolean(data.STUDIO_ANTHROPIC_API_KEY) };
}

const TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
const TOKEN_SAVED_AT = 'CLAUDE_CODE_OAUTH_TOKEN_SAVED_AT';
/** claude setup-token makes a token that lasts one year (code.claude.com/docs/en/authentication). */
export const TOKEN_DAYS = 365;

/** The saved Claude Code token, for the environment of the studio's own claude runs only. */
export async function getClaudeToken() {
  const data = await readJson(SECRETS_FILE, null);
  const t = data?.[TOKEN_KEY];
  return t && String(t).trim() ? String(t).trim() : null;
}

/** What may be said about the saved token: whether there is one, when it was saved, about when it ends. */
export async function claudeTokenInfo() {
  const data = await readJson(SECRETS_FILE, null);
  if (!data?.[TOKEN_KEY]) return { saved: false, savedAt: null, endsAbout: null };
  const savedAt = typeof data[TOKEN_SAVED_AT] === 'string' && Number.isFinite(Date.parse(data[TOKEN_SAVED_AT])) ? data[TOKEN_SAVED_AT] : null;
  return { saved: true, savedAt, endsAbout: savedAt ? new Date(Date.parse(savedAt) + TOKEN_DAYS * 86400000).toISOString() : null };
}

/** Why a pasted token is refused, or null. An API key is refused: Claude Code would bill the API with it, and the
 *  studio never switches to API-funded development by itself. Empty is allowed: it removes the saved token. */
export function claudeTokenProblem(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  if (/^sk-ant-api/i.test(t)) return 'That is an API key, not a Claude Code sign-in: Claude Code would bill the API with it. Paste the token that claude setup-token prints.';
  if (!/^[A-Za-z0-9_.-]{20,2048}$/.test(t)) return 'That does not look like a token: paste the one line that claude setup-token prints, with nothing around it.';
  return null;
}

/** Save (or with an empty value remove) the Claude Code token. Overwrites; never echoes. */
export async function setClaudeToken(token, now = new Date()) {
  const problem = claudeTokenProblem(token);
  if (problem) throw new Error(problem);
  await ensureDir(DATA_DIR);
  const data = (await readJson(SECRETS_FILE, null)) || {};
  const t = String(token ?? '').trim();
  if (!t) { delete data[TOKEN_KEY]; delete data[TOKEN_SAVED_AT]; } else { data[TOKEN_KEY] = t; data[TOKEN_SAVED_AT] = now.toISOString(); }
  await writeJson(SECRETS_FILE, data);
  try { await fsp.chmod(SECRETS_FILE, 0o600); } catch { /* Windows ignores POSIX modes */ }
  return claudeTokenInfo();
}

export function redact(text) {
  return String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
}
