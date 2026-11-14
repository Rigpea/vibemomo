// Small array-in-a-file stores for decisions, feedback, releases, resources.
import { readJson, writeJson, appendJsonl } from './fsutil.mjs';
import { newId, nowIso, HttpError } from './paths.mjs';

export function listStore(file, prefix) {
  return {
    file,
    async all() {
      return readJson(file, []);
    },
    async get(id) {
      const items = await readJson(file, []);
      const item = items.find((x) => x.id === id);
      if (!item) throw new HttpError(404, 'not_found', `${prefix} ${id} not found`);
      return item;
    },
    async add(record) {
      const items = await readJson(file, []);
      const item = { id: newId(prefix), createdAt: nowIso(), updatedAt: nowIso(), ...record };
      items.push(item);
      await writeJson(file, items);
      return item;
    },
    async patch(id, partial) {
      const items = await readJson(file, []);
      const idx = items.findIndex((x) => x.id === id);
      if (idx < 0) throw new HttpError(404, 'not_found', `${prefix} ${id} not found`);
      items[idx] = { ...items[idx], ...partial, id, updatedAt: nowIso() };
      await writeJson(file, items);
      return items[idx];
    },
    async replaceAll(items) {
      await writeJson(file, items);
    },
  };
}

export function historyLog(file) {
  return {
    async append(type, data) {
      await appendJsonl(file, { ts: nowIso(), type, ...data });
    },
  };
}
