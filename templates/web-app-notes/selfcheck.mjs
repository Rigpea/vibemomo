// Quick Notes — selfcheck.mjs
// Headless sanity check (Node only, no browser). Run: node selfcheck.mjs
// (a) atelier.json has the required manifest fields for a "web-app".
// (b) index.html loads classic scripts only and references nothing remote,
//     so it runs from file://.
// (c) store.js behaves: it is run in a sandbox with a fake localStorage and
//     exercised for save/load, corrupted data (backup kept), storage-full
//     errors and import validation.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

// (a) manifest
let manifest = {};
try { manifest = JSON.parse(read("atelier.json")); check(true, "atelier.json is valid JSON"); }
catch (e) { check(false, `atelier.json is valid JSON (${e.message})`); }
check(manifest.kind === "web-app", `kind is "web-app" (${manifest.kind})`);
check(typeof manifest.name === "string" && manifest.name.length > 0, "name is set");
check(typeof manifest.entry === "string" && existsSync(join(root, manifest.entry)), `entry exists (${manifest.entry})`);
const b = manifest.build || {};
check(b.type === "static" && typeof b.dir === "string" && typeof b.out === "string", "build has type/dir/out");
check(typeof b.dir === "string" && existsSync(join(root, b.dir)), `build.dir exists (${b.dir})`);
check(Array.isArray(manifest.readiness) && manifest.readiness.length > 0 &&
  manifest.readiness.every((r) => typeof r === "string"), "readiness is a non-empty list of strings");

// (b) index.html runs from file://
const html = read(manifest.entry || "src/index.html");
check(!/type\s*=\s*["']?module/i.test(html), "index.html has no type=\"module\"");
check(!/https?:\/\//i.test(html), "index.html has no http(s) references");
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
check(scripts.join(",") === "store.js,app.js", `script order is store, app (${scripts.join(", ")})`);
for (const s of scripts) check(existsSync(join(root, "src", s)), `script ${s} exists`);
for (const f of ["src/store.js", "src/app.js", "src/style.css"]) {
  const text = read(f);
  check(!/https?:\/\//i.test(text), `${f} has no http(s) references`);
  if (f.endsWith(".js")) check(!/\bfetch\s*\(|\bimport\s*\(|^\s*(import|export)\s/m.test(text), `${f} uses no fetch/import/export`);
}
check(/atelier:ready/.test(read("src/app.js")) && /atelier:event/.test(read("src/app.js")), "app.js posts atelier:ready and atelier:event");
check(/window\.parent\s*===\s*window/.test(read("src/app.js")), "app.js guards postMessage when there is no parent");

// (c) store.js in a sandbox
function fakeStorage({ quota = Infinity } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > quota) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; }
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k)
  };
}
function loadStore(storage, document) {
  const window = { localStorage: storage };
  const sandbox = { window, Date, Math, JSON, isFinite, String };
  if (document) sandbox.document = document;
  vm.runInNewContext(read("src/store.js"), sandbox);
  return window.NotesStore;
}

// Storage key per project: every preview shares the studio origin, so the key
// comes from <html data-storage-key> (set to the project slug at creation).
{
  const attr = html.match(/<html[^>]*\sdata-storage-key="([a-z0-9][a-z0-9-]*)"/);
  check(!!attr, "<html> carries data-storage-key");
  check(/document\.documentElement/.test(read("src/store.js")) && /dataset\.storageKey/.test(read("src/store.js")),
    "store.js derives its key from document.documentElement.dataset.storageKey");
  const S = loadStore(fakeStorage(), { documentElement: { dataset: { storageKey: "project-slug" } } });
  check(S.KEY === "project-slug" && S.BACKUP_KEY === "project-slug.backup", `key and backup key follow the attribute (${S.KEY}, ${S.BACKUP_KEY})`);
  const F = loadStore(fakeStorage());
  check(typeof F.KEY === "string" && F.KEY.length > 0 && F.BACKUP_KEY === F.KEY + ".backup", `no document/attribute -> fallback key (${F.KEY})`);
  if (attr) check(F.KEY === attr[1], `fallback key matches the page attribute (${attr[1]})`);
}

{
  const ls = fakeStorage();
  const S = loadStore(ls);
  const first = S.load();
  check(first.ok && first.fresh && first.notes.length === 0, "load() on empty storage -> fresh, no notes");
  const note = { id: S.newId(), text: "hello", createdAt: 1, updatedAt: 1, pinned: false };
  const saved = S.save([note]);
  check(saved.ok, "save() succeeds");
  const doc = JSON.parse(ls.getItem(S.KEY));
  check(doc.version === 1 && Array.isArray(doc.notes) && doc.notes[0].text === "hello", "stored shape is {version:1, notes:[...]}");
  const again = S.load();
  check(again.ok && again.notes.length === 1 && again.notes[0].id === note.id, "load() returns what save() wrote");

  ls.setItem(S.KEY, "{not json");
  const bad = S.load();
  check(!bad.ok && bad.error === "corrupt", "corrupted JSON -> error \"corrupt\"");
  check(ls.getItem(S.BACKUP_KEY) === "{not json", "corrupted data copied to the backup key");
  check(S.startFresh().ok && S.load().notes.length === 0, "startFresh() leaves an empty, valid store");
  check(ls.getItem(S.BACKUP_KEY) === "{not json", "backup survives startFresh()");

  ls.setItem(S.KEY, JSON.stringify({ version: 2, notes: [] }));
  check(S.load().error === "corrupt", "unknown version is not silently accepted");
}
{
  const S = loadStore(fakeStorage({ quota: 50 }));
  const r = S.save([{ id: "a", text: "x".repeat(100), createdAt: 1, updatedAt: 1, pinned: false }]);
  check(!r.ok && r.error === "quota", "storage full -> error \"quota\" with a message");
}
{
  const S = loadStore(undefined);
  check(S.load().error === "unavailable" && S.save([]).ok === false, "no localStorage -> \"unavailable\", nothing throws");
}
{
  const S = loadStore(fakeStorage());
  const good = S.parseImport(S.exportText([{ id: "a", text: "t", createdAt: 1, updatedAt: 2, pinned: true }]));
  check(good.ok && good.notes[0].pinned === true, "export -> import round-trips");
  check(!S.parseImport("").ok, "import rejects an empty file");
  check(!S.parseImport("[1,2]").ok, "import rejects a bare array");
  check(!S.parseImport('{"version":1,"notes":[{"id":"a"}]}').ok, "import rejects a note without text");
  check(!S.parseImport('{"version":1,"notes":[' +
    '{"id":"a","text":"1","createdAt":1},{"id":"a","text":"2","createdAt":1}]}').ok, "import rejects duplicate ids");
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
