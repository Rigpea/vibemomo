// Quick Notes — store.js
// Everything about SAVING and LOADING notes lives here, and nothing else.
// app.js never touches localStorage directly; it calls window.NotesStore.
//
// Storage layout (one localStorage key, one JSON document):
//   "quick-notes"         -> { "version": 1, "notes": [Note, ...] }
//   "quick-notes.backup"  -> the raw text we could NOT read, kept so a
//                            corrupted save is never silently thrown away.
// The key is read from <html data-storage-key="..."> (Atelier sets it to the
// project's slug at creation), because every page opened from the same
// origin shares one localStorage: two copies of this app need two keys.
// Without the attribute (or outside a browser) it falls back to "quick-notes".
//   Note = { id: string, text: string, createdAt: number (ms since 1970),
//            updatedAt: number, pinned: boolean }
//
// Why a "version" field? If the shape of a note ever changes, a future
// version of this file can recognise old data and upgrade it instead of
// mistaking it for garbage.
//
// Every function returns a plain result object ({ ok: true, ... } or
// { ok: false, error: "...", message: "..." }) instead of throwing, so the
// UI can always show the user what happened.
(function () {
  "use strict";

  function storageKey() {
    try {
      var el = typeof document !== "undefined" && document.documentElement;
      return (el && el.dataset && el.dataset.storageKey) || "quick-notes";
    } catch (e) {
      return "quick-notes";
    }
  }
  var KEY = storageKey();
  var BACKUP_KEY = KEY + ".backup";
  var VERSION = 1;
  var MAX_TEXT = 20000;          // characters per note; keeps one note from filling storage
  var MAX_IMPORT_BYTES = 5e6;    // refuse import files larger than ~5 MB

  // localStorage can be missing or throw (private modes, blocked cookies,
  // sandboxed iframes). Look it up defensively, once per call.
  function storage() {
    try {
      var s = window.localStorage;
      if (!s) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  // A browser reports "storage is full" with different error names; treat
  // all of them the same way.
  function isQuotaError(e) {
    if (!e) return false;
    return e.name === "QuotaExceededError" ||
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      e.code === 22 || e.code === 1014;
  }

  // Check ONE note. Returns a cleaned copy, or null if it is unusable.
  function cleanNote(n) {
    if (!n || typeof n !== "object") return null;
    if (typeof n.id !== "string" || !n.id) return null;
    if (typeof n.text !== "string") return null;
    if (typeof n.createdAt !== "number" || !isFinite(n.createdAt)) return null;
    var updated = (typeof n.updatedAt === "number" && isFinite(n.updatedAt)) ? n.updatedAt : n.createdAt;
    return {
      id: n.id,
      text: n.text.slice(0, MAX_TEXT),
      createdAt: n.createdAt,
      updatedAt: updated,
      pinned: n.pinned === true
    };
  }

  // Check a whole document ({version, notes}). Used for both loading and
  // importing. Strict on structure; a single bad note fails the document,
  // because a half-read file is worse than a clear error.
  function validateDoc(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false, error: "shape", message: "Expected an object like {\"version\":1,\"notes\":[...]}." };
    }
    if (doc.version !== VERSION) {
      return { ok: false, error: "version", message: "Unsupported version: " + String(doc.version) + " (expected " + VERSION + ")." };
    }
    if (!Array.isArray(doc.notes)) {
      return { ok: false, error: "shape", message: "\"notes\" must be a list." };
    }
    var out = [];
    var seen = {};
    for (var i = 0; i < doc.notes.length; i++) {
      var n = cleanNote(doc.notes[i]);
      if (!n) return { ok: false, error: "note", message: "Note #" + (i + 1) + " is missing id, text or createdAt." };
      if (seen[n.id]) return { ok: false, error: "note", message: "Duplicate note id: " + n.id };
      seen[n.id] = true;
      out.push(n);
    }
    return { ok: true, notes: out };
  }

  // Read notes at startup.
  //   { ok:true, notes, fresh:true }  nothing saved yet
  //   { ok:true, notes }              loaded fine
  //   { ok:false, error:"corrupt", message, raw }   saved data unreadable;
  //                                   a copy has been written to BACKUP_KEY
  //   { ok:false, error:"unavailable" }  no localStorage at all
  function load() {
    var s = storage();
    if (!s) return { ok: false, error: "unavailable", message: "This browser is not letting the page store data, so notes will not be kept after you close it." };
    var raw;
    try { raw = s.getItem(KEY); } catch (e) {
      return { ok: false, error: "unavailable", message: "Could not read saved notes (" + e.name + ")." };
    }
    if (raw === null) return { ok: true, notes: [], fresh: true };

    var doc, problem = null;
    try { doc = JSON.parse(raw); } catch (e) { problem = "The saved data is not valid JSON."; }
    var v = problem ? null : validateDoc(doc);
    if (v && v.ok) return { ok: true, notes: v.notes };
    if (!problem) problem = v.message;

    // Keep the damaged text before anything can overwrite it.
    var backedUp = false;
    try { s.setItem(BACKUP_KEY, raw); backedUp = true; } catch (e) { /* reported below */ }
    return { ok: false, error: "corrupt", message: problem, raw: raw, backedUp: backedUp };
  }

  // Write the full list. Called after EVERY change.
  //   { ok:true, savedAt }  or  { ok:false, error:"quota"|"unavailable"|"write", message }
  function save(notes) {
    var s = storage();
    if (!s) return { ok: false, error: "unavailable", message: "Storage is not available; changes are only kept until you close this page." };
    var text = JSON.stringify({ version: VERSION, notes: notes });
    try {
      s.setItem(KEY, text);
    } catch (e) {
      if (isQuotaError(e)) {
        return { ok: false, error: "quota", message: "Storage is full, so the last change was NOT saved. Export your notes, then delete some." };
      }
      return { ok: false, error: "write", message: "Saving failed (" + (e && e.name) + ")." };
    }
    // Read it back: the only honest way to say "saved".
    try {
      if (s.getItem(KEY) !== text) return { ok: false, error: "write", message: "Saving could not be confirmed." };
    } catch (e) {
      return { ok: false, error: "write", message: "Saving could not be confirmed." };
    }
    return { ok: true, savedAt: Date.now() };
  }

  // Throw away the unreadable data (it is already in BACKUP_KEY) and start
  // with an empty list.
  function startFresh() {
    return save([]);
  }

  function readBackup() {
    var s = storage();
    if (!s) return null;
    try { return s.getItem(BACKUP_KEY); } catch (e) { return null; }
  }

  // Text for the "Export" download.
  function exportText(notes) {
    return JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), notes: notes }, null, 2);
  }

  // Parse an import file's text. Returns { ok:true, notes } or { ok:false, message }.
  function parseImport(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, message: "The file is empty." };
    if (text.length > MAX_IMPORT_BYTES) return { ok: false, message: "The file is too large to be a Quick Notes export." };
    var doc;
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, message: "The file is not valid JSON." }; }
    return validateDoc(doc);
  }

  // A short unique id: time + randomness, e.g. "n_lq2x9k_4f7a".
  function newId() {
    return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  window.NotesStore = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    VERSION: VERSION,
    MAX_TEXT: MAX_TEXT,
    load: load,
    save: save,
    startFresh: startFresh,
    readBackup: readBackup,
    exportText: exportText,
    parseImport: parseImport,
    validateDoc: validateDoc,
    newId: newId
  };
})();
