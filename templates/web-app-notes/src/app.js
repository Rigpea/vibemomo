// Quick Notes — app.js
// The interface. Reads and writes notes ONLY through window.NotesStore
// (store.js), and redraws the list from the `state` object after every
// change. The pattern is: change state -> persist() -> render().
//
// Sections:
//   1. STATE        the single source of truth in memory
//   2. STUDIO LINK  postMessage to the Atelier studio (safe without it)
//   3. SAVING       persist() + the "Saving… / Saved" indicator
//   4. ACTIONS      add, edit, delete + undo, pin, import, export
//   5. RENDER       turn state into HTML
//   6. KEYBOARD     "/", Esc, arrow keys, Enter, Delete, P
//   7. START        load saved notes, show the right state
(function () {
  "use strict";

  var Store = window.NotesStore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- 1. STATE
  var state = {
    notes: [],          // every note, any order (render() sorts)
    query: "",          // search box text
    editingId: null,    // id of the note being edited inline, if any
    focusId: null,      // id of the note that should keep keyboard focus
    blocked: false,     // true while the "could not read" error state is up
    lastDeleted: null,  // { note } kept for the 5 s undo window
    freshId: null,      // newest note: the only one that animates in
    undoTimer: 0
  };

  // ----------------------------------------------------------- 2. STUDIO LINK
  // Inside Atelier this page runs in an iframe; the studio listens for these
  // messages. Opened on its own there is no parent, and nothing is sent.
  function post(message) {
    if (window.parent === window) return;
    try { window.parent.postMessage(message, "*"); } catch (e) { /* ignore */ }
  }
  function emit(name, data) {
    post({ type: "atelier:event", name: name, t: Math.round(performance.now()), data: data || {} });
  }

  // ---------------------------------------------------------------- 3. SAVING
  var statusEl = $("save-status");
  var statusTimer = 0;

  function setStatus(kind, text) {
    clearTimeout(statusTimer);
    statusEl.dataset.state = kind;
    statusEl.textContent = text;
  }

  // Write everything, then report what REALLY happened. store.save() reads
  // the value back, so "Saved" is only shown after a confirmed write.
  function persist() {
    setStatus("saving", "Saving…");
    var result = Store.save(state.notes);
    if (result.ok) {
      setStatus("saved", "Saved");
      statusTimer = setTimeout(function () { setStatus("idle", "Saved"); }, 1500);
      hideBanner("save");
    } else {
      setStatus("error", "Not saved");
      showBanner(result.message, "save");
    }
    return result.ok;
  }

  // Banner = a visible message that does not block the app.
  function showBanner(text, source) {
    $("banner-text").textContent = text;
    $("banner").dataset.source = source || "";
    $("banner").hidden = false;
  }
  function hideBanner(source) {
    if (source && $("banner").dataset.source !== source) return;
    $("banner").hidden = true;
  }

  // --------------------------------------------------------------- 4. ACTIONS
  function find(id) {
    for (var i = 0; i < state.notes.length; i++) if (state.notes[i].id === id) return state.notes[i];
    return null;
  }

  function addNote(text) {
    text = text.trim();
    if (!text) return false;
    var now = Date.now();
    var note = { id: Store.newId(), text: text.slice(0, Store.MAX_TEXT), createdAt: now, updatedAt: now, pinned: false };
    state.notes.push(note);
    state.freshId = note.id;
    persist();
    render();
    emit("add", { id: note.id, length: note.text.length, total: state.notes.length });
    return true;
  }

  function editNote(id, text) {
    var note = find(id);
    if (!note) return;
    text = text.trim();
    // An empty edit is treated as "never mind": the old text stays.
    if (!text || text === note.text) return;
    note.text = text.slice(0, Store.MAX_TEXT);
    note.updatedAt = Date.now();
    persist();
    emit("edit", { id: id, length: note.text.length });
  }

  // Delete right away, but keep the note for 5 seconds so Undo can bring it
  // back. That toast IS the confirmation: no blocking "Are you sure?" dialog.
  function deleteNote(id) {
    var note = find(id);
    if (!note) return;
    var ordered = visibleNotes();
    var idx = ordered.indexOf(note);
    var next = ordered[idx + 1] || ordered[idx - 1] || null;

    state.notes = state.notes.filter(function (n) { return n !== note; });
    state.lastDeleted = note;
    state.focusId = next ? next.id : null;
    persist();
    render();
    showUndo();
    emit("delete", { id: id, total: state.notes.length });
  }

  function undoDelete() {
    var note = state.lastDeleted;
    hideUndo();
    if (!note || find(note.id)) return;
    state.notes.push(note);
    state.focusId = note.id;
    persist();
    render();
    emit("delete", { id: note.id, undone: true, total: state.notes.length });
  }

  function showUndo() {
    clearTimeout(state.undoTimer);
    $("toast").hidden = false;
    state.undoTimer = setTimeout(hideUndo, 5000);
  }
  function hideUndo() {
    clearTimeout(state.undoTimer);
    $("toast").hidden = true;
    state.lastDeleted = null;
  }

  function togglePin(id) {
    var note = find(id);
    if (!note) return;
    note.pinned = !note.pinned;
    note.updatedAt = Date.now();
    state.focusId = id;
    persist();
    render();
    emit("pin", { id: id, pinned: note.pinned });
  }

  // Export: build a file in memory and "click" a hidden download link.
  function downloadText(text, filename) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportNotes() {
    var day = new Date().toISOString().slice(0, 10);
    downloadText(Store.exportText(state.notes), "quick-notes-" + day + ".json");
    emit("export", { count: state.notes.length });
  }

  // Import MERGES: notes with a new id are added, notes with a known id are
  // replaced by the imported copy. Nothing is removed.
  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { showBanner("Could not read that file.", "import"); };
    reader.onload = function () {
      var parsed = Store.parseImport(String(reader.result));
      if (!parsed.ok) {
        showBanner("Import failed: " + parsed.message, "import");
        emit("import", { ok: false, reason: parsed.message });
        return;
      }
      var added = 0, replaced = 0;
      parsed.notes.forEach(function (n) {
        var existing = find(n.id);
        if (existing) { Object.assign(existing, n); replaced++; }
        else { state.notes.push(n); added++; }
      });
      persist();
      render();
      showBanner("Imported " + parsed.notes.length + " note(s): " + added + " new, " + replaced + " updated.", "import");
      emit("import", { ok: true, added: added, replaced: replaced });
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------- 5. RENDER
  var listEl = $("notes");

  // Pinned notes first, then newest first.
  function visibleNotes() {
    var q = state.query.trim().toLowerCase();
    return state.notes
      .filter(function (n) { return !q || n.text.toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
  }

  function formatTime(ms) {
    var d = new Date(ms);
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // textContent: never inject HTML
    return e;
  }

  function renderNote(note) {
    var li = el("li", "note" + (note.pinned ? " pinned" : "") + (note.id === state.freshId ? " fresh" : ""));
    li.dataset.id = note.id;
    li.tabIndex = -1;  // focusable by script; arrow keys move between notes

    if (state.editingId === note.id) {
      var area = el("textarea", "edit");
      area.value = note.text;
      area.setAttribute("aria-label", "Edit note");
      area.rows = Math.min(8, Math.max(2, note.text.split("\n").length));
      li.appendChild(area);
      var hint = el("p", "meta", "Enter to save · Shift+Enter new line · Esc to cancel");
      li.appendChild(hint);
      return li;
    }

    var text = el("p", "text", note.text);
    text.title = "Click to edit";
    li.appendChild(text);

    var meta = el("p", "meta");
    var time = el("time", null, formatTime(note.createdAt));
    time.dateTime = new Date(note.createdAt).toISOString();
    time.title = new Date(note.createdAt).toLocaleString();
    meta.appendChild(time);
    if (note.updatedAt > note.createdAt + 1000) meta.appendChild(document.createTextNode(" · edited"));
    li.appendChild(meta);

    var actions = el("div", "actions");
    var pin = el("button", "ghost pin", note.pinned ? "Unpin" : "Pin");
    pin.type = "button";
    pin.dataset.action = "pin";
    pin.setAttribute("aria-pressed", String(note.pinned));
    var del = el("button", "ghost danger", "Delete");
    del.type = "button";
    del.dataset.action = "delete";
    actions.appendChild(pin);
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  function render() {
    // Error state hides everything else until the user decides.
    $("error-state").hidden = !state.blocked;
    $("composer").hidden = state.blocked;
    document.querySelector(".toolbar").hidden = state.blocked;
    document.querySelector(".keys-hint").hidden = state.blocked;
    if (state.blocked) {
      listEl.innerHTML = "";
      $("empty-state").hidden = true;
      $("count").textContent = "";
      return;
    }

    var shown = visibleNotes();
    var total = state.notes.length;
    var noun = total === 1 ? "note" : "notes";
    $("count").textContent = state.query.trim() ? shown.length + " of " + total + " " + noun : total + " " + noun;
    $("btn-export").disabled = total === 0;

    // Empty state: either nothing at all, or nothing matching the search.
    $("empty-state").hidden = shown.length > 0;
    $("empty-text").textContent = total === 0
      ? "No notes yet. Type above and press Enter."
      : "No notes match “" + state.query.trim() + "”. Press Esc to clear the search.";

    listEl.innerHTML = "";
    shown.forEach(function (n) { listEl.appendChild(renderNote(n)); });
    state.freshId = null;

    // Restore focus to the note the user was on (or into the editor).
    if (state.editingId) {
      var area = listEl.querySelector("textarea.edit");
      if (area) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
    } else if (state.focusId) {
      var li = listEl.querySelector('[data-id="' + CSS.escape(state.focusId) + '"]');
      if (li) li.focus();
      state.focusId = null;
    }
  }

  function startEdit(id) {
    state.editingId = id;
    render();
  }
  function finishEdit(save) {
    var id = state.editingId;
    if (!id) return;
    var area = listEl.querySelector("textarea.edit");
    state.editingId = null;
    if (save && area) editNote(id, area.value);
    state.focusId = id;
    render();
  }

  // ----------------------------------------------------------- 6. KEYBOARD
  function noteIdOf(node) {
    var li = node && node.closest ? node.closest("li.note") : null;
    return li ? li.dataset.id : null;
  }

  function moveFocus(fromId, step) {
    var items = Array.prototype.slice.call(listEl.querySelectorAll("li.note"));
    if (!items.length) return;
    var i = items.findIndex(function (li) { return li.dataset.id === fromId; });
    var next = items[Math.max(0, Math.min(items.length - 1, i + step))];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  function isTyping(target) {
    return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  }

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;

    // "/" jumps to search from anywhere except while typing.
    if (e.key === "/" && !isTyping(t) && !state.blocked) {
      e.preventDefault();
      $("search").focus();
      $("search").select();
      return;
    }

    // Esc: clears whatever box you are in.
    if (e.key === "Escape") {
      if (t.id === "search") {
        $("search").value = ""; state.query = ""; render(); $("search").focus();
      } else if (t.id === "new-note") {
        $("new-note").value = "";
      } else if (t.classList && t.classList.contains("edit")) {
        finishEdit(false);
      } else if (state.query) {
        $("search").value = ""; state.query = ""; render();
      }
      return;
    }

    // Editing a note: Enter saves, Shift+Enter adds a line.
    if (t.classList && t.classList.contains("edit")) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
      return;
    }

    // Down arrow from the composer or search drops into the list.
    if (e.key === "ArrowDown" && (t.id === "new-note" || t.id === "search")) {
      var first = listEl.querySelector("li.note");
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }

    // Keys while a note itself has focus.
    if (t.classList && t.classList.contains("note")) {
      var id = t.dataset.id;
      if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(id, 1); }
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (listEl.firstElementChild === t) $("new-note").focus(); else moveFocus(id, -1);
      }
      else if (e.key === "Enter") { e.preventDefault(); startEdit(id); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteNote(id); }
      else if (e.key === "p" || e.key === "P") { e.preventDefault(); togglePin(id); }
    }
  });

  // ---------------------------------------------------------- mouse / touch
  $("composer").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("new-note");
    if (addNote(input.value)) input.value = "";
    input.focus();
  });

  $("search").addEventListener("input", function () {
    state.query = $("search").value;
    render();
  });

  listEl.addEventListener("click", function (e) {
    var id = noteIdOf(e.target);
    if (!id) return;
    var action = e.target.dataset && e.target.dataset.action;
    if (action === "pin") togglePin(id);
    else if (action === "delete") deleteNote(id);
    else if (e.target.classList.contains("text")) startEdit(id);
  });

  // Clicking away from the editor saves it (like most note apps).
  // The text is committed right away (so clicking another note cannot lose
  // it); the redraw waits a tick so that click still lands on its target.
  // After Enter/Esc, finishEdit() has already cleared editingId, so this
  // does nothing.
  listEl.addEventListener("focusout", function (e) {
    if (!(e.target.classList && e.target.classList.contains("edit")) || !state.editingId) return;
    var id = state.editingId;
    state.editingId = null;
    editNote(id, e.target.value);
    setTimeout(function () { if (!state.editingId) render(); }, 0);
  });

  $("toast-undo").addEventListener("click", undoDelete);
  $("banner-close").addEventListener("click", function () { hideBanner(); });
  $("btn-export").addEventListener("click", exportNotes);
  $("btn-import").addEventListener("click", function () { $("import-file").click(); });
  $("import-file").addEventListener("change", function () {
    importFile($("import-file").files[0]);
    $("import-file").value = "";   // allow importing the same file twice
  });

  $("btn-fresh").addEventListener("click", function () {
    if (!Store.startFresh().ok) { showBanner("Could not reset storage. Try exporting the damaged data first.", "save"); return; }
    state.blocked = false;
    state.notes = [];
    setStatus("saved", "Saved");
    render();
    $("new-note").focus();
  });
  $("btn-backup").addEventListener("click", function () {
    downloadText(Store.readBackup() || "", "quick-notes-damaged-backup.txt");
  });

  // Another tab changed the notes: reload them so two tabs do not fight.
  window.addEventListener("storage", function (e) {
    if (e.key !== Store.KEY || state.editingId || state.blocked) return;
    var r = Store.load();
    if (r.ok) { state.notes = r.notes; render(); }
  });

  // ----------------------------------------------------------------- 7. START
  var loaded = Store.load();
  if (loaded.ok) {
    state.notes = loaded.notes;
    if (!loaded.fresh) setStatus("idle", "Saved");
  } else if (loaded.error === "corrupt") {
    state.blocked = true;
    $("error-detail").textContent = loaded.message + (loaded.backedUp ? "" : " (The backup copy could not be written either.)");
    $("btn-backup").hidden = !loaded.backedUp;
    setStatus("error", "Not loaded");
  } else {
    // No storage at all: the app still works, it just cannot remember.
    showBanner(loaded.message, "storage");
    setStatus("error", "Not saving");
  }
  render();
  if (!state.blocked) $("new-note").focus();

  post({ type: "atelier:ready", app: "quick-notes", notes: state.notes.length, storage: loaded.ok ? "ok" : loaded.error });
})();
