// ~/.atelier/registry.json: the list of projects and studio-default settings.
// Carries a schemaVersion and a migration chain so studio upgrades never
// strand data.
import path from 'node:path';
import { DATA_DIR, nowIso } from './paths.mjs';
import { readJson, writeJson, ensureDir } from './fsutil.mjs';

export const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
export const SCHEMA_VERSION = 1;

const DEFAULT = {
  schemaVersion: SCHEMA_VERSION,
  projects: [],
  settings: {
    ui: {},
    apiUtility: { model: 'claude-haiku-5-5' },
    console: { command: '', commandMode: 'stdin', timeoutMs: 600000, claudePath: '', terminalFont: '' },
  },
  activeProjectId: null,
  createdAt: null,
  updatedAt: null,
};

export const MIGRATIONS = {
  // 0 -> 1: initial shape; nothing to transform. Future migrations append here.
  1: (data) => data,
};

export function migrate(data) {
  let version = Number(data.schemaVersion || 0);
  let out = { ...DEFAULT, ...data };
  while (version < SCHEMA_VERSION) {
    version += 1;
    const step = MIGRATIONS[version];
    out = step ? step(out) : out;
    out.schemaVersion = version;
  }
  return out;
}

export async function loadRegistry() {
  await ensureDir(DATA_DIR);
  const raw = await readJson(REGISTRY_FILE, { ...DEFAULT, createdAt: nowIso() });
  const migrated = migrate(raw);
  if (migrated.schemaVersion !== raw.schemaVersion) await writeJson(REGISTRY_FILE, migrated);
  return migrated;
}

export async function saveRegistry(reg) {
  reg.updatedAt = nowIso();
  await writeJson(REGISTRY_FILE, reg);
  return reg;
}

export async function updateRegistry(fn) {
  const reg = await loadRegistry();
  const result = await fn(reg);
  await saveRegistry(reg);
  return result ?? reg;
}
