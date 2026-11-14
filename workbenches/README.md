# Workbenches — the extension boundary

A workbench is one folder here, named after a project kind (`game`, `web-app`,
`action`, `audio`). A project chooses its kind in `atelier.json`; the studio
then loads:

- `server.mjs` (optional): `export async function build({ projectPath, project, manifest, version, outDir })`
  returning a small JSON note. Used by `POST /api/projects/:id/build`. Without
  it, the default static copy of `manifest.build.dir` applies.
- `server.mjs` may also `export function routes(route, deps)`: at startup the server calls it for every
  workbench folder that has one, so a workbench owns its routes. `route(method, pattern, handler, { bodyLimit })`
  is the server's own (`:name` params; the handler gets `{ params, query, body, req, res }` and returns JSON, or
  writes `res` itself). `deps` = `{ loadProject, loadRegistry, HttpError, emit }`. Add routes only; existing ones
  match first. `phone` uses it for `/api/projects/:id/phone/...` (docs/ARCHITECTURE.md section 10); its panel
  shows when the bundle's `manifest.devices` has a key.
- `panel.js` (optional): `export function mount(container, ctx)` and
  `export function unmount()`. `ctx` = `{ projectId, project, manifest, api, bus, previewFrame }`. `bus.events` is the main preview's;
  events from side-by-side frames are in `bus.frameEvents` with `frame` `'A'` or `'B'` (`frame-event`; `frame-reload` when a frame loads again and its entries go).
  The panel talks to the preview through `postMessage` (`atelier:tuning`,
  `atelier:cue`) and listens for `atelier:event` / `atelier:ready`.
  A product answers `atelier:tuning` with an `atelier:event` named `tuning`, data
  `{applied, ignored}` (keys set / keys skipped); products that do not answer still work (the panel says "sent").

`ctx` also has `saveUi(partial)` (merged into `project.ui`), `setCount(n)` (a number on the panel's tab) and, from
`client/components/dock.js`, an optional `command(cmd)` export the dock calls for `studio.show`.

`companion` is a panel-only workbench on every project, the first tab (docs/ARCHITECTURE.md section 12): a Claude
Code session with the studio's tools, its pins served by `server/index.mjs` rather than a `server.mjs` here.
`codex` is the same kind of panel beside it, the second tab (docs/ARCHITECTURE.md section 21): a Codex CLI session on
the person's own Codex login, drawn with the parts both share (`client/components/session-parts.js`).
`action` is a panel-only workbench. The `action` and `audio` panels also attach to
a game or web-app project (they read `manifest.tuning` and `manifest.cues`). A
project of kind `audio` also gets the `audio` build: the static copy plus the
`dist/audio/<cue>.wav` files the panel lists in `audio/`, with a note naming how many
it carried and how many `.wav` files it skipped by name.

Adding a workbench: create the folder, implement `panel.js` (and `server.mjs`
if the artifact is not a static copy), add the kind to the "New project" form
in `client/views/settings.js`, and record a decision in `docs/DECISIONS.md`.
Deeper integrations (engines, DAWs, mobile stores) are future work and should
start as a workbench with an honest "not available" state rather than a mock.
