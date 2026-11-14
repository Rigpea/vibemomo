# Quick Notes

A small note-capture app: type, press Enter, it is saved. Notes stay after a
reload, can be edited, pinned, searched, deleted (with undo), exported and
imported. Proof that the studio workflow works for apps, not only games.

## Use

Open `src/index.html` in a browser (double-click works; no server needed).

| Do this | How |
| --- | --- |
| Add a note | Type in the top box, press Enter or click Add |
| Edit | Click the note's text (or focus it and press Enter). Enter saves, Shift+Enter adds a line, Esc cancels, clicking away saves |
| Delete | Delete button (or Del on a focused note). Undo is offered for 5 seconds |
| Pin / unpin | Pin button (or P). Pinned notes stay on top |
| Search | Type in the search box, or press `/` from anywhere. Esc clears |
| Move between notes | Up / Down arrows (Down from either box enters the list) |
| Back up / restore | Export downloads a `.json` file; Import merges one back in |

## Where notes are kept

`localStorage` of this browser, under the key named by
`<html data-storage-key="quick-notes">` in `src/index.html` (Atelier sets it to
the project's slug at creation, so two apps made from this template on the same
origin keep separate notes):

```json
{ "version": 1,
  "notes": [ { "id": "n_...", "text": "...", "createdAt": 1730000000000,
               "updatedAt": 1730000000000, "pinned": false } ] }
```

It is written after every change and read back to confirm, so "Saved" in
the header means the write really happened. If the stored data cannot be read,
the app shows an error with **Start fresh**; the unreadable text is first
copied to `quick-notes.backup` and can be downloaded from that screen. If
storage is full, a message says the change was not saved.

Opened from disk (`file://`), each browser decides how it scopes storage for
local files; export regularly if the notes matter.

## Files

- `src/store.js` — saving, loading, validation, import/export format. Start here.
- `src/app.js` — the interface: state, actions, rendering, keyboard.
- `src/style.css` — layout, light and dark colours, phone width, reduced motion.
- `selfcheck.mjs` — `node selfcheck.mjs` checks the manifest, that the page runs
  from `file://`, and exercises `store.js` against a fake storage.

## Inside Atelier

The page tells the studio it is running (`atelier:ready`) and reports each
`add`, `edit`, `delete`, `pin`, `import` and `export` as an `atelier:event`.
Opened on its own, nothing is sent and nothing breaks.

As an Atelier template: a template's title and slug are replaced by the project's name and slug at creation (text files only; `selfcheck.mjs` is not copied).
