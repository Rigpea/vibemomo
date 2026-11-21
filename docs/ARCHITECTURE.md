# Atelier architecture and contracts

Read this before touching the studio. It is the contract between the server
(`server/`), the browser UI (`client/`), the CLI (`bin/atelier.mjs`),
workbenches (`workbenches/`) and project templates (`templates/`).

## 1. Processes and folders

The optional repo-root `.env` is loaded by `server/lib/env.cjs` before paths or the port
are captured. The server, CLI, Electron app, restart command, and health check share this
configuration; shell environment variables take precedence. `.env` is never committed.

```
atelier/                      studio source (this repo; git; tags studio/vX.Y.Z)
  server/index.mjs            HTTP + SSE companion on http://127.0.0.1:4747
  server/lib/*.mjs            file stores, git versions, memory, tasks, preview, briefing
  server/api-utility/*.mjs    bounded Claude API tasks, budget, ledger, pricing
  client/                     static UI (ES modules, no bundler): index.html, app.js, styles.css
  workbenches/<kind>/         {server.mjs, panel.js} per kind: game | web-app | action | audio
  templates/<name>/           project templates copied on "New project"
  bin/atelier.mjs             CLI used by Claude Code and by hand
  scripts/                    checks, evidence, maintenance (restart.mjs stops only a verified server)
  tests/                      node --test
  .local/server.pid           RUNTIME (gitignored): {pid, platform, port, startedAt} of the running server;
                              ATELIER_PID_FILE moves it (tests use a temp path). /api/health reports the same.
~/.atelier/                   DURABLE studio data (ATELIER_DATA_DIR), survives studio upgrades
  registry.json               projects list + studio-default settings  {schemaVersion}
  memory/<id>.json            user-wide and tool-scoped memory records
  budget.json                 ceilings, reserve, observed balance, pause flag
  usage/ledger.jsonl          one line per API call
  sessions/<id>.json          studio sessions (continuation summaries)
  secrets.json                { "STUDIO_ANTHROPIC_API_KEY": "...", "CLAUDE_CODE_OAUTH_TOKEN": "...", "CLAUDE_CODE_OAUTH_TOKEN_SAVED_AT": iso }
                              never served, never logged (the token: section 7, Sign-in)
<project>/                    one folder per product, its own git repo (ATELIER_PROJECTS_DIR/<slug>)
  atelier.json                product manifest (COMMITTED): kind, entry, build, tuning, cues
  src/ ...                    editable sources (whatever the template defines)
  .studio/                    project records, EXCLUDED from git via .git/info/exclude
    project.json versions.json decisions.json feedback.json releases.json resources.json
    memory/<id>.json  tasks/<id>/{task.json,brief.md,result.json,events.jsonl}
    BRIEFING.md               generated continuation briefing
  CLAUDE.md                   generated (excluded) unless the user owns one; imports .studio/BRIEFING.md
```

Paths: every file operation on a project is confined to that project folder
(`server/lib/paths.mjs: insideProject()`); the studio repo itself is never a
project unless explicitly registered as one ("studio self-improvement").

## 2. Records (JSON shapes)

All records carry `id`, `createdAt`, `updatedAt` (ISO 8601). Ids: `p_`, `v_`,
`d_`, `m_`, `t_`, `f_`, `r_`, `rel_` + 10 base36 chars. Writes are atomic
(write temp + rename). Lists are arrays in one file except memory and tasks
(one file/folder per record).

### project.json
```json
{ "id":"p_..", "name":"Room One", "slug":"room-one", "kind":"game",
  "purpose":"", "audience":"", "inspiration":"", "direction":"",
  "currentPiece": {"title":"", "why":"", "acceptance":[]},
  "nextRelease":  {"title":"", "definition":[], "targetVersionId":null},
  "components":[{"name":"","version":"","role":""}],
  "unresolved":[{"id":"u_..","text":"","createdAt":"","taskId":"(carried from a task only)","taskTitle":"","at":""}],
  "ui": {"layout":{}},
  "template": {"name":"game-room-one", "at":"", "projectName":"Room One"},
  "workerModel":"claude-fable-5-2",
  "createdAt":"", "updatedAt":"" }
```
`ui` holds project-scope UI preferences. `template` is set by `createProject` from a template and
absent otherwise, also on projects made before it existed; `projectName` is the name the copied
files carry, which a later rename does not change. It is patchable: `{ name }` of an existing
template of the project's kind, anything else in the value ignored and `at` and `projectName`
stamped by the server (`projectName` is the project's name at that moment); `null` removes the
record. Any other value is 400 `invalid_input`.

`workerModel` is the model this project's workers start on when their task names none (section 17); absent means the
studio default: the registry's `settings.workerModel`, else the built-in `WORKER_MODEL` (`claude-fable-5-2`). It is
patchable: one of `CONSOLE_MODELS` (server/lib/models.mjs), or `null` or `"default"` to remove it; anything else is
400 `invalid_input` naming the choices, and the whole patch is refused. The CLI sets it with
`atelier project set worker-model <model|default>` and reads it with `project get worker-model`; `atelier projects`,
the briefing's Identity (`Worker model:`) and the Focus panel's Identity show it, each with the stored studio default
when the project has none.

### versions.json  (array; one entry per checkpoint; the git tag is `atelier/<id>`)
```json
{ "id":"v_..", "n":3, "sha":"<40hex>", "label":"Jump feels floaty", "note":"",
  "state":"experiment|integrated|selected|user-tested|released|recheck",
  "origin":"user|claude-code|codex|restore-safety|import|studio",
  "parentId":"v_..", "pieceTitle":"", "taskId":null, "role":"option|finish",
  "userPreferred":false,
  "verified": null,
  "userEvidence":[ "f_.." ],
  "createdAt":"" }
```
`role` is what the version is to its task: `option` from `checkpoint --task` on an explore task,
`finish` from what `task finish` kept (a dirty tree, or commits made by hand). It is absent otherwise
and on older records; with no role, a version tagged with an explore task reads as an option.
`baseSha`, from `checkpoint --task`, is the task's base when the version was made: ingest counts the
version from it, else from the version's merge base with the task's base, else from the task's base.
`verified` is `null` or `{"by":"studio-check|claude-code|manual","note":"","at":""}`.
Three things stay distinct on a version: `userPreferred` (your creative
preference), `verified` (technical verification), `userEvidence` (feedback ids
from real users).

### decisions.json (array)
`{ id, text, reason, status: "accepted|superseded|open", versionId, taskId, supersedes, createdAt }`
### feedback.json (array)
`{ id, source: "user|playtester|bug|release", text, versionId, status: "new|triaged|resolved", taskId, createdAt }`
### releases.json (array)
`{ id, versionId, artifact: {path, sha256, bytes}, readiness: {items:[{text, met:bool, evidence}]}, notes, readinessSummary, builtLocal, createdAt }`
`notes` is the release notes as the person typed them (empty for none). `readinessSummary` is the count the
server read from `project.ui.readiness` at the build. A record without `readinessSummary` is older: its `notes`
held that count, so no client treats it as release notes. `builtLocal` is `createdAt` as the server's clock read
it (`2026-11-04 21:16`): the date line of RELEASE-NOTES.md and the Built line of Export ready.
### memory/<id>.json  (user-wide in ~/.atelier/memory, project in <project>/.studio/memory)
```json
{ "id":"m_..", "kind":"preference|observation|decision|method|resource|feedback|lesson|constraint",
  "scope":"user|project|session|tool", "scopeRef":"p_..|session id|tool name|null",
  "status":"explicit|inferred|verified|retracted",
  "text":"Try previews before discussing implementation.",
  "tags":["workflow"],
  "provenance":{"source":"brief|user|claude-code|api-draft|studio","ref":"","evidence":""},
  "links":{"versions":[],"files":[],"tasks":[],"urls":[]},
  "supersedes":null, "supersededBy":null, "createdAt":"", "updatedAt":"" }
```
Correction = new record with `supersedes`; the old one gets `supersededBy` and
`status: retracted`. Retrieval never returns retracted records. Deletion removes
the file and appends `{ts, op:"delete", id}` to `<store>/memory-log.jsonl`.

### tasks/<id>/task.json
```json
{ "id":"t_..", "projectId":"p_..", "title":"", "request":"", "inspiration":"",
  "mode":"teach|explore|handle", "route":"claude-code|api-utility|direct",
  "status":"draft|ready|working|review|done|needs-input|interrupted|cancelled",
  "context":{"workspacePath":"","studioPath":"","baseVersionId":"","baseSha":"",
             "currentPiece":{},"nextRelease":{},"files":[],"preferences":[],
             "decisions":[],"constraints":[],"resources":[]},
  "scope":"", "acceptance":[""], "unresolved":[""],
  "result": null,
  "question": null,
  "startedAt":null, "heartbeatAt":null, "createdAt":"", "updatedAt":"" }
```
`result` becomes `{"summary":"","resultSha":"","versionId":"","versionIds":[""],"verification":[""],"unresolved":[""],"filesChanged":[""],"finishedAt":""}`;
`versionIds` lists the task's own versions in n order; `versionId` is the last of them, so a clean finish
with HEAD on the base still has a version when tagged options exist. A version tagged with this task
counts whether or not it is an ancestor of HEAD. An untagged one counts only with origin `claude-code`
(the CLI without `--task`), as an ancestor of HEAD, newer than the start, not an ancestor of the base and
with files other than the base's. `user` (Keep version), `restore-safety` and `import` versions are never a
task's, and ingest does not tag them. For `user` that holds by the route, not by the client's good manners:
`POST /api/projects/:id/versions` takes only `label`, `note` and `state` from the body and always writes origin
`user`, so a tag or a role comes only through the CLI's `--task`, which checks the task's status and mode. A result written before this field has only `versionId`.
The list routes, the task route, ingest's answer and the bundle's task summaries add `result.versionNumbers`,
the n of each version the result names, `null` for one that is gone, and `result.versionRoles`, its role
(`option`, `finish` or `null`); both are derived on read and never stored. On an explore task the client calls a
`finish` version beside options a leftover: it is not offered by Try it or Compare. `versionId` stays the last of
`versionIds` all the same. Ingest gives an untagged version of an explore task `role: option` along with its
`taskId`, so the draft's linear rule stays only for records with no role. Ingest counts the commits
and files of every version in `versionIds` against the base, each once; with no `versionIds` it counts base..HEAD.
`question` becomes `{"text":"","askedAt":""}`.
`workerModel` (optional, absent by default) is the task's own worker model, one of `CONSOLE_MODELS`: given at create
(`POST /tasks { workerModel }`), set or cleared later (`PUT /tasks/:tid/worker-model`, or `POST /workers { workerModel }`
at a start), each change a `worker_model` event `{ model, before, text }`; it outranks the project's and the studio's
(section 17).
`events.jsonl`: `{ts, type, actor:"studio|claude-code|codex|user|api|companion", data}` with types
`created ready base_moved opened handed_to_console queued worker_model worker_interrupted started heartbeat note question finish_requested finished ingested cancelled interrupted`
(actor `codex`: the CLI run from a Codex session, `ATELIER_ACTOR`; `finish_requested`: a finish recorded where `.git`
could not be written, beside `finish-request.json`, until the studio keeps the version: section 17, Codex workers).
Status is DERIVED from events + result (never set by hand): a `working` task
whose heartbeat is older than 30 min with no finish shows as `interrupted`
(recoverable: reopening keeps the same record). `brief.md` is the full
human/Claude-readable handoff. Its sections, in order: Request, **Must stay the same** (the project's fixed rules,
section 23; also when there are none, saying so), Inspiration (only when typed or when the board holds cards),
References (section 25; only when the project keeps references: the ones that match the request),
Project, **Current piece (context)** (the project's current piece, its acceptance items and the
next release, for orientation only), Scope, **Acceptance conditions** (the task's own
`acceptance`, as given in the composer; empty prints "none stated; verify what the request asks
for"; a task no longer inherits the current piece's acceptance), Preferences, Accepted decisions,
Relevant files, Resources, Unresolved, How to report back.

### registry.json (~/.atelier)
`{ schemaVersion:1, projects:[{id, name, slug, path, kind, createdAt, lastOpenedAt}], settings:{ui:{}, apiUtility:{model:"claude-haiku-5-5"}}, activeProjectId }`
`settings.workerModel` (optional) is the studio's default worker model, one of `CONSOLE_MODELS`; absent means the
built-in `WORKER_MODEL` (section 17). `settings.skillDepartments` is the departments map (section 18).
`settings.appearance` (optional) is the person's own look for the studio, only what is off its default:
`{ accent?: { dark?, light? }, density?: "compact", textSize?: "small"|"large"|"larger", radius?: "sharp"|"round", motion?: "reduced" }` (section 24).

### budget.json (~/.atelier)
```json
{ "grantUsd":200, "reserveUsd":20, "activeAllocationUsd":180, "liveCeilingUsd":40,
  "cycle":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD","source":"user-entered|unknown"},
  "observed":{"balanceUsd":null,"asOf":null,"note":"Console > Billing > Promotional credits"},
  "otherAppsReserveUsd":0, "paused":false, "pausedReason":null, "pausedAt":null, "maxConcurrent":2,
  "maxOutputTokens":2000, "maxRetries":1 }
```
`observed.asOf` is stored exactly as sent: a plain `YYYY-MM-DD` (the day the person entered;
`observedAt` is accepted as the same field) stays a plain date and is returned unchanged, never
shifted through a timezone; ISO timestamps already stored are kept. A balance saved without a
date gets today's local date. `pausedAt` (ISO) is set when pausing (by the person or
automatically) and cleared on resume. `pausedReason` is `user`, `ceiling_reached` or
`observed_balance_exhausted`. Only `user` has a Resume control; after any budget patch a pause the
studio set is rechecked, lifting when its cause is gone and naming the other cause if that one now
holds; it ignores `paused:false`, which lifts only a pause by the person. The `budget_paused` refusal reads "API utilities are paused (by you on YYYY-MM-DD). Resume
them in Budget to run this." / "(the live ceiling was reached on YYYY-MM-DD). Raise the ceiling or
set a new cycle in Budget to run this." / "(the observed balance reached the reserve on …). Enter a
newer balance in Budget to run this.", each followed by "Nothing was spent." (no date for records
paused before `pausedAt` existed).
### usage/ledger.jsonl
`{ts, id, task, projectId, taskId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, pricingVersion, durationMs, ok, error, cancelled}`
Estimates are the studio's own; the provider's shared balance is only what the
user observed in the Console (`budget.observed`). Never conflate them in the UI.

### atelier.json (project manifest, committed)
```json
{ "kind":"game|web-app|audio", "name":"Room One", "entry":"src/index.html",
  "build":{"type":"static","dir":"src","out":"dist"},
  "tuning":"src/tuning.js",
  "cues":[{"id":"jump","label":"Jump","trigger":"Space"}],
  "readiness":["Core loop playable","Controls explained","Objective + restart","Audio cue on event","Export runs by double-click"] }
```
`tuning` points at a file of the form `window.ATELIER_TUNING = {...};` (game and
action workbenches edit the JSON object inside). `cues` drive the audio workbench.

Audio panel messages between the studio and the preview frame:
```
studio -> product  {type:"atelier:cue", id}
product -> studio  {type:"atelier:event", name:"cue", data:{id, played, reason?, seconds?, peak?}}     no answer within 1 s: "sent · no acknowledgement"
                   seconds = scheduled length; peak = largest absolute sample of the same cue offline
                   (Sound Sketch sends both). Both present: "played · 0.08 s · -12 dB" ("silent" at peak 0);
                   otherwise plain "played", as for Room One
studio -> product  {type:"atelier:render", id}                                        main preview frame only
product -> studio  {type:"atelier:event", name:"render", data:{id, wav, seconds, peak, sampleRate}}
                   wav = base64 of a complete 16-bit PCM RIFF/WAVE; peak = largest absolute sample
product -> studio  {type:"atelier:event", name:"render", data:{id, error}}            failed; `reason` is read the same way (Sound Sketch sends it)
                   no answer within 3 s: "sent · no render handler"; a later answer still counts
```
The panel posts a render answer to `POST /api/projects/:id/audio/render`, only for a cue the person
asked to render. The bus passes `wav` to its listeners but keeps it out of `bus.events`.
A product may add `tuning` to the render answer, the values it rendered with (Sound Sketch does). The server keeps them
as `dist/audio/<id>.tuning.json`, written after the WAV and removed when an answer has none, and a render stands against
`manifest.tuning` by those values, never by file times, because tuning applied live reaches the file only on Save to file.
The panel asks `GET .../audio/renders` on mount, on a preview reload and on a bundle refresh, so a file on disk
outlives the panel. A row counts a cue's plays from `bus.events`: `cue {id, played:true}` and events named after
the cue, which may carry `{seconds, peak, how}` (Sound Sketch does; Room One sends no numbers and keeps "fired N×").
`dist/` is in `.git/info/exclude` (`ensureExcludes`), so a render is not in a version; `git clean`
on Restore leaves excluded files alone, and a build only replaces `dist/<slug>-v<n>/`.

## 3. HTTP API (JSON; errors are `{error:{code,message}}` with 4xx/5xx)

```
GET   /api/state                               studio info, projects, active project, budget summary, utility status
GET   /api/projects                            [registry entries + state]
POST  /api/projects            {name, kind, template, path?}   create (copy template, git init, excludes, first checkpoint)
POST  /api/projects/import     {path}                           register an existing folder (git init if needed)
GET   /api/projects/:id                        {project, versions, decisions, feedback, releases, tasks:[summary, with intent], changes, manifest}
PATCH /api/projects/:id        partial project.json; {unresolvedAdd:[{text}]} and {unresolvedResolve:[ids]} change the stored list by item (unknown ids ignored), where {unresolved:[...]} replaces it; {ui:{…}} merges one level deep into project.ui (a key set to null is removed; a ui that is not a map answers 400)
GET   /api/projects/:id/changes                {dirty, files:[{path,status}], sinceVersionId}
GET   /api/projects/:id/versions
POST  /api/projects/:id/versions {label, note, state?, origin?}  checkpoint; 409 if nothing changed (returns {existing})
PATCH /api/projects/:id/versions/:vid {state?, userPreferred?, note?, verified?, label?}
POST  /api/projects/:id/restore  {versionId}   -> {restoredTo, safetyVersionId|null}
GET   /api/projects/:id/compare?a=v_..&b=v_..|head   {a,b,files:[{path,status,additions,deletions}],diff}   (diff capped at 200 KB)
GET   /api/projects/:id/files?path=<rel>[&max=<bytes>]   {path, type:"dir"|"file", entries|content, text, bytes}   (<= 512 KB;
      text:false when not UTF-8 or holding a NUL byte; with max a longer file answers its first bytes, truncated:true, shownBytes)
PUT   /api/projects/:id/files   {path, content} write (confined to project; refuses .git and .studio)
POST  /api/projects/:id/build   {notes?}       {release:{id,...}, artifact:{path,sha256,bytes}, versionId}; notes at most 20 KB of UTF-8 text (400 invalid_input above that, before the last export is touched); non-blank notes are written to RELEASE-NOTES.md in the export (heading, the text as typed, a last line with the local date and time and the version sha)
GET   /api/projects/:id/release-notes-draft?version=v_..   {versions:[{id,n,label,note}], since:{id,n,label,note}|null, earlierRelease, releasedAs:{zip,date}|null, sibling}; versions are the records whose commit is in git rev-list <last release sha>..<version sha>, oldest first; since is the newest release's version that still has a record; releasedAs is set when the version's commit is since's; sibling when neither commit descends from the other, or when both are versions of one explore task, neither is `role: "finish"` and they do not both have a role (the old linear options: versions is then the exported option alone); client/components/release-notes.js formats this
GET   /api/projects/:id/template-drift   {template, folder, available, reason?, files:[{path, same, projectHas, ownValues?}], behind, note}; template is null when the record names none, available false when that template is gone or the name cannot be one (a separator, a leading dot, . or ..: reason "not a template name"); files are each file under the template's src/ against the project's after renameTemplateText (line endings aside), plus atelier.json for its cues and readiness lists only; the template manifest's tuning file has ownValues and is not counted in behind; reads only
GET   /api/projects/:id/template-drift/diff?path=<file>   {path, diff, truncated, note?}: the unified diff from the template's file after the rename to the project's, compared as the drift compares it (for atelier.json its two lists alone, with a note); 400 not_in_drift for a path the drift does not count as differing (outside the list, the tuning file, a matching file), 400 not_text for a binary file; reads only
POST  /api/projects/:id/audio/render {id, wav, seconds, peak, sampleRate, tuning?}  writes dist/audio/<id>.wav and its sidecar <id>.tuning.json atomically -> {path, bytes, seconds, peak, sampleRate, staleAgainstTuning, tuningUnknown}; id ^[a-z0-9][a-z0-9-]{0,40}$ and no Windows device name; wav base64 of RIFF....WAVE, at most 20 MB (413 over); peak above 1 is 400; bytes is measured, the other facts are the product's; 409 file_in_use when the file is open elsewhere
GET   /api/projects/:id/audio/renders          [{id, path, bytes, seconds, peak, sampleRate, mtime, staleAgainstTuning, tuningUnknown}] one per dist/audio/<cue>.wav, read from the file; a file that cannot be decoded has {error} instead of seconds, peak and sampleRate; stale when a key in both manifest.tuning and the sidecar differs; tuningUnknown when the project has a readable tuning file and the render no readable sidecar
GET   /api/projects/:id/audio/renders/:cue     the WAV bytes as audio/wav; 400 for an id that could not be a cue, 404 when there is no file
GET   /api/projects/:id/releases
GET|POST|PATCH /api/projects/:id/decisions[/:did]
GET|POST|PATCH /api/projects/:id/feedback[/:fid]
GET   /api/projects/:id/tasks                  tasks, each result with versionNumbers and versionRoles (GET /api/tasks too)
POST  /api/projects/:id/tasks   {title, request, inspiration?, mode, route?, scope?, acceptance?, files?}  -> task (status ready)
GET   /api/projects/:id/tasks/:tid             {task, events, brief, result, versionNames:{[versionId]:"#n label"}}
POST  /api/projects/:id/tasks/:tid/open        launches Windows Terminal with `claude` in the project folder; returns {launched:bool, command}
POST  /api/projects/:id/tasks/:tid/ingest      reads result.json + git log since baseSha -> versions/decisions updated, result.unresolved appended to the project's unresolved (same text once); status done
PATCH /api/projects/:id/tasks/:tid  {action:"cancel"|"ready"|"answer", text?}
GET   /api/memory?scope=user|project|all&projectId=&q=&kind=&limit=   direct retrieval (scored keyword/tag match; no model)
POST  /api/memory              record (scope decides the store)
PATCH /api/memory/:id          {text?, status?, tags?} -> creates a superseding record when text changes
DELETE /api/memory/:id
GET   /api/briefing?projectId=  {markdown, sources:[ids]}   deterministic continuation briefing
GET   /api/guide               docs/GUIDE.md as text/markdown (the in-app help); 404 text/plain when missing
GET|POST|PATCH /api/resources[/:rid]   capability catalogue (user-wide + project)
GET   /api/budget ; PATCH /api/budget  {liveCeilingUsd?, observed?, paused?, cycle?, otherAppsReserveUsd?}
GET   /api/usage?projectId=    {totals:{costUsd,calls,byModel,byTask,byProject}, recent:[...]}
POST  /api/utility/:task       {projectId?, taskId?, input:{...}} -> {runId, output, usage, costUsd, validated:true} | 402 {error:{code:"budget_paused"}}
POST  /api/utility/cancel      {runId}
GET   /api/utility             {configured, model, availableTasks:[{name, inputs, outputs}], quality:{...}}
GET   /api/evidence/models     {probes:[...], sessions:[{file, models:{id:count}}]}
GET   /api/settings ; PATCH    studio-default UI settings (registry.settings.ui); PATCH {appearance} is checked and stored by server/lib/appearance.mjs (section 24): 400 invalid_input, 400 low_contrast, 409 token_locked, 409 rules_unread; null resets
GET   /api/settings/appearance {stored, effective, locks:{<control>:{token, value, ruleId, text}}, rulesProject:{id, name}|null, rulesUnread}: the look, and what the studio project's fixed rules lock (also in GET /api/state as appearance)
GET   /api/projects/:id/inspiration            {cards:[...], defaultTags, limits, where:{file, images}}: the inspiration board in board order (section 22)
POST  /api/projects/:id/inspiration            {kind: image|link|color|note, tags?, why?, after?} + image {data (base64), name?} | link {url, title?} | color {hex, name?, from?} | note {text} -> the card; 413 too_large and 415 unsupported_image for an image, 400 unsafe_link for a link to a local or private address or another scheme, 409 board_full; body limit 24 MB
PATCH /api/projects/:id/inspiration/:cid       {tags?, why?, text? (note), hex?, name? (color), title? (link), refetch?: true (link)} -> the card; a card keeps its kind
POST  /api/projects/:id/inspiration/move       {id, before: <card id>|null} -> {order:[ids]}; null is the end
DELETE /api/projects/:id/inspiration/:cid      {removed}; the card's image file goes with it
GET   /api/projects/:id/inspiration/files/:name  the image bytes under the type read from them, nosniff and a sandboxing Content-Security-Policy; 404 for any name that is not a card's own file
GET   /api/projects/:id/rules                  {rules:[...], kinds, limits, locked:[{name, value, ruleId, text}], where:{file}}: the fixed rules in the order added (section 23)
POST  /api/projects/:id/rules                  {text, kind: color|type|layout|motion|tone|behaviour, why?, token?: {name, value}} -> the rule; 400 invalid_input with a sentence for a missing text or kind or a token name or value that is not fit, 409 token_locked when another rule locks that property, 409 rules_full
PATCH /api/projects/:id/rules/:rid             {text?, kind?, why?, token?: {name, value}|null} -> the rule; null takes the lock off
DELETE /api/projects/:id/rules/:rid            {removed}
GET   /api/projects/:id/references             {entries:[...], kinds, limits, where:{file}}: what the project keeps to build from, newest first (section 25)
POST  /api/projects/:id/references             {kind: link|snippet|prompt|note, title?, url (link), text (the others), language? (snippet), useFor?, source?, tags?} -> the entry; a link waits for its page's title; 400 unsafe_link for a private or local address or a scheme that is not http(s), 413 too_large for a text over its kind's limit, 400 invalid_input with a sentence for the rest, 409 references_full
PATCH /api/projects/:id/references/:rid        {title?, url?, text?, language?, useFor?, source?, tags?, refetch?} -> the entry; a changed url or refetch: true fetches the title again; an entry keeps its kind
DELETE /api/projects/:id/references/:rid       {removed}
GET   /api/projects/:id/visualizer             {entry, reason, sheets:[{file, from, lines, declarations}], skipped:[{href, from, reason}], colors, type:{families, sizes, base, rootPx}, spacing, radii, motion:{durations, easings}, rules (each locked token checked), locks, board (the colour cards, each with the nearest colour in the files), summary, limits}: the design the web entry's stylesheets hold; reads only (section 26)
POST  /api/studio/show         {projectId?, view?, panel?, point?, file?, line?} -> emits studio.show; {...checked, delivered} (section 11)
GET   /api/runs?projectId=<id>|all   {runs:[{id, kind, projectId, name, state, reason, startedAt, endedAt, latest, latestAt, waitsFor}], since, keepHours, note}; running first, then newest ended; 400 for an id that is not p_…; all when left out (section 16)
GET   /api/events              SSE: project.changed, task.changed, memory.changed, budget.changed, status, utility.progress, studio.show, runs.changed {projectId, run}, inspiration.changed {projectId, cardId?, action?}, rules.changed {projectId, ruleId?, action?}, references.changed {projectId, refId?, action?}
GET   /preview/:id/head/<path>                 working tree of the project (static)
GET   /preview/:id/:vid/<path>                 files of a checkpoint (git show), same relative layout
GET   /preview/:id/:ref/                       302 to the ref's entry, the query kept: head -> the current atelier.json's entry; a version -> the entry its own atelier.json names at that commit, else the current one (`entryAt` in server/lib/preview.mjs)
```
A version can keep another entry than the project has today, so a frame that shows a version asks for the bare root
and lets the server choose (`previewStart` in client/api.js: Try, a version's Try it, both Side by side frames); the
files on disk are asked for by the current manifest's entry. An entry counts only as a path inside the folder
(`entryPath`); a version with no manifest, one that is not JSON, or one whose entry is empty or leaves the folder
opens on the current entry. The Workbench reads the page a version opened on back from the frame for the line above it.
Utility tasks (api-utility): `summarize-doc`, `extract-metadata`, `tag-resource`,
`group-feedback`, `draft-session-summary`, `draft-memory-candidates`,
`prepare-context`, `explain`. Each has an input schema, an output JSON schema,
a token cap and a cache-able system prefix.

## 4. UI structure (client/)

The shell (`client/index.html`, `client/app.js`): a top bar (the mark, the project picker
`components/project-picker.js`, the status words, theme and help), a view row (Workbench · Learning · Inspiration · Claude Code · Tasks ·
Memory · Budget · Settings, keys 1–8; Learning is section 19, Inspiration section 22, its Fixed rules part section 23, its References part section 25 and its Visualizer part section 26; the version pill at the right on the Workbench), then the main column and the right
panel. The left rail (`components/rail.js`) is rendered but out of the layout since the reference pass (DESIGN.md
section 8); the picker switches projects.

The Workbench (`client/views/workbench.js`), composed after the reference concept (DESIGN.md section 8): the left
column (`aside.wb-left`: "Project · n pages", the Page panel in a dock of its own with `bare: true` and `kinds`
limited to `page`, then "Last version" and Compare); the stage (`section.wb-stage`: the head with the device picker
Desktop · Mobile (Phone only when the studio setting `ui.phonePanel` is true: `panelKinds(manifest, { phone })`), Select, Expand, Try and More; `div.stage-cap` with `capWords`; the preview iframe for
`/preview/:id/head/` or `/preview/:id/:vid/` in `div.preview-wrap` with the side slot and the ghost;
`div.stage-foot` with `stageFoot` (`footWords`, Live's failed or invalid reason, and no line at all while the frame
shows the live server); the pure words in `components/stage-words.js`); the right panel
(`components/collab.js`: the task inspector `components/task-inspector.js` for the task in focus, the tasks as rows
under it, the composer behind New task, Focus behind its button); the timeline (`components/working-now.js`, section
16), hidden unless the layout pref `runsShown` is true (default false, so the preview takes its height; the More
menu's last item "Show runs under the preview", a `menuitemcheckbox`, flips it through `runsToggle` at the studio
scope, or at the session or project scope when a value there wins; decision row 149); the band (the dock, `components/dock.js`, with every kind but `page`); the version strip; the status line; the
Versions drawer over it all. The device set to Phone calls `stageSide.force(true)` and `dock.toSide('phone', true)`,
so the phone's screen fills the slot, which then stands in the middle (`.preview-wrap.stage-phone`). Expand (`f`)
adds `.focus` to the Workbench: the columns, the timeline, the band and the strip step aside. The pages column, the
inspector and the timeline resize by `components/splitter.js` on their edges; the sizes are the layout prefs
`leftWidth`, `collabWidth` and `timelineHeight` (`components/layout.js`), the inspector's applied by `applyLayout`. Status words:
Retrieving resources · Ready for Claude Code · Working · Ready to try · Needs your input · Saving · Interrupted ·
Paused (budget), each a word with a dot. The studio behind the window changing (a restart, a new version) puts up
a toast with Reload (`noteStudioChange` in app.js): the window runs what it loaded until then.

Task rows (`client/components/task-list.js`, shared by the Task tab and the Tasks view) carry an **Activity**
part (`client/components/task-activity.js`). Its session is the one named by the task's latest
`handed_to_console` event, else a session from `GET /api/console/sessions` whose `taskId` is the task; a latest
`opened` event (the terminal route) gives one sentence instead, because the studio sees no terminal session's calls.
The record is read with `GET /api/console/sessions/:id` when the line is opened, and at once for a session listed or
heard as running. Inside: `brainLine(session.model)`, the intent line (`intentLine` in `companion-words.js`: the
request's first sentence when it says more than the title; none when it would repeat it; the bundle's task summaries
carry it as `intent`, computed on the server, since no request rides the bundle), the state from `companionState` (with the
reasons "not started" for a record with no turns and the question's first words for Needs you), then
`toolRows(events, trajectoryLabel)` over every assistant turn's `events` in order plus the live run's. The time column
is each tool event's `ms` (milliseconds from the run's start, written by `server/lib/console.mjs`); events from before
`ms` existed show no time. Live: the list subscribes to `app.on('console')` when created and unsubscribes in
`destroy()`; `console.chunk` for a session a row holds appends to that row in place, a chunk for any other session is
ignored, the clock repaints the state line once a second only while a mounted session runs, and `console.done` /
`console.error` read the record once more, keeping the live events' objects so an opened result stays open.

The **version strip** (`client/components/version-strip.js`) sits in `div.versions-bar` beside the Versions button
(`views/workbench.js` `renderDrawer` updates it with the bundle and `ui.ref`; it draws nothing for a project that is
not the one on screen). `stripModel(versions, tasks, { currentId, viewingId, dirty })` is pure: marks in order of
`n` (index, current = `changes.sinceVersionId`, viewing = `ui.ref` when not head, released = state `released`,
preferred = `userPreferred`, name `#n label · when · state`), the dirty stub after the current mark, and bars. A
task's versions are `result.versionIds` (or `versionId`) united with the versions whose `taskId` is the task; a task
with any of them gets a bar from the first to the last index. A task whose status is `working` or `needs-input` gets
a live bar from its base (the last version whose `createdAt` is at or before the task's `startedAt`, else the current
version, else the newest) to the right edge. Lanes are assigned greedily by start, at most three; the rest is
counted in `more`. Marks are `MARK_W` (28) px apart by index, never by time; the stub adds `STUB_W` (18). The DOM
keeps one tab stop per group (marks, bars) with arrow keys, keeps the scroll position and the focused element across
redraws, stays at the end when it was there, and scrolls to the newest on a project switch. A mark calls
`app.toggleVersions(true, { versionId })`, which focuses `tr#version-row-<id>` (`focusVersionRow`) instead of the
drawer's first control; a bar calls `app.showPanel('task', { taskId })`, which focuses the task row's Activity
summary, else its `.task-sum` (`collab.js` `taskTarget`). Every task list (`listTasks`, the bundle's tasks,
`GET /api/tasks`) carries `startedAt` and `finishedAt` (from `result.finishedAt`), so neither the strip nor a row
needs the detail to know when a task ran.

**Working now** (`client/components/working-now.js`) is its own row between the dock and `div.versions-bar`, so the
marks never move when it comes or goes; hidden by default (`runsShown`, above), and while hidden it is drawn empty so
its 30 s clock stops; the Processes tab (`components/process-graph.js`) reads the same `app.state.runs`; section 16 has its model, the rail's dot and the app bar's run chip.

The **ghost marker** (`client/components/ghost.js`, "who is working where") is one controller per Workbench mount,
created in `views/workbench.js` with the frame, `reload: tryHead` and `{ el, button }`; its `div.preview-ghost` is
appended to `div.preview-wrap` (outside the frame, which reloads), `setProject(bundle)` runs on a project change,
`leave()` when the project leaves the screen, `destroy()` on unmount. Inputs, each a reported fact: tool calls from
`app.on('console')` (`console.chunk` with `kind: 'tool'`, kept as `{ sessionId, name, summary, at }`, at most 50, only
while a project is on screen); sessions from `GET /api/console/sessions?projectId` at `setProject` and, for a session
first heard mid-run, its record `GET /api/console/sessions/:id` read once (a call counts only once its session's
`projectId` is this project); started / done / error set `running` and `endedAt`; pins from `GET /companion/pins`
(again on `pins` for this project); the readout on screen from `app.emit('ghost-readout', { projectId, source: 'page'
| 'phone', selector, element, files })`, sent by the Page and Phone panels when a readout with candidates arrives and
with no selector when it goes; the entry and siblings from `GET /page/files` (`api.pageFiles`); the files the page in
view uses from the frame (`pageFilesOf`: the document's URL, `script[src]` and `link[href]`, and the frame window's
`performance` resource entries, each through `fileOfUrl`); a running build from `state.runs` (`buildOfRuns`: the
project's `kind: 'build'` run without `endedAt`, its step read from `latest` "i of n · label"). `ghostOf({ projectId,
edits, sessions, pageFiles, entry, htmlFiles, pins, readouts, build, reloadedAt, root, now })` is pure and returns
`{ label, title, file, onPage, parts, pages, reload, phone, nextAt }`: the label is the newest call of the last 30 s
(`GHOST_MS`) as "<who> · editing <file's last part> · <n s ago>" for Edit, MultiEdit, Write and NotebookEdit (with "·
on this page" when the file is the entry or in pageFiles) or "<who> · <verb> <object>" for any other call ("running
npm run check", "reading app.js"), else the build's words, else empty; who is "Claude Code" for the claude-code
backend and the tooltip `brainLine(model)`. `parts` are the links (`linksOf(pins, readouts)`, files read without
`:line`) whose file was edited in the label's window after the frame last loaded, only while the label shows; `pages`
and `reload` count edits after the frame last loaded whose session still runs or ended under 30 s ago, `pages` for
the entry and sibling files ("edited by <who> · <n s ago>"), `reload` for a file the page uses. `phone` is the build's
words while one runs, else the label without "on this page". Drawing: the label with `span.ghost-dot`, the
`ghost-reload` button ("Reload the preview", calling `reload()`) only while `reload`; one holder `#atelier-page-outline-
ghost` (`GHOST_OUTLINE_ID`, `OVERLAY_ID + '-ghost'`) on the frame's `documentElement` with a box per part found by
`elementAt` or `querySelector` and with a non-empty box, at the Page outline's border with opacity 0.5 and
pointer-events none, removed when no part shows and on every frame `load`. Every draw emits `app.emit('ghost', {
projectId, model })`: the Page tab dots one row per file in `model.pages` (`span.page-ghost`: the shown page's row when
it is that file's, else the file's first row, titled "… · the one file behind n pages" when several share it; drawn again only
when the set of files changes, titles updated in place) and the Phone panel shows `model.phone` in `p.phone-ghost`,
first in `.phone-screen`, absolutely placed over the image's top edge (the live line stays below the image, Point in
the side column). The clock: once a second while a label shows; otherwise one timeout at `nextAt` (a dot or Reload due
to go). Nothing reloads the frame but the person's press.

The **side slot** (`client/components/stage-side.js`, decision rows 107 and 108): `aside.stage-side` is the last
child of `div.preview-wrap` before the ghost, hidden while empty. `createStageSide({ node, host, width })` gives
`wide()`, `measure()`, `on(fn)`, `put(n, kind)`, `release(n)`, `empty()`, `holds(n)`, `heldKind()`, `onHold(fn)`
(told when the held kind changes) and `target(label)` (the drop target while a dock tab is over the stage:
`.drop-target` and the label node over the slot; `null` takes it away); it holds one node at a time.
`wideFor(width, was)` is pure: wide from `BESIDE_MIN` (1440) px of window width, narrow at 1416 px or less
(`BESIDE_HYSTERESIS` 24), the last answer in between. A ResizeObserver on the Workbench root calls `measure()`, which
reads `window.innerWidth` and tells subscribers only of a change. While the slot holds a node the wrap has `.has-side`:
`padding-right: var(--side-w)` (`clamp(300px, 24vw, 420px)`), so the frame keeps its width setting and centres in what
is left; the slot is absolutely placed over that padding at the wrap's full height, and the error overlay and the ghost
keep to the preview's part. The side-by-side overlay (z-index 5) still covers the whole stage. `leaveProject` calls
`empty()`, unmount calls it too. The dock passes the slot to every panel as `ctx.stageSide` and, while it is wide,
mounts the Phone panel hidden (`ensureBeside`, also on every width change) unless `project.ui.phoneBeside` is `false`,
or another kind holds the slot, so the screen can sit there before the Phone tab was ever opened. The Phone panel
places its own screen (section 10); every other panel the dock moves whole (below).

**Arranging the dock** (`client/components/dock-arrange.js`, `client/components/dock.js`; decision rows 109 to 111).
Two keys in `project.ui`, both written through the dock's `saveUi` (merge, then the whole map; the route merges one level deep too):
- `dockOrder`: the project's dock kinds in the person's order, or `null`/absent for the default. `orderKinds(kinds,
  dockOrder)` is pure: kinds the project does not have are dropped, repeats too, and a kind the project has that the
  list does not name goes right after the nearest kind before it in `panelKinds` order (else first). The tabs draw in
  that order; plain Left/Right walk it.
- `stageSide`: the kind beside the preview, or `null`/absent. A kind the project does not have counts as `null`. For
  `phone` the Phone panel's screen goes there; for any other kind the panel's `div.wbp-host` container itself is moved
  into the slot (`put(container, kind)`), after `div.side-head` (the kind's name as a drag handle and **Back to the
  dock**), and `dock-body` shows `p.dock-away` ("<Tab> is beside the preview.") while that tab is active. While
  `stageSide` names another kind, the phone's screen stays in its tab (`ctx.sideKind()` in `beside.js`); its switch on
  sets `stageSide: 'phone'`, off clears a `'phone'`. A drop of the Phone tab sets `{ stageSide: 'phone', phoneBeside:
  true }`, a drag back `{ stageSide: null, phoneBeside: false }`.
`placeSide()` runs on `setProject`, on every width change and whenever a `saveUi` partial has `stageSide`: dock
containers not wanted (or the window narrow) go back to the body and are released, the panels that place their own
node (`ctx.onSide(fn)`, the phone) are told, then the wanted container moves in (mounted first if it never was).
A move is an `append` of the same container: no remount, `shown()` is called so the terminal refits.
The drag: `createTabDrag` listens on `document` from a tab's (or the slot handle's) `pointerdown`; it lifts after
`LIFT_PX` (6) px (`.lifted` on the tab, `.arranging` on the dock), shows `span.dock-drop-line` at `dropAt(rects, x)`
over the tabs, or the slot's target over the preview-wrap's box; Esc cancels; the click a browser sends after a drop is
swallowed (`takeClick`). A drop in the tabs zone reorders and, for the kind beside the preview, returns it. Keys on a
focused tab: Alt+Left/Right move one place (`movedWords` in `span.dock-live`, a polite live region), Alt+Up/Down put
it beside the preview or back. **Reset arrangement** (a quiet button at the tab row's end, only while `dockOrder`
differs from the default or `stageSide` names a kind) saves `{ dockOrder: null, stageSide: null }` and toasts once;
`phoneBeside` is left as it is. The tab of the held kind carries `span.tab-side` (", beside the preview").
`createDock` takes `loadPanel(kind)` (default: the dynamic import) so tests can hand in fake panels.

Design tokens live in `client/styles.css` (`--bg`, `--panel`, `--ink`, `--muted`,
`--accent`, `--ok`, `--warn`, `--danger`, spacing 4/8/12/16/24, radius 6/10,
font: Inter, "Segoe UI", system-ui). Motion <= 160 ms; honors reduced motion.
Keyboard: every control reachable; visible focus ring; `?` opens shortcuts.

## 5. Claude Code protocol (what a Claude Code session does with a task)

1. The studio writes `.studio/tasks/<id>/brief.md` and `task.json` (status `ready`)
   and regenerates `CLAUDE.md` + `.studio/BRIEFING.md`.
2. You (Claude Code) run in the project folder. `CLAUDE.md` tells you the open
   task ids. Run `node <studio>/bin/atelier.mjs task handover <id>` first, then
   `task start <id>`.
3. Work. Record notes/questions: `task note <id> "..."`, `task question <id> "..."`.
4. Finish: `task finish <id> --summary "..." --verification "..." [--unresolved "..."]`.
   This checkpoints a dirty tree (origin `claude-code`), links the version, sets
   status `review` ("Ready to try"). The studio ingests on its next tick.
   In a session that may not write the project's `.git` (a Codex worker's sandbox), the same command records the
   finish instead and the studio keeps the version when the worker's turn ends (section 17, Codex workers).
   The version label is the task title cut at a word boundary to at most 80 chars
   (`shortLabel(title, 80)` in `server/lib/tasks.mjs`); the summary goes into the version
   note (`Task <id>: <summary>`).
   At creation the brief's "Relevant files" lists the paths with a known extension named in
   the request (`src/tuning.js` …, deduplicated, at most 12) plus any `files` given; the
   inspiration is only what the person typed for this task (never the project's).
   The base (`context.baseVersionId`, `baseSha`) is set at creation and again at handover (the Chat and
   terminal routes, `task handover <id>`) and on reopen, from HEAD, with a `base_moved` event when the
   sha moved and a rewritten brief that keeps its answers. A started, unclosed task keeps its base while
   HEAD is its own version or has none. At handover an explore task whose HEAD has no version gets one,
   "Base for <six words of the title>", origin `studio`, no `taskId`, so it is never an option; once it
   started, only if its tree is clean on the base commit, because edits or a hand commit are not a base.
   Copy command calls no route, and the brief then asks the session for `task handover`.
   An explore task makes each option from its base: `checkpoint --task <id>
   --label "..."`, then `restore <baseVersionId>` before the next option and once more at the end, and
   it finishes on a clean tree. `restore <versionId> [--project <id|path>]` refuses an id that is not a
   version of that project and a version whose commit is gone, before writing anything; it takes a safety
   copy when the tree is dirty, and prints the version restored to and `safetyVersionId`. The session is asked to do this; nothing forces it, so `role` and git, not
   the prompt, are what the release notes draft reads.
5. Memory: `memory add --scope project|user --kind decision|lesson|... "text"`;
   `memory list`, `memory retract <id>`.

## 6. Invariants

- Preview, checkpoint, compare, restore, build operate on real files/commits.
- Status reflects evidence (events, files, git), never an AI claim alone.
- No model call for direct retrieval or UI clicks; only `/api/utility/*` calls a model.
- API key never leaves the server; never logged; never in the repo.
- Budget pause blocks `/api/utility/*` only; everything else keeps working.
- Studio source versions (git tags here) are separate from product versions.
- Creating or importing a folder inside another repository initializes a separate Git root
  for that project. An ancestor repository must never receive its checkpoints or restores.
- Previews are served from the studio origin, so every product shares one localStorage/IndexedDB: templates namespace browser storage per project (`<html data-storage-key>` set to the slug at creation, when the template title/slug are replaced by the project name/slug), and side-by-side key mirroring relies on that same origin.
- A preview that focuses itself on load does not take the keyboard from the studio: the load gives focus back unless the person pressed the preview or tried a version from its row (`client/components/preview-focus.js`, studio #32). It has three known limits. The listener inside the frame attaches on load, so a press between the new page committing and its load event is not seen and a slow page can need a second click; a product that focuses itself after its load event (for example on a timer) still takes the keyboard; and focus that reached the frame by Tab counts as not clicked, so a reload moves it out.

## 7. Console (talk to Claude Code or another model from inside the studio)

A conversational console with three backends, and a fourth, `codex`, that the Workbench's Codex tab starts
(section 21: the person's Codex CLI on their own login). Honesty rules: the UI names the backend, the
account it runs on and what it costs; nothing switches backend by itself.

- `claude-code` (default): spawns the `claude` CLI already installed and logged in on this (a session may name extra folders, `addDirs`, passed as `--add-dir` so a studio task can read a sibling product; each must be an existing folder given as an absolute path, strictly inside the projects root, or the studio or a registered project or inside them, otherwise 400 `invalid_input` naming it)
  machine (headless: `claude -p --output-format stream-json --verbose --model <id>
  --permission-mode <plan|acceptEdits|bypassPermissions> [--resume <session>]
  [--allowedTools <rules> --disallowedTools PowerShell] [--mcp-config <json> --allowedTools mcp__atelier__*
  --append-system-prompt <text>] [--add-dir <folder>]…`; the Studio tools part is section 11), prompt on
  stdin, cwd = the chosen project folder (so its `CLAUDE.md` and `.studio/BRIEFING.md` are read
  by Claude Code itself) or the studio folder. Turns count against the person's Claude Code
  plan. The child env never contains `STUDIO_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`, so a
  console turn can never be billed to the API by accident. `modelUsage` from the result line is
  stored with the turn as evidence of which model answered.
- **Sign-in** (decision row 129). The CLI signs in with the first credential it finds; on this machine
  `CLAUDE_CONFIG_DIR` is set machine-wide, so every claude (terminals, the studio's runs, other programs) shares
  one saved login in `<config>/.credentials.json`, which has a finite life and is refreshed by whichever process
  needs it first. On 2026-11-07 a companion turn found it expired and could not refresh it, and the file was left
  signed out for every claude on the machine. The studio therefore keeps an optional sign-in of its own: a
  one-year token the person makes with `claude setup-token` in their own terminal and pastes in Settings ›
  Claude Code sign-in (`POST /api/secrets/claude-token {token}`; an empty token removes it; an `sk-ant-api…`
  key is 400 `invalid_token`, since the CLI would bill the API with it). It is kept in `secrets.json` with the
  date it was saved, never returned, and put only into the environment of the studio's own claude runs as
  `CLAUDE_CODE_OAUTH_TOKEN` (`claudeEnv`), which outranks the saved login; with it goes
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Claude Code strips credentials from the commands, hooks and MCP servers
  the session starts. Shells, commands and other programs never get it. `GET /api/console/auth[?fresh=1]` answers
  `{ cli, loggedIn, authMethod, studioToken: { saved, savedAt, endsAbout }, checkedAt }` from the CLI's own
  `claude auth status --json` in the runs' environment (it names the kind of sign-in and does not test it; a turn
  does), cached a minute. A run that fails before any tool call with the CLI's sign-in words (`SIGNED_OUT_RE`) is
  kept with `signedOut: true` (older turns gain it on read, `upgradeSignedOut`); the transcript draws it as
  "Claude Code is signed out on this machine" with a link to Settings, and the Companion tab's state reads
  Signed out. The child env also drops the desktop app's host-session variables (its account and organization ids,
  OAuth scopes, messaging socket, host and child-session ids, Agent SDK markers), which a studio restarted from a
  desktop Code session inherits. Not a protection: a session that runs node can still read `secrets.json` from
  disk, as it can the API key (below).
- `allowStudioCli` (boolean, default false, claude-code only): when true the argv entries
  `--allowedTools`, `Bash(node:*)`, `Bash(npm run:*)`, `Bash(npm test:*)`, `Bash(git status:*)`,
  `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `--disallowedTools`, `PowerShell` are appended (a PowerShell(node:*) rule was still denied in a probe, see docs/evidence/probe-allowed-tools*.json) (spawned as-is, no shell
  quoting) so a session in `acceptEdits` may run `node …/bin/atelier.mjs task …` to report back on
  a studio task, run its checks and read its own diff; the studio commits for the session when it
  finishes. Anything else the permission mode would ask about is refused, because a headless session
  cannot ask.
  This list is what Claude Code runs without asking, not a sandbox. `node` itself is unrestricted, so
  the session can do anything a program you run can: run `git commit`, read any folder, read
  `~/.atelier/secrets.json`. `npm run` runs `package.json` scripts the session may edit, and the git
  rules match as typed, so `git diff --no-index` reads any file and `--output=` writes one. The real
  protections: the child's environment holds neither API key nor your Claude Code session variables
  (`strippedEnv`), every call is visible in the transcript, and the prompt asks the session to stay
  in its folders and not to commit. Asking is not enforcing.
- `api`: one bounded chat turn through `server/api-utility` (task `console-chat`, output
  `{reply}`), subject to the budget gate and ledger like every utility. Optional briefing context.
- `command`: a command line the person configures in Settings (`settings.console.command`,
  e.g. `ollama run llama3.2`), run with the message on stdin (`commandMode: "stdin"`) or in
  place of `{prompt}` (`"arg"`); stdout streams back. Local models use this computer.
  Context on stdin: `briefing` sends "Project briefing:", the project's `.studio/BRIEFING.md`
  (same source as the API backend), a `---` separator, then "Message:" and the text; `history`
  sends the last ten turns as `role: text` lines then `user: <text>`; `none` sends the text only.
  In `"arg"` mode only the text is sent (a command line has no room for a briefing).
- Every assistant turn of the `command` and `api` backends records `contextUsed`
  (`none|briefing|history`): what was actually sent, which may be `none` when a briefing was
  asked for but the project has none (a `status` event says so).

Records: `~/.atelier/console/<id>.json` = `{ id, backend, projectId|null, cwd, title, model,
permissionMode, allowStudioCli, addDirs, tools: 'studio'|null, taskId|null, claudeSessionId, status: idle|running, createdAt,
updatedAt, turns: [{ role: user|assistant, text, at, events?: [{kind: tool|tool-result|denied|status,
id?, name, summary, ok?}],
usage?, modelUsage?, costUsd?, durationMs?, isError? }] }`.

HTTP: `GET /api/console/backends` → `{ backends: [{id, available, detail}], models }` ·
`GET /api/console/sessions?projectId=` · `POST /api/console/sessions {backend, projectId, model,
permissionMode, allowStudioCli?, addDirs?, tools?: 'studio', title?, taskId?, effort?}` · `GET/DELETE /api/console/sessions/:id` · `PATCH
/api/console/sessions/:id {model?, permissionMode?, effort?}` (a Claude Code session's choices for its next turn, section 12) · `POST /api/console/sessions/:id/send
{text, context: none|briefing|history}` → 202 `{runId}` · `POST /api/console/sessions/:id/cancel`.
SSE: `console.started {sessionId, runId}`, `console.chunk {sessionId, runId, kind: text|tool|
tool-result|denied|status, text?, id?, name?, ok?, summary?}`, `console.done {sessionId, runId, turn}`, `console.error
{sessionId, runId, message}`. One run per session at a time (409 `console_busy`); a run is
killed after `settings.console.timeoutMs` (default 600000).
Readers of these records: the Claude Code view, the Companion tab (section 12) and a task row's Activity (section 4),
which reads a session whose `taskId` is the task and draws its `tool` events by their `ms` (time from the run's
start; a turn's `at` is rewritten when the run finishes, so it is the end, not the start).

Tool outcomes are visible, not only tool calls. The stream-json parser keeps a map
`tool_use_id → tool name` from assistant `tool_use` blocks; each `tool_result` block in a `user`
message becomes `{kind:'tool-result', id, name, ok: !is_error, summary}` (summary = first 160
chars of its text content, string or array of text blocks), and each entry of the result line's
`permission_denials` becomes `{kind:'denied', id: tool_use_id, name: tool_name, summary}` (summary =
`command`, else `file_path`, else the first 120 chars of the input as JSON). Both are chunks and
are stored in `turn.events`; the status line "N permission denial(s)" stays. Tool, tool-result and
denied events and chunks all carry the tool_use id (empty when the CLI gave none, absent in older
records). `client/components/transcript-match.js` pairs by id; without ids it gives each to the
first earlier call of that tool with no answer yet, and a denial counts as an answer.
A refusal is classified as it happens: an `is_error` tool_result whose text matches
`/permission|denied|not allowed|requires approval/i` becomes `{kind:'denied', id, name, summary}`
at once (name from the tool_use map, summary from that call's input as above), not a failed
`tool-result`. At the result line a `permission_denials` entry already shown that way (same
`tool_use_id`, or without one the same name and summary) is not repeated.
Backend `detail` texts when unavailable: command "No command set. Settings › Console › Command.",
api "No API key. Settings › API key." or "API utilities are paused. Budget.".

Task handoff into a Chat session: `POST /api/projects/:id/tasks/:tid/console {model?}` (task must
be ready, working, interrupted or needs-input, else 409 `task_closed`) creates a claude-code
session on the project (model from the body if valid, else `claude-opus-5-5`; `acceptEdits`;
`allowStudioCli: true`; title `Task · <shortLabel(title, 70)>`; `taskId` = tid), appends the task event
`handed_to_console` (actor `studio`, data `{sessionId}`), sends `consolePrompt(tid)` (read the
brief; report handover, start, note and finish through the studio CLI; when a decision is needed run
`task question` and stop instead of guessing or finishing with the question unanswered; keep
changes inside the project folder; stay inside it and the folders named for the task and read no
files elsewhere; no hand commits; one simple command per call, with no cd, no `;` or `&&` chains
and no shell variables, and when a step needs more a small script file under the project folder,
run with `node <file>` and deleted before finishing because the finish checkpoint commits every
file; git without `-C`, because the allowed rules match as typed) and returns `{sessionId, runId}`.
A body `addDirs` follows the rule above; a refused entry is a 400 before any event is written.

`settings.console` = `{ command, commandMode, timeoutMs, claudePath, codexPath, terminalFont }` (`codexPath`: the
codex command for the Codex tab, section 21);
`terminalFont` is a CSS font-family string ≤ 120 chars (default `''` = the client's default).

UI: view `console` (shortcut 6): session list per backend on the left, transcript with
streamed text and tool chips in the middle, composer at the bottom (Enter sends, Shift+Enter
newline, Stop cancels), a header naming project/cwd, backend, model, permission mode and, after
each turn, the model that answered, duration and tokens. Nothing in the console is a studio
record until the person makes it one (Keep version, task, memory, decision).

## 8. Terminal (a real shell inside the studio)

The Console section has two modes: **Chat** (section 7) and **Terminal**. A terminal is a
real pseudo-terminal on this machine (`node-pty`, prebuilt ConPTY on Windows) running the
person's shell (`pwsh.exe` if present, else `powershell.exe`; `$SHELL` elsewhere) in the chosen
folder (a project or the studio). Interactive `claude` runs there exactly as in Windows
Terminal, on the person's own login; the studio only relays bytes. The child env is the stripped
env from section 7 (no `STUDIO_ANTHROPIC_API_KEY`, no `ANTHROPIC_API_KEY`) plus `ATELIER_PROJECT`
and `ATELIER_STUDIO`.

Server (`server/lib/terminal.mjs`, in memory, not persisted across restarts): `open({projectId,
cols, rows, shell?})` → `{id, cwd, shell, pid}` · `write(id, data)` · `resize(id, cols, rows)`
· `close(id)` · `list()`. Scrollback: the last 256 KB per terminal, replayed when a stream
attaches. HTTP: `GET /api/terminal` (list) · `POST /api/terminal` (open) · `GET
/api/terminal/:id/stream` (SSE: `data: {"d":"<text>"}` per chunk, `event: exit` with the exit
code) · `POST /api/terminal/:id/input {data}` · `POST /api/terminal/:id/resize {cols, rows}` ·
`DELETE /api/terminal/:id`. At most 8 open terminals, exited ones included until closed (409
`terminal_limit`). The first stream event carries the scrollback with `replay: true` (the client
must not answer terminal queries inside a replay); the global SSE channel emits
`terminal.changed` when a terminal opens, exits or closes. Besides the API keys, the child env
drops the host Claude Code session variables (`CLAUDECODE`, `CLAUDE_CODE_*`, except
`CLAUDE_CONFIG_DIR`) so a terminal opened from a studio that was itself started inside Claude
Code behaves like a fresh shell. A terminal never gets the studio's Claude Code sign-in (section 7):
`claude` typed there uses the machine's own sign-in. The server binds 127.0.0.1 only; a terminal is full shell
access for anything that can reach the port, which is already true of the file API.

Client: `@xterm/xterm` and `@xterm/addon-fit` served from `node_modules` at `/vendor/xterm/`
(no bundler). Terminal mode shows the open terminals as tabs, a New terminal control (folder:
active project or studio), the xterm pane (fit to size, resize forwarded), and quick actions
that only type into the terminal: `claude` (interactive Claude Code here), `claude --continue`,
`node bin/atelier.mjs task list`. Nothing typed is interpreted by the studio.

**Two panes** (`client/components/terminal.js`). `createTerminalPane(host, app, { scope, fixedScope, projectId,
place, onScope, onTerms })` → `{ destroy(), refresh(), setScope(k) }` owns its own state (list, active terminal, xterm,
stream, timers, listeners). The Claude Code view's Terminal mode uses it through `mountTerminalMode` /
`unmountTerminalMode` (one pane, `place: 'view'`, scope from `sessionStorage['atelier.terminalScope']`); the dock's
Terminal tab (section 14) makes a second one (`place: 'dock'`, `fixedScope`, the project's id). Each pane attaches to
its own chosen terminal (the view remembers it in `atelier.terminalActive`, the dock per project in
`atelier.terminalActive.dock:<projectId>`). When both attach to the same terminal, each opens its own stream, so both
receive the output and both can type; each pane sends its size when it attaches, when its box changes and when it is
shown (`refresh()`), so the pane resized last sets the shell's size. The facts line says so in plain words: "also open
in the dock; the pane resized last sets its size" (or "in the Claude Code view"), from a module-level list of open
panes. The xterm vendor scripts load once per page for both. The Start Claude Code dialog and `composeClaude` live in
`client/components/terminal-launch.js` (re-exported by terminal.js); the dialog only hands a line to the pane to type.

## 9. Desktop app (Electron shell)

`app/` holds an Electron shell that makes the studio a desktop application without changing the
companion or the UI: `app/main.cjs` starts the companion (`node server/index.mjs` with the
system Node, so the server runs exactly as tested; if `node` is missing it shows an
instruction page), waits for `/api/health`, opens a `BrowserWindow` (1400×900, min 1024×680,
dark background, `contextIsolation`, `sandbox`, no `nodeIntegration`) at
`http://127.0.0.1:<port>`, keeps a tray icon (Open, Restart companion, Quit) and stops the
companion it started when it quits. External links open in the default browser; previews stay
in-app. `app/preload.cjs` exposes `window.atelierDesktop = { version, electron, specs() }` where
`specs()` returns what Electron knows (GPU from `app.getGPUInfo('basic')` without Windows'
"Microsoft Basic Render Driver" software adapter, Chromium/Node versions). When the app stops a
companion it started it logs "companion stopped (pid N)" (a forced stop ends with code 1, which is
not a failure) and removes the pid file it configured (`ATELIER_PID_FILE` or `.local/server.pid`,
resolved against the repo root) if that file names the stopped pid. The server exposes `GET /api/machine` (CPU model and cores, memory, arch, OS, GPU
names via `Get-CimInstance Win32_VideoController` on Windows, Node version) in both modes;
Settings shows it as "This machine". Scripts: `npm run app` (dev), `npm run app:build`
(`electron-builder`, portable Windows exe in `dist-app/`), `npm run app:shortcut` (writes `Desktop\Atelier.lnk` with
target `node_modules/electron/dist/electron.exe <repo>` and icon `app/icon.ico` through PowerShell's WScript.Shell, reads
it back and names the node the system PATH holds; `--remove` deletes it; decision row 64). Browser mode (`npm start`) is
unchanged. Dependencies (decision rows 12–14): `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`
(runtime), `electron`, `electron-builder` (dev).

## 10. Devices (phones driven from the studio)

Server half of the Phone panel (decision rows 65–67). Nothing here fabricates a device: every answer comes
from adb, the emulator, the WebView or a build that ran; a missing thing is an answer with its reason.

**Contract** (`server/lib/devices/provider.mjs`). A provider is made per request for one project:
`id` (`android` | `ios`), `label`, `status()`, `boot()`, `build({ log })`, `launch()`, `stop()`,
`screenshot()` → `{ png, width, height }`, `input({ type: 'tap'|'swipe'|'key'|'text', ... })` in device
pixels, `inspect({ x, y })`. Every method answers `{ ok: true, ... }` or `{ ok: false, code, message }`.

**Android** (`android.mjs`, with `android-config.mjs`, `inspect.mjs`, `runner.mjs`).
- Tools: adb at `<sdkRoot>/platform-tools/adb(.exe)`, the emulator at `<sdkRoot>/emulator/emulator(.exe)`.
  `sdkRoot`, `javaHome`, `nodeRoot` come from settings `devices.android`, else the project's
  `.local/android-tools.json`, else (SDK only) `ANDROID_SDK_ROOT`/`ANDROID_HOME`; each value carries its source.
  `ATELIER_ADB`/`ATELIER_EMULATOR` override a tool, as a path or a command line (`"node" "fake-adb.mjs"`).
- Project config: atelier.json `devices.android { avd, appId, activity, build, apk }`; `appId` and `webDir`
  are inferred from `capacitor.config.json` (listed in `inferred`), `activity` defaults to `.MainActivity`, `apk`
  to `android/app/build/outputs/apk/debug/app-debug.apk`, `build` to the generic steps (listed in `defaults`).
- `status()`: tools (path tried, found, source), `adb devices` with each emulator's AVD (`emu avd name`) and each
  online device's `sys.boot_completed`, the target (the emulator running the project's AVD, else the first device
  online), the app installed (`pm list packages`) and running (`pidof`), the last build (in memory since start),
  and `emulatorLog`, the path of the emulator's log (below).
- `boot()`: `emulator -avd <avd> -no-boot-anim` started as the first phone project's `Start-Android.ps1` starts it (the run that
  booted, decision row 69): detached and unref'd, `windowsHide` false (it is a window), stdout and stderr appended to
  `DATA_DIR/devices/<projectId>/emulator.log` after a line naming the time and the command (never inside the
  project), with the tool env below. Then up to 180 s for the serial and `sys.boot_completed = 1`; `waited` lists
  what was waited for and when. Every boot answer carries `log` (the path); `boot_timeout` names what never came and
  `emulator_exited` how it ended, both with `logTail`, the log's last 20 lines.
- `build()`: steps in order with every line to `log` and to the kept log (last 400 lines). Generic:
  `npx cap sync android` (Capacitor projects; node with npm's `npx-cli.js`, no shell), the Gradle wrapper by its
  absolute path with cwd `android/` (`"<project>\android\gradlew.bat" assembleDebug --console=plain` through the
  shell on Windows, since a `.bat` runs only in one; `<project>/android/gradlew assembleDebug --console=plain`
  without a shell elsewhere; a missing wrapper stops step 2 with its path), `adb -s <serial> install -r <apk>`.
  A `build` line in atelier.json runs alone through the system shell in the project folder. The failing step is
  named with its exit code. One build at a time per project (`build_running`).
- Tool env (`toolEnv`, for adb, the emulator and every build step): the console's stripped env (no API keys);
  PATH with `<sdk>/platform-tools`, `<sdk>/emulator`, the Node folder (settings' `nodeRoot`, else the folder of the
  node running the studio) and `<javaHome>/bin` first; `ANDROID_HOME` and `ANDROID_SDK_ROOT` set to the SDK folder
  and `JAVA_HOME` to the JDK when known; anything else, an existing `JAVA_HOME` included, passes through.
- `launch()`: `am start -n <appId>/<activity>`. `stop()`: `emu kill` for an emulator; a USB phone answers
  `cannot_stop`. `screenshot()`: `exec-out screencap -p`, the bytes as they are (checked to be a PNG).
- `input()`: `input tap x y`, `input swipe x y x2 y2 ms` (300 by default), `input keyevent` from back, home,
  enter, delete, up, down, left, right, `input text` with spaces as `%s` and quotes and shell metacharacters
  backslashed; newlines, non-ASCII and over 500 characters are refused (`invalid_input`).
- `inspect()`: the app's pid, then what is in front (`dumpsys window`, the `mCurrentFocus` line, else
  `mFocusedApp`; decision row 70): another package in front answers `not_in_front` with "<appId> is not on the
  screen: <package> is" and `front`, since a running app's WebView answers even when covered; when dumpsys cannot be
  read, inspect goes on. Then its `@webview_devtools_remote_<pid>` in `/proc/net/unix`, `adb forward tcp:0` (adb
  picks a free port and prints it), `GET /json`, the visible localhost page first, then CDP over Node's WebSocket:
  `Runtime.evaluate` for dpr, innerHeight, innerWidth and hash; the CSS point is `x / dpr`,
  `(y - inset) / dpr` with `inset = max(0, screenshot height - innerHeight * dpr)`; `DOM.getDocument`,
  `DOM.getNodeForLocation`, `DOM.describeNode`, `DOM.resolveNode`, `Runtime.callFunctionOn` for tag, id, classes,
  text (160 characters), a selector (`#id`, else tag + classes + `:nth-of-type`) and the url. Candidates: lines in
  the manifest entry's folder (else webDir) holding the id, a class (whole names) or the first six words of the
  text, `[{ file, line, matched }]`, most matched first, at most 8. The forward is removed afterwards.

**iOS** (`ios.mjs`): every method answers `{ ok: false, code: 'needs_mac' }`; `status()` says available false
and `projectSetUp` when the project has `ios/`. On macOS the stub says `not_built` instead of asking for a Mac.

**What applies** (`index.mjs`): Android when the project has `android/`, `capacitor.config.json` or
`devices.android`; iOS when it has `ios/` or `devices.ios`. The project bundle's manifest gains
`devices: { android?: <resolved config>, ios?: { projectSetUp } }`, inferred like the entry; the dock shows the
Phone tab when it has a key.

**Routes** (owned by `workbenches/phone/server.mjs`, `?provider=android|ios`, android by default):
`GET /api/projects/:id/phone` (status of every provider; 404 `no_device_provider` when none applies),
`POST .../phone/boot|launch|stop`, `POST .../phone/build` (starts it and answers at once), `GET .../phone/build`
(its state), `GET .../phone/build/log` (SSE: kept lines with `replay: true`, then each line, `event: end` with the
state; ends at once when none runs), `GET .../phone/screenshot` (`image/png`, `Cache-Control: private, max-age=60`, every request
with its own `?t=`, so the panel's visible image reuses the bytes its offscreen Image loaded; 503 when there is none), `POST .../phone/input`, `POST .../phone/inspect` (`{ x, y }`). A provider's `ok: false` is a 200
the panel reads, except `invalid_input` (400) and `build_running` (409). `GET /api/settings/devices[?projectId]`
says where adb and the emulator were looked for and whether they were found; `PATCH /api/settings` validates
`devices.android`. Events: `phone.changed { projectId, provider, action, ok }`.

**The screen beside the preview** (`workbenches/phone/beside.js`, decision rows 107 and 108). The panel's screen is one
node, `div.phone-screen` (the ghost words, the image, the no-screen note, the live line), with the image's pointer and
key handlers and an Esc handler of its own for Point mode. `createBeside({ ctx, screen, phone, line, box, host })`
puts it in `ctx.stageSide` when the slot is wide, `project.ui.phoneBeside !== false`, no other kind was dragged into
the slot (`ctx.sideKind()` is null or `phone`, section 4) and `ctx.project` is still the panel's project; otherwise it goes back into `div.phone` before `p.phone-beside-line` ("The screen is beside the
preview." while it is away; "<Kind> is beside the preview; the screen stays here until it comes back." while the switch
is on but another panel holds the slot; hidden otherwise) and the slot is released. The box shows the switch as kept
(`project.ui.phoneBeside`), never what the slot holds, so a dragged panel does not read as the choice being lost. The container gains `.beside`, which drops the
Phone tab's tall dock height and stacks the controls. The switch "Beside the preview" (`label.check.phone-beside`,
on by default) calls `ctx.saveUi({ phoneBeside })`, which merges into `project.ui` and sends the whole map, and places
the screen again; `update()` places it too. A move is an `append` / `insertBefore` of the same node: the image keeps
its `src`, the frame timer, `natural` and the Point state run on, and the readout stays in the tab. Visibility counts
the tab's container or, while beside, the screen itself (one IntersectionObserver on both; an entry with no target is
the container), so the stream runs beside the preview with the Phone tab closed and stops when neither is on screen.
Unmount releases the slot.

## 11. Companion tools (MCP)

One MCP server over the studio's own HTTP API, shared by every brain (decision rows on the companion, 2026-11-06):
Claude Code on the person's login first; the Claude API and Codex attach the same server later. The Companion dock tab
(section 12) is the first place the person talks to it.

**Process** (`bin/atelier-mcp.mjs [--studio <origin>] [--project <id>]`). MCP over stdio written by hand, no
dependency: JSON-RPC 2.0, one message per line on stdin and stdout, protocol `2025-06-18`. stdout carries protocol
lines only; logs go to stderr. `--studio` defaults to `http://127.0.0.1:4747`; `--project` binds the session to a
project, and every tool takes `project` (id, slug or name of a registered project) to act on another. It talks to the
studio with `fetch`, so the studio must run; when it does not answer, every tool answers `isError` with "The studio
does not answer at <origin>: start it (npm start in the studio folder) and try again."

**Plumbing** (`server/lib/mcp/stdio.mjs`, pure: `handleMessage(message, { tools, serverInfo, instructions })`).
`initialize` answers `{ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'atelier',
version: <package.json> }, instructions }`; `ping` answers `{}`; notifications (`notifications/initialized` and any
other message without an id) and responses from the client get no answer; `tools/list` answers name, description and
`inputSchema` per tool; `tools/call` checks the arguments against the schema (required, type, enum, minimum,
minLength, no unknown keys) and runs the tool. A refused argument or a tool that throws answers a result
`{ content: [{ type: 'text', text }], isError: true }`, never a crash. An unknown tool is -32602, an unknown method
-32601, a line that is not JSON -32700, a message that is not JSON-RPC 2.0 or a batch -32600. `serveStdio` runs
requests as they arrive (answers carry their ids) and ends when stdin ends.

**Tools** (`server/lib/mcp/tools.mjs`, `createTools({ studio, project, fetch })`), named `atelier_<verb>_<noun>`
(two take a longer noun: `atelier_set_worker_model`, `atelier_worker_usage`, section 17),
each with a one-paragraph description for a model new to the studio. Every answer is plain text naming the project
as `<name> (<id>)`, or an image block.
- read: `atelier_read_briefing` (GET /api/briefing), `atelier_read_memory { scope: project|user|all }` (GET
  /api/memory, one line per record: kind · status · scope: text (id)), `atelier_read_file { path, from?, to? }` (GET
  /files, numbered, at most 400 lines per call), `atelier_list_files { path? }` (one folder level), `atelier_list_versions`
  (number, label, state, short sha, when, task, origin, and whether the files on disk are at a version),
  `atelier_read_diff { version, path? }` (GET /compare of the version against its parent, one file's sections when
  `path` is given, at most 600 lines; the first version has no parent and says so),
  `atelier_read_inspiration { tag?, card? }` (GET /inspiration: the board's cards in board order, one line each; one
  card in full with its image as an image block; section 22), `atelier_read_rules { kind? }` (GET /rules: the fixed
  rules by kind, one line each with its id, the token it locks and why, then the locked tokens together; section 23),
  `atelier_read_references { tag?, search?, entry? }` (GET /references: what the project keeps to build from, one
  line each, narrowed by a tag and by words; one entry with the whole text of its snippet, prompt or note; section 25).
- look: `atelier_phone_status` (GET /phone, the Phone panel's chip labels from `workbenches/phone/map.js`),
  `atelier_phone_screenshot` (`[{ type: 'image', data: <base64 png>, mimeType: 'image/png' }, { type: 'text' }]` with
  the size in device pixels and KB), `atelier_phone_inspect { x, y }` (POST /phone/inspect, the Point mode readout's
  words: `readoutState` and `taskText`, every candidate; an `ok: false` answer is `isError`), `atelier_page_files`
  (the manifest entry's HTML: `script src`, `link href`, inline module imports, HTML comments skipped; each local
  module's static import and export-from lines one level deep; URLs, package names, paths outside the project and
  missing files are marked; at most 60 files read),
  `atelier_live_status` (GET /live of the project: declared or why not valid, allowed or not, the state with its
  reason, address and pid, the last 15 log lines; every token masked by the server; section 20).
- move around: `atelier_studio_show { view?, panel?, point?, file?, line? }` → `POST /api/studio/show`, below; `panel`
  includes `page` and `source`, and `file` with `line` opens that file at that line in the Source tab; `view` includes
  `learning` and `inspiration`.
- teach: `atelier_show_lesson { id?, title, topic?, html, open? }` and `atelier_list_lessons` (section 19).
- work: `atelier_create_task { title?, request, acceptance?, mode?, department?, model? }` (POST /tasks; created
  ready, nothing handed over; `model` is the task's own worker model), the manager's `atelier_start_task`,
  `atelier_task_report`, `atelier_review_task`, `atelier_set_worker_model` and `atelier_worker_usage` (section 17), `atelier_add_unresolved { text }` (PATCH the project with `unresolvedAdd`), `atelier_add_memory { kind, text }`
  (POST /api/memory, scope project, provenance source `companion`, so its status is `inferred`), `atelier_keep_version
  { label, note? }` (POST /versions, origin `user` as the Keep version button; a 409 `nothing_changed` answers "Nothing
  to keep … the files on disk match #n").
Nothing here pushes, deletes, restores, exports, builds, boots, installs or spends on the API.

**The guard.** `checkRel` refuses absolute paths, paths that climb out of the project, and `.git` and `.studio`
(any case) before a request is made, with a sentence naming the tool to use instead; the server's `insideProject`
refuses them again. It applies to `read_file`, `list_files`, `read_diff`'s path, `studio_show`'s file and every path
`page_files` resolves.

**studio.show.** `POST /api/studio/show { projectId?, view?, panel?, point?, file?, line? }` is checked by
`checkShow` (`server/lib/mcp/show.mjs`): views `workbench|console|tasks|memory|settings`, panels
`devices|phone|play|tuning|audio|page|source`; a panel implies view `workbench` and refuses another view; `point` implies
panel `phone` and refuses another; `file` implies panel `source` and refuses another (so `point` with `file` is refused:
two panels are two calls); `line` needs `file`; an unregistered `projectId` is 404. The route emits the SSE event
`studio.show` with the checked fields and answers them with `delivered`, the number of event streams open, so the tool
says when no window received it. Nothing is stored. The client (`client/components/studio-show.js`, queued one at a
time in `client/app.js`) selects the project, goes to the view, waits up to 5 s for the Workbench to show that project,
opens the dock tab (`devices` → web-app, `play` → game, `tuning` → action, `phone`, `audio`, `page`, `source`) through
`dock.show(kind, command)`, which hands the mounted panel its `command` (`panelCommand`): `{ point }` for the Phone panel,
which turns Point mode on at once on a booted device or on the first status that says booted; `{ open: { path: file,
line } }` for the Source panel, which opens the file scrolled to the line and marked (section 15), the same command
`app.openSource` gives. A missing panel says so in a toast. A payload with a file and no panel (a server from before
the Source tab) opens in the Source tab all the same.

**Attaching** (`server/lib/console.mjs`). A Chat session with `tools: 'studio'` (stored on the record, off by default,
claude-code only; anything else is 400) adds to the argv `--mcp-config <inline JSON>` with
`{ mcpServers: { atelier: { command: <the studio's node>, args: [<studio>/bin/atelier-mcp.mjs, '--studio', <origin>,
'--project', <projectId>] } } }` (no `--project` for a session without a project), `--allowedTools mcp__atelier__*`
(after the studio CLI rules when `allowStudioCli` is on too), and `--append-system-prompt` with two sentences: the
studio's tools are available, and every change to a project goes through a task or a kept version, not by editing its
files, unless the person asked. The origin is `http://127.0.0.1:<port>` of the running studio. The New session dialog
has the checkbox "Studio tools"; the session header shows the chip `tools`.

## 12. Companion dock tab

**The studio's reach** (decision row 127). A companion session (`context: 'companion'`) runs with the studio's own
folder as an added folder (`--add-dir <studioDir>`, beside the project it is for), the studio CLI rules
(`STUDIO_CLI_ARGS`: node, npm run and test, git status, diff, log and show without asking; PowerShell off), and a
sentence in its system prompt (`companionReach(studioDir, studioProjectId)`) saying where the studio lives, that it
is open, and how a change there is checked (`npm run check`) and kept (`node bin/atelier.mjs checkpoint --project
<studio id>`). `claudeArgs` reads these per turn, so a session made before has them on its next turn. The companion
still edits only when the person asks for a change in their message (`COMPANION_PROMPT`); the permission mode is
the person's choice (below), acceptEdits by default, so a command outside the rules is a visible denial, not a silent one.

**The person's Chrome and read-only mail** (decision row 150). The person's claude.ai connectors reach every studio claude
run through their own login; Gmail is one since 2026-11-13. Every run gets `READ_ONLY_MAIL_ARGS`: a second
`--disallowedTools` naming Gmail's 24 tools that send, reply, forward, draft, label, trash or mark mail
(`GMAIL_WRITE_TOOLS`), so searching, reading threads and messages, listing labels and drafts and downloading
attachments are what is left (a denied tool is absent from the init event's tool list, which is how it was checked).
A companion session also runs with `--chrome` (Claude in Chrome: the person's own Chrome, signed in as them, through
the extension signed in to the same Claude account) unless the record says `chrome: false`; a fourth select in the
tab's head, Chrome on / Chrome off, keeps the choice in `project.ui.companion.chrome` and sets it on the open session
through `PATCH /api/console/sessions/:id {chrome}` (companion sessions only). Its prompt gains `MAIL_PROMPT` (mail
can be read, not sent) and, with Chrome, `CHROME_PROMPT` (find and read in tabs it opens, leave the person's tabs
alone, never send, post, submit, buy, accept terms or change settings unless asked for that exact step, logins and
CAPTCHAs are the person's; with several browsers connected, select the one on this computer, `HOST_OS`, since a
headless turn cannot ask). Workers and other sessions never get Chrome. Not a protection: in Auto mode the classifier,
the extension's own checks and the prompt are what stand between the companion and a click on Send in a web page.

**The choices and the attachments** (decision row 128). The tab's head holds three selects: the model (`COMPANION_MODELS`:
Opus 5.5, Fable 5.2, Fable 5.1, Sonnet 5.5, Haiku 5.5), the effort (`COMPANION_EFFORTS`: the CLI's `--effort` low · medium ·
high · xhigh · max, or its default) and the mode (`COMPANION_MODES`: Plan, Accept edits, Auto, Runs anything, the
CLI's `--permission-mode`). A choice is kept per project as `project.ui.companion` (`companionChoices`), used by
Start, and set on the open session through `PATCH /api/console/sessions/:id` so the next turn runs with it (the CLI
keeps the conversation through `--resume`). **Attach** on the composer takes files: each is read in the browser and
saved by `POST /api/projects/:id/companion/attachments` ({ name, type, data base64 }, 16 MB each) under
`<project>/.studio/attachments/<stamp>-<name>`, listed above the composer, and named in the message as a block
(`attachmentBlock`) the session reads with its Read tool; after the send the list is empty.

The companion where the person asked for it (the Workbench layout answers of 2026-11-06; the concept in DESIGN.md
section 7): a dock tab on every project, a console session underneath, pins from the Phone panel beside it. One brain
for now, Claude Code on the person's login; the API and Codex brains, the version strip and drag-to-arrange are not
built. The Page tree and the preview's own Point are section 13.

**Dock** (`client/components/dock.js`). `panelKinds` puts `companion` first on every project. The active tab is saved in
`project.ui.dockTab` when the person picks one and opens next time (a project without one opens on the tab this window had,
else Companion). The tab row's top edge is a grip (`.dock-grip`, role separator, arrow keys too): dragging sets the body's
height, clamped by `clampDockHeight(want, stage)` (`client/components/companion-words.js`) between 180 px and the stage
(the preview's and the body's heights together) less 120 px, and saves it in `project.ui.dockHeight`; a double-click
saves `null`, which gives each tab's CSS default back (Companion `clamp(240px, 46vh, 680px)`, Phone its own, others
180 px). `ctx.saveUi` changes the local `project.ui` first, then PATCHes it; the route merges `ui` one level deep (a
key set to null is removed), so a partial map sent from elsewhere cannot wipe the rest. `ctx.setCount(n)` puts a number
on the panel's tab (Companion: its pins; Terminal: its running shells; Page: its pages). Before a panel mounts (the dock
mounts a panel on its first selection), a kind's module may export `watchCount(ctx)`: the dock imports every kind's
module at `setProject` and calls it for the kinds not mounted; it calls `ctx.setCount` as the number changes and
returns a stop function, which the dock calls when the panel mounts (its own `setCount` takes over) or on a project
switch. Companion and Terminal export one, so a dock opened on Page reads their numbers at once.

**Panel** (`workbenches/companion/panel.js`; words in `client/components/companion-words.js`, no DOM, shared with the
server). Header: the brain in words (`Claude Code · Opus 5.5 · your login`) and New session. Left, the thread: the
session's turns through `renderTurn`, the live answer through `liveTurn`/`orderedItems` (client/components/transcript.js,
the Claude Code view's renderer), then the pins, then the composer (Send, Stop, Make it a task). Right, the trajectory:
a state line from `companionState` and the run's tool rows from `toolRows(events, trajectoryLabel)`, the transcript's
own rows with the call drawn as `mm:ss · verb · file` (the time is the call's `ms`, see below; the verb from `toolVerb`,
the file the summary's last path part) and the result line that expands to the full result. States: `Idle` (no session
yet / no message yet), `Working · mm:ss · <verb> <file>` (or `thinking` before the first call; a 1 s timer while the
run lasts), `Needs you · a question is waiting` (the last answer's last paragraph ends with `?`, `asksQuestion`),
`Done · <ago>`, `Stopped`, `Failed · <error>`. Under 760 px of panel width (`isStacked`, a ResizeObserver) the
trajectory goes under the thread, folded to its state line, which becomes a button. The session is read from
`project.ui.companionSessionId` with `GET /api/console/sessions/:id` (a 404 clears the id) and follows the app's
`console` topic (console.started / chunk / done / error) for its id; a done or error reads the record again.
- Start: `POST /api/console/sessions { backend: 'claude-code', projectId, model, permissionMode: 'acceptEdits',
  tools: 'studio', context: 'companion', title: 'Companion · <project>' }`, model from the picker (`claude-opus-5-5`
  default, `claude-fable-5-1`), then `saveUi({ companionSessionId })`. Later sends resume through the record's
  `claudeSessionId` as any Chat session. New session saves `companionSessionId: null`; the old session stays listed in
  the Claude Code view.
- Pins: `GET /companion/pins` on mount, on `pins.changed` for this project and after a reconnect; a card per pin
  (`Pin n · <element> · <first file>`, n by position) is a toggle; selected pins show as one attachment above the
  composer (`<project> / Phone / <element>` or `/ n pins`), turn the placeholder from "Ask about this page…" to
  "Refine the selected part…", and are appended to the next message by `messageWithPins` (a `---` rule, then per pin
  the point, element and selector, text, first three files and note, and the sentence "the companion can call
  atelier_phone_screenshot for the picture"). The selection is let go once that message is sent.
- Make it a task sends `MAKE_TASK_MESSAGE` ("Turn this thread into a studio task with atelier_create_task: a title,
  the request with the pins' files named, the numbers of the pins it is about as pins, three acceptance lines, mode
  handle; then tell me the task id."). The brain
  writes the brief through its tool; the studio writes nothing and hands nothing over.

**Pins** (`server/lib/companion.mjs`; routes in `server/index.mjs`). `<project>/.studio/pins.json` is
`{ pins: [{ id: pin_…, source: 'phone'|'preview', element, text, selector, point: { device: {x,y}|null, css: {x,y}|null } | null,
files: ['file:line', …], page, note, pageKey?, pageName?, createdAt }] }` (pageKey and pageName on preview pins only,
section 13), at most 50 (409 `too_many_pins`), written through a per-folder
queue. `GET /api/projects/:id/companion/pins` → `{ pins }`; `POST` with the pin (source must be `phone` or `preview`, element
required, text 500, selector 300, page 500, note 500 characters, files up to 10; otherwise 400 `invalid_input`) →
the stored pin; `DELETE …/pins/:pid` → `{ removed }` or 404. Every change emits `pins.changed { projectId, added|removed }`,
and the `.studio` watcher reports a write to pins.json as `pins.changed` too. The Phone panel's readout has **Pin**,
which POSTs `pinFromReadout(answer)` (the element as `tag#id.class`, its text and selector, the point, every candidate
as `file:line`, the page address).

**The session** (`server/lib/console.mjs`). `context: 'companion'` on create (claude-code with a projectId only; any
other value or backend is 400; stored on the record, `null` by default):
- `claudeArgs` joins the tools' two sentences and `COMPANION_PROMPT` in one `--append-system-prompt`: the person's
  partner inside the studio for this project; it knows the studio through its tools; it answers about what is on the
  screen with the code in hand; before any change it asks or makes a task; it never edits files unless the person says
  so in that message; it names the files it looked at.
- The first send (no earlier user turn) asks `companionContext(rec)` (injected by `server/index.mjs`) for the context
  pack and writes `<pack>\n\n---\n\n<message>` to the CLI's stdin; the record keeps the message as written, with
  `contextPack: <lines>` on the user turn, and the answer has `contextUsed: 'the studio context'` (its meta line reads
  "with the studio context"). A pack that fails is logged and the message goes alone. Later sends carry no pack.
- The pack (`contextPack`, at most 60 lines): the project's name, id, kind and folder, purpose, direction, the web entry
  and the files it loads (`pageFileLines`: the same `pageRefs`, `resolveRef` and `importSpecs` as
  `atelier_page_files`, read from disk, at most 24 lines, then "Other pages beside it: …" when the entry's folder has
  more HTML files), "Aura of <page>: <note>" when the Page tab's page in view has a note (section 13), the open pins
  (at most 8), and the phone in one line
  (`phoneLineOf`: the Phone panel's chip words, then the iPhone's reason; bounded at 4 s by the caller, "Phone: not read"
  otherwise).
- Tool calls carry `ms`, the time since the run started, on the stored event and the chunk (the trajectory's time).
- `listSessions` entries gain `asks`: the last turn is an answer, not failed or cancelled, whose last paragraph ends
  with `?`. The app bar (`client/app.js`, `globalTaskState(tasks, running, asking)`) reads companion sessions of the
  active project with `asks` as the state `needs-you` ("<project>: needs you"; said "the companion asks you a
  question"), after a task that needs input and before a running session; pressing the chip opens the Workbench on the
  Companion tab. A running companion session counts as working like any Chat session.

## 13. Page dock tab

The left column of the concept screen (DESIGN.md section 7) as a dock tab: the preview's pages numbered, the visible
page's parts as "On this screen", a selected part outlined on the preview, Point on the preview, and an aura note per
page. The preview iframe is served by the studio (`/preview/<project>/<ref>/<path>`), so it is same-origin and the panel
reads its document directly; nothing is sent into the product and the product needs no change.

**Dock** (`client/components/dock.js`). `panelKinds` puts `page` right after `companion` on every kind but `audio`.
`ctx.setCount` shows the number of pages on the tab.

**Pure half** (`workbenches/page/pages.js`; no globals, so the server imports it). Reads the document through
`children`, `tagName`, `getAttribute`, `hidden`, `id` and `textContent` only.
- `pagesOf(doc, url, { siblings })` → `[{ n: '01', key, name, slug, hash, element, visible, file }]`. Pages are the
  elements with `data-screen` or `data-page` (the outermost ones); else body's `section`/`main` children with an id (one
  level into an id-less `main`); else the one document (`element` = body). Name: the first h1/h2 inside, else
  `aria-label`, `data-screen`/`data-page`, id, the document title or the file. Visible: the page the hash names when it
  is not hidden, else the first not hidden (`hidden`, or `display: none` when the document has a view). `siblings` (the
  entry and the other HTML files of its folder, from `GET /page/files`) are listed after, one page each, without
  elements. `key` is `<file name>#<slug>` (`index.html#case`), or the file name alone.
- `partsOf(pageElement)` → two levels of `{ name, tag, selector, element, children }`: the nearest landmarks and sections
  (`header nav main section footer aside`), headings and elements with an id, `aria-label` or `role`, looking through
  anything else; hidden elements and scripts are left out; at most 40 a level. Name: a heading's own text, else the
  heading inside, `aria-label`, id, else the tag in words (Header, Navigation, Footer…).
- `selectorOf(el)` is `#id` for a plain id, else `tag:nth-of-type(n)` steps joined by ` > ` up to an ancestor with an id
  or `body`; `elementAt(doc, selector)` reads that grammar back.
- `placeOverlay(doc, el, name, { accent })` puts one `div#atelier-page-outline` into the frame's `documentElement`
  (outside body, so the page's own layout and the panel's MutationObserver do not see it): `position: absolute` at the
  element's box plus the frame's scroll (document coordinates), a 1.5 px accent border, `pointer-events: none`, and a
  label "<name> selected" at its top left. `removeOverlay(doc)` takes it away.
- `describeElement`, `inspectBody`, `pointTaskText`, `pinFromPoint`, `footerLine`, `auraLine`, `auraLinesForPins`,
  `readable(frame)`.

**Panel** (`workbenches/page/panel.js`). Two columns (`.page-cols`), stacked under 760 px of panel width (a
ResizeObserver). Left: Pages (a row per page, name then number, `aria-current="page"` on the visible one) and the aura of
the visible page. Right: On this screen (a tree of buttons, `aria-selected` on the selected part), Point, the readout.
Under both, the footer `Preview · #<n> | files on disk · <width> px | width unknown · verified | not verified`: the
version on screen (the previewed version, else the current version when the tree is clean), the frame's measured width,
and the version's `verified` record.
- Reading: on mount, on the frame's `load`, after a hash change and after a change under body (a MutationObserver on
  `hidden`, `class`, `style`, `aria-hidden` and children), at most once per 120 ms. The lists are redrawn only when the
  pages, the parts or the selection changed, so a page that changes all the time does not redraw under the pointer.
  The visible page is saved as `project.ui.pageInView = { key, name }` when it changes.
- A page row: an element page with a hash sets the frame's `location.hash`, then reads again after 200 ms; if the page
  did not become visible the row says "Cannot be opened from here: the page did not show itself for #<slug>." A sibling
  file loads in the frame (`location.href`, same folder). A page without a hash says it cannot be opened from here.
- A part: pressing it outlines it (the overlay follows on scroll in the frame, resize, and every read); pressing it
  again, a frame load, a project switch (unmount) or the part disappearing removes the outline.
- Point: one button in the tab (not in the toolbar, decision row 83). While on, capture listeners on the frame's window
  (the top of every event's path) hold back pointer, mouse and click events (`preventDefault`, `stopPropagation`,
  `stopImmediatePropagation`); a click reads `describeElement(target)` (tag, id, classes, text's first 160
  characters, selector, the visible page's key and name, the URL), outlines it, and asks
  `POST /api/projects/:id/page/inspect`. The readout follows the Phone's: Element, Text, Page, Files (file:line buttons
  that open the file at the line in the Source tab, section 15, and one **Copy** beside them), **Pin** and **Copy for a task**. Esc (in the frame or the panel) leaves Point. Turning Point on
  dispatches `atelier:point-mode { owner }` on the studio window; the Phone panel does the same, and each turns its own
  off when the other's arrives, so the two are never both on.
- Pin POSTs `pinFromPoint`: `{ source: 'preview', element, text, selector, point: null, files, page: <url>, pageKey,
  pageName }`; the Companion tab lists it as any pin (its chip reads `<project> / Preview / <element>`).
- Aura: a textarea labelled "Aura · <page>" with Save under the pages, for the visible page; Save writes
  `project.ui.pages[<key>].aura` through `saveUi` (an empty note removes the key). A draft survives redraws while it is
  being typed and says "Not saved".
- Not readable: when the frame has no window or document, is from another origin (`contentDocument` null), shows
  `about:blank` or has no body, the tab says "The preview is not readable from here: <why>." and shows no lists.

**Routes** (`server/lib/page.mjs`, `server/index.mjs`).
- `GET /api/projects/:id/page/files` → `{ entry, siblings }`: the `.html` files in the entry's folder other than the entry,
  sorted, at most 40. `atelier_page_files` lists them under "Other pages beside the entry:", the context pack as
  "Other pages beside it: …".
- `POST /api/projects/:id/page/inspect { selector, id, classes, text, page? }` → `{ ok, element, candidates, searched }`
  through `findCandidates` (server/lib/devices/inspect.mjs, the Phone's search: id and classes as whole names, the
  text's first six words) over the entry's folder (`searchRootOf`). `page` (the project-relative file from the preview's
  URL) narrows the search to that file's folder, which must be inside the entry's folder: otherwise 400
  `path_outside_entry`. No id, class or text is 400 `invalid_input`.

**Aura in the companion.** `auraLine(project.ui)` gives "Aura of <name>: <note>" for `pageInView` when that page has a
note; the context pack adds it after the page files. `atelier_create_task` takes `pins` (numbers as the Companion tab
lists them, or pin ids); for each preview pin whose page has a note it appends that line to the request, once per page.
No note, no line.

## 14. Terminal dock tab

The project's real shells under the stage: the same terminals as section 8, seen from the Workbench. Nothing on the
server changes; the tab uses `GET/POST /api/terminal`, the stream, input, resize and `DELETE` as the Claude Code view does.

**Dock** (`client/components/dock.js`). `panelKinds` puts `terminal` on every project, after `page` (after `companion`
on audio projects, which have no Page). The dock calls a panel's optional `shown(ctx)` when its tab is shown, or the dock
is expanded with it showing; the terminal uses it to refit. The body takes `clamp(240px, 46vh, 680px)` while this tab
shows, with no padding, like the companion's; a height pulled on the grip wins.

**Panel** (`workbenches/terminal/panel.js`). One `createTerminalPane` (section 8) with `scope: 'project'`,
`fixedScope: true`, `projectId: ctx.projectId`, `place: 'dock'`:
- the tabs row lists this project's terminals only (`t.projectId === ctx.projectId`); the studio's own shells
  (no `projectId`) stay in the Claude Code view. An exited tab keeps its close button.
- **Open terminal** (no folder choice) POSTs `/api/terminal { projectId, cols, rows }`; the quick actions (Start
  Claude Code, Task list, Show task) and the facts line are the view's.
- the tab's count (`ctx.setCount`) is the number of listed terminals that have not exited; none when zero. The count
  shows once the tab has mounted (the dock mounts a panel on its first selection).
- the pane refits on its ResizeObserver (the grip changes the body's height) and on `shown()`, which also sends the size
  even when it did not change, so the pane in sight sets the shell's size.
- an exited or ended shell is said as the view says it (the Exited line with Close and Open terminal here, the restart
  sentence); a vendor load failure is one line "The terminal could not load: <message>" with Retry (the view keeps its
  error box).
- unmount (a project switch, leaving the Workbench) destroys the pane: the stream closes, the shell keeps running.

## 15. Source dock tab

The project's files, read-only, under the stage, to read beside the preview while debugging. A viewer, never an
editor: the tab has no field and never calls `PUT /files`.

**Dock.** `panelKinds` puts `source` on every project, right after `page` (after `companion` on audio projects). The
body takes `clamp(240px, 46vh, 680px)` while it shows, and does not scroll itself: the tree and the text scroll apart.

**Panel** (`workbenches/source/panel.js`; pure parts in `client/components/source-words.js`).
- the tree: `GET /files?path=` per folder, the top at mount, a folder when it is first opened (folders start closed);
  the route leaves out `.git`, `.studio` and `node_modules`; the panel leaves out tool folders (`isToolFolder`: a
  folder whose name starts with a dot, `__pycache__`, `node_modules`) behind a row "n tool folders hidden · Show" under
  the tree (the count is of the top and the open folders); Show lists them and reads "Tool folders shown · Hide"; a file
  opened inside one (an Activity row, `studio.show`) shows them so its row is there. `dist` is listed like any folder. Arrow keys walk the
  visible rows (Right opens a folder or goes to its first row, Left closes it or goes to the parent, Home, End), Enter
  opens, Tab goes to the text. One row is in the tab order (the opened file, else the first row).
- the text: `GET /files?path=<file>&max=409600`. A cut file says "Cut at 400 KB of n MB: the rest of the file is not
  shown here." and drops its partial last line; `text: false` shows "Not a text file" and no text. The text is one
  scroll box with a sticky gutter of line numbers and a `pre` in the mono face, both at 20 px a line (`LINE_PX`); the
  opened line is one band at `(line - 1) × 20 px`, scrolled a third of the way down the box (a line asked for while the
  tab is hidden is scrolled to on `shown()`). A line past the end marks nothing and says so. Above it, the path, a muted
  line (`line n · changed since #n`) and **Copy path**.
- changed files: `changedFrom(bundle)` reads `bundle.changes.files` (deleted files left out) and the version
  `sinceVersionId` names; a changed file has a dot titled "changed since #n", a folder holding one "holds files changed
  since #n". The server watches only `.studio/`, so a source edit on disk reaches the bundle late: while the tab is on
  screen it asks `GET /changes` every 5 s and on window focus, and calls `app.loadBundle({ quiet: true })` when the
  answer differs. `update()` (the dock, on every bundle) moves the dots, lists the open folders again and re-reads the
  shown file when it is changed before or after; `project.changed` naming the shown file re-reads it too. A re-read
  redraws only when the text differs and keeps the scroll.
- `command({ open: { path, line } })` opens a file: a path made relative to the project (`projectRel`; an absolute path
  under the project folder is accepted, anything outside is refused in words and not requested), its folders opened.

**The one way in.** `app.openSource({ path, line })` (`client/app.js`) goes to the Workbench if needed, waits for it to
show the active project and calls `workbench.showPanel('source', { open })`. Callers: the Phone and Page readouts' file
buttons (a click opens; one small **Copy** beside the list copies every candidate as `file:line`, one per line), an
Activity row's file name (`client/components/task-activity.js`: Read, Edit, MultiEdit, Write, NotebookEdit and the
companion's read_file, when the path is inside the task's project and that project is active), and studio.show
(section 11).

## 16. Runs

What runs in the studio now, and what ended in the last 24 hours this process remembers. A run is only what a server
hook reported; nothing polls and nothing is stored on disk.

**Registry** (`server/lib/runs.mjs`): `createRunRegistry({ emit, now, keepMs = 24 h, cap = 50 })` with `start`,
`update`, `end`, `get`, `list`; `runs` is the studio's one instance (`index.mjs` gives it the SSE emit). A run is
`{ id, kind, projectId, name, state, reason, startedAt, endedAt, latest, latestAt, waitsFor }`; kind is `session`,
`build`, `device`, `terminal`, `utility` or `live` (section 20); state is `Working` or `Queued` while it runs (nothing in the studio queues
yet) and ends once as `Done`, `Failed`, `Stopped` or `Waiting for you`, with `reason` in a few words. Every call that
changes something emits `runs.changed { projectId, run }` once; a call that changes nothing, an update after the end and
a second end emit nothing. On each end and each list, finished runs older than 24 h go, and past 50 finished per project
the oldest go; running ones always stay. `list()` says `note: "since the studio started at <iso>"` while the process is
younger than 24 h, because a restart forgets.

**Hooks** (each calls the registry where it already knew):
- `server/lib/console.mjs`: a turn starts at `console.started` (id = the run id `cr_…`, name = the task's title for a
  task-bound session (its title `Task · <title>`), else the session's title, else the model); each tool call sets
  `latest` (`toolVerb` + `toolObject`, "Read copy.mjs"); `finish` ends it by `sessionEnd(turn)`: timed out or cancelled
  → Stopped, an error → Failed with its first line, an answer whose last paragraph asks (`asksQuestion`) → Waiting for
  you with `questionWords` and `waitsFor: "you"`, else Done. A Chat turn on the API backend is the session's row: it
  calls the utility with `track: false`.
- `server/lib/devices/android.mjs`: a build is "Build and install", latest `i of n · <step label>`, Failed with the
  failed step's sentence; a boot is the AVD's name, latest "starting the emulator", then "serial up (<serial>), waiting
  for boot_completed", Done "booted <serial>" or Failed with the timeout or exit sentence. An emulator already booted is
  no run. A build has no `waitsFor`: its install step fails at once without a device rather than waiting.
- `server/lib/terminal.mjs`: a shell is named by its program (`pwsh`, `cmd`), its latest is "open <n min>" computed when
  listed; it ends Stopped with `exit code <n>` when the shell exits by itself, or `closed` when the person closes it.
- `server/lib/live.mjs`: a project's live server is its label, latest "starting" then "serving <host>"; it ends
  Stopped with why it stopped ("you switched Live off", "the project was closed") or Failed with the reason (section 20).
- `server/api-utility/index.mjs`: a utility run is the utility's name; latest "calling <model>, attempt n", "retrying in
  n s after …", "asking for a corrected answer"; Done "answered after n attempts", Failed with the error, Stopped when
  cancelled.

**Client.** `app.state.runs` is `GET /api/runs?projectId=all`, read at boot, on reconnect and 200 ms after each
`runs.changed` (`emit('runs')`). The pure parts are `client/components/run-words.js`:
- `workingNowModel(runs, { now, open, dismissedAt, axisMs })` for the open project: null (no row) when nothing runs
  and the rows are not open on something that ended in the hour; else `{ count, running, rows, ticks }`. Collapsed
  rows are the running ones; open adds the runs that ended within the hour and after the last close (`dismissedAt`).
  A bar's `left` and `width` are fractions of the hour; a run that started earlier starts at the left edge (`clipped`).
  The ticks (60, 45, 30, 15 min ago, now) are the strip's only clock. `working-now.js` draws it: a toggle "Working now
  · n" with the running names and dots ("Working now · none" once only ended runs are listed, and "· n ended" for the
  ended rows while open; `ended` in the model), the rows (name, state words, bar with the live dot while running, latest with
  how long ago), repainted every 30 s while on screen. The open state belongs to the Workbench and closes on a project
  switch.
- `railDot(runs, projectId)`: the rail's `span.rail-dot` before the name while the project has a running run, titled
  "Working now: <names>"; the same colour as the task bars' live dot and the only colour on the rail.
- `endedRun(event)`: the run a `runs.changed` reports as ended, or null. `app.state.endedRun` holds the last one; the
  chip shows it (after offline, saving and retrieving, before every task state) as `chipWords('run-ended', …, run)`:
  "<project>: <name> <state>", the sentence adding the reason. A click clears it and opens the run's project in the
  Workbench at the Phone tab for a build or boot, the Task tab for the rest (`runChipTab`); another run's end replaces it.

## 17. The manager and its workers

The Companion session is the manager: it talks with the person, writes tasks and hands them to workers, then judges
what comes back (server/lib/companion.mjs COMPANION_PROMPT). A companion turn is one `claude -p` process that ends
with its answer, so it cannot keep anything running in the background; the studio runs the workers instead
(server/lib/workers.mjs).

- `atelier_start_task` (POST /api/projects/:id/workers { taskId, workerModel? }) hands a ready task to a worker: a
  Claude Code session with `worker: true`, effort high, permission mode Auto and the studio CLI, whose turn may run 90
  minutes (WORKER_TIMEOUT_MS). One worker writes in a project at a time; the next waits in the project's queue as a
  Queued run (removed from the run list when it starts). When the worker model in effect is a Codex one, the worker
  is a session of the person's Codex CLI instead (**Codex workers**, below); Claude Code stays the default.
- The worker model has three levels (server/lib/models.mjs `resolveWorkerModel`): the task's own (task.json
  `workerModel`), else the project's (project.json `workerModel`), else the studio default, which is the registry's
  `settings.workerModel` when one is stored and the built-in `WORKER_MODEL` (Fable 5.2) when not
  (server/lib/worker-model.mjs). All three are read at each launch, the studio default from the registry file, so a
  change reaches the next worker started (a queued task, a revise round) with no restart, and a running worker keeps
  the model its session was created with. The `handed_to_console` event records `model`, `modelSource`
  (`task|project|studio`) and effort; the worker state's `active` carries `model`, and the answers of POST …/workers
  name it (`model`, `modelSource`; a task that already runs answers `already: true` with its worker's model and
  `next`). Every level takes one of `CONSOLE_MODELS`, a Codex worker model (`codex:<model>` or
  `codex:<model>@<effort>`, below), or `null` / `"default"` to clear it; anything else is the same 400
  `invalid_input` (`workerModel must be one of …, or default (got …); or codex:<model> or codex:<model>@<effort> for a
  worker on the Codex CLI`, `checkWorkerModel`) and writes nothing. A value typed into a record by hand that the
  studio does not take counts as none.
  - Routes: `GET /api/settings/worker-model` → `{ models, studio: { stored, fallback, model } }`; `PUT` the same with
    `{ workerModel }` (required; `PATCH /api/settings { workerModel }` goes through the same check and write);
    `GET /api/projects/:id/worker-model[?task=<tid>]` → `{ models, studio, project: { id, name, model }, task: { id,
    title, status, model } | null, effective: { model, source, words } }`; `PUT /api/projects/:id/tasks/:tid/worker-model
    { workerModel }`; the project's own through `PATCH /api/projects/:id { workerModel }`. A changed studio default
    writes every project's briefing again and emits `status { settings: true }`, so open windows read it.
  - `atelier_set_worker_model { scope: task|project|studio, model, task?, project? }` sets or clears one level from
    the manager's session and answers what each level holds and the model the next worker starts on, with its source;
    scope studio needs no project. `atelier_create_task` and `atelier_start_task` take an optional `model` for the
    task's own (at start it is stored first, then the task starts). `atelier_task_report` names, per task, the model
    its next worker would start on with its source and the model each worker ran on (from the `handed_to_console`
    events), and in the overview the project's model in effect, its source and the studio default.
  - The Focus panel's Identity line reads the model in effect (`<name> (studio default)` from the stored default);
    its form has the project's select, whose first choice names the stored default, and a Studio default select
    (`Built in (<name>)` clears it), saved to the settings before the project. Both selects list the Claude Code
    models, then the Codex models of the status route the Codex tab reads (`GET /api/console/codex`), as
    `Codex · <name>`; a Codex choice shows a second select with the efforts that model takes, after "Effort Codex is
    configured with", and one note saying what a Codex worker is, or why Codex is not ready. The pair is stored as
    one value (client/components/worker-model-words.js `workerPick`, `workerValue`); until the status answers, and
    with no CLI, only a Codex model already stored is offered, and the line reads `Codex · <model> · <effort> effort`.
    A task row's Activity and the inspector name a Codex session as `Codex · <model> · <effort> effort · sandbox
    <sandbox>` (`sessionBrainLine`), its handover reads "handed to Codex (<model>, <effort> effort)", and the Versions
    drawer names the origin Codex.
  - Nothing switches a model by itself: it changes only when the person or the manager sets it.
- **Codex workers** (decision row 182). A worker model is one string at every level, and a Codex one reads
  `codex:<model>` or `codex:<model>@<effort>` (models.mjs `parseWorkerModel`, `codexWorkerValue`, `workerWords`; the
  model as Codex names it, no `@` in it; the effort two to twelve lower-case letters). With no effort named the
  session takes the one `~/.codex/config.toml` names, when the model takes it. `checkWorkerModel` checks the form;
  whether Codex offers that model and effort on this machine is `checkCodexWorker` (worker-model.mjs: the Codex tab's
  `checkCodexChoice` over `models_cache.json`, else the built-in list), asked by every route that stores a worker
  model, by `POST …/workers` and by the CLI's `project set worker-model`, so an unknown model or an effort the model
  does not take is a 400 naming what Codex offers, and nothing is stored. `GET /api/settings/worker-model` and
  `GET /api/projects/:id/worker-model` also answer `codex: { models: [{ id, name, efforts }], source, defaults }`,
  and `effective` gains `backend`, `label` (the words) and, for Codex, `codexModel` and `effort`.
  - **The session.** `launch` asks `consoleSvc.codexReady()` first (no CLI: 503 `console_no_codex`; signed out: 503
    `console_codex_signed_out`; nothing is handed over), then creates `{ backend: 'codex', worker: true, model,
    effort, sandbox: 'workspace-write', taskId }` with no studio tools. A worker's sandbox is `workspace-write` and
    nothing else (`createSession` refuses another for a worker); its argv is section 21's, so `exec --json
    --skip-git-repo-check -m <model> -c model_reasoning_effort="<effort>" -c sandbox_mode="workspace-write" -` and
    never a `--dangerously-…` flag, `danger-full-access`, `--approve-for-me`, an approval policy, `--add-dir`, a
    writable root or network access. Its env is every Codex run's: no `OPENAI_API_KEY`, `CODEX_API_KEY` or
    `CODEX_ACCESS_TOKEN`, so it can only use the login saved in the Codex CLI, plus `ATELIER_ACTOR=codex`. Its turn
    has the worker's 90 minutes (`codex.run`'s `timeoutMs`); Codex is given no limit of its own, and past the
    studio's the run is stopped and the turn records `timedOut`.
  - **Its one message** is the task prompt every worker gets (`consolePrompt`, the department paragraph, the
    manager's note), after `CODEX_WORKER_ROLE` and `CODEX_WORKER_SANDBOX_SENTENCE` (codex.mjs) in place of the tab's
    role and with no context pack: it is alone, nobody can answer or approve during the turn, a refusal is a block to
    report with `task question`, it cannot write `.git`, and `task finish` records its finish. The record keeps the
    prompt alone.
  - **The finish.** Codex's workspace-write sandbox keeps the project's `.git` read-only, so a worker cannot commit
    (seen on 2026-11-14: `git add failed: fatal: Unable to create '…/.git/index.lock': Permission denied`). The
    CLI's `task finish` therefore asks first (`git.canWrite`: one empty file created and removed in the git folder;
    only EPERM, EACCES or EROFS answer no) and, where it may not write, records the finish instead
    (`tasks.finishOrRequest` → `requestFinish`): `.studio/tasks/<id>/finish-request.json { summary, verification,
    unresolved, decisions, actor, requestedAt }` and a `finish_requested` event, the task still `working`, because no
    version exists yet. When the worker's turn ends, `onTurnEnd` runs `tasks.completeFinishRequest` outside the
    sandbox, before the folder is freed for the next worker: the usual `finishTask` (checkpoint, result, `finished`
    event, status `review`) with the version's `origin` `codex`, and the record is removed. A failure there is the
    report ("did not finish: it recorded its finish, but the studio could not keep the version: …") and the record
    stays. A launch drops a record an earlier round left; a restart that cut a worker off after its record keeps the
    version in `reconcile`. Where `.git` is writable `task finish` is the finish itself, as before. The CLI's
    `checkpoint` and `restore` cannot run in the sandbox, so an explore task is refused a Codex worker (409
    `codex_no_explore`, at `start`, before a handover or a queue entry).
  - **What is recorded and said.** The `handed_to_console` event holds `backend`, `model`, `effort`, `sandbox`
    (Codex) and `modelSource`, from the session's own record; the worker state's `active` and the answers of
    `POST …/workers` carry `backend`, `model` and `effort` (`effort: null` only while a queued Codex task names
    none). The CLI records its caller from `ATELIER_ACTOR` (`tasks.actorOf`), so a Codex worker's `started`, `note`,
    `question` and `finished` events have actor `codex`. `atelier_start_task` answers "on Codex <model> at <effort>
    effort (<source>), the Codex CLI in its workspace-write sandbox"; `atelier_task_report` reads "Ran on: Codex
    <model> at <effort> effort, sandbox workspace-write" or "Claude Code <model> at <effort> effort" per handover
    (`ranOn`); `atelier_set_worker_model` words each level with `workerWords` and, after a Codex model is set, says
    once what a Codex worker is (`CODEX_WORKER_NOTE`) and when Codex is not ready (`GET /api/console/codex`'s
    `problem`). The tools' `model` input is a described string (the enum is gone: Codex's models are read from the
    machine), and `tools/list` names the models and efforts Codex offers now (`listSchema`).
  - **When it does not finish.** `codex exec` never asks: a command the sandbox refuses fails and Codex is told, so
    there is no approval to wait for. A turn that ends with no finish and no question reports "did not finish: its
    turn ended without finishing (status working); its last words: …", followed by the last failed or refused
    command of the turn with what it printed (`lastFailure`); an error, a refused model, a lost login and a timeout
    report with their text as any worker's do (`endWords`).
  - **What the sandbox allowed on this machine** (three real turns on 2026-11-14, codex-cli 0.160.0, `[windows]
    sandbox = "elevated"`, gpt-6-astra at low effort; docs/evidence/codex-worker-2026-11-14.json). Commands ran as the
    Windows user `CodexSandboxOffline`. Allowed: editing files in the project folder, the studio CLI's handover,
    start and note (they write `.studio/` and only read the studio's data folder), reading files outside the folder,
    writing the temp folder, and loopback (`curl http://127.0.0.1:4747/api/health` answered). Refused: writing
    `.git` (above), writing outside the folder ("Access to the path … is denied"), and the internet (`curl
    https://example.com` → `000`). A Unity project's batch-mode compile could not run: `mkdir: cannot create
    directory '/c/Users/<the person>': Permission denied`, WMI "Access denied", and Unity's "No valid Unity Editor
    license found" (exit 198), because the licence belongs to the person's own Windows account. The studio widens
    nothing: extra writable folders, network access or another Windows sandbox mode are the person's to set in their
    Codex configuration, and the studio passes none of them.
- Usage to choose by (server/lib/usage.mjs `tallyUsage`, `GET /api/workers/usage[?projectId=]`, the tool
  `atelier_worker_usage { project? }`): counted from the console's own session records (`sessionRecords()`), for the
  last 24 hours and the last 7 days, one row per model and kind (worker, companion, other Claude Code session):
  sessions, turns, and the tokens (`usage`: in, out, cache read, cache write) and cost (`total_cost_usd`) Claude
  Code's result event reported for those turns, `null` and "not recorded" where no turn kept them, and "recorded for
  n of m turns" where only some did; then `modelUsage` summed by the model that answered, sub-agents included. A turn
  counts in a window when it ended in it, under the model Claude Code reported for the turn (a sub-agent's message
  does not change a turn's model), else the session's. API and command sessions, a turn still running, deleted
  sessions and Claude Code run in a terminal or outside the studio are not counted. Nothing is estimated, and the
  studio does not know the plan's limits or what is left of them; the tool's answer says so. Codex sessions are
  counted apart and are in none of those figures: each window has `codex: { sessions, turns, apiKeyTurns, rows }`
  with one row per kind (`worker`, or `other` for the Codex tab), model and effort, holding sessions, turns and the
  tokens Codex's `turn.completed` gave (`input`, `output`, `cachedInput`, `reasoningOutput`), and the tally has
  `codexSessionsRead`. A Codex row has no cost: Codex reports none, and the text says "cost: none (Codex reports no
  cost)", how many turns ran on an API key saved in Codex, and that the studio knows neither plan's limits.
- Each worker knows its manager. A Studio tools session's MCP server is started with its console session id
  (studioMcpConfig: `env.ATELIER_SESSION_ID`; `--session` by hand), and `atelier_start_task` and
  `atelier_review_task` send it as `managerSessionId` (POST …/workers and …/tasks/:tid/review; a malformed id is a
  400). It is stored in the `handed_to_console` and `queued` events' data and in the worker state, so a manager in
  another project that starts a task in the studio hears back in its own session.
- When a worker's turn ends (the console's onTurnEnd hook), the studio reads the task as the worker left it (Ready to
  try, a question, or not finished) and sends a report, a message that begins with `[Studio report: not from the
  person]` (the transcript shows it as the studio's), to the manager that started the worker; to the task project's
  project.ui.companionSessionId only when none is recorded or its session record is gone. A turn that ended by error
  or timeout says so with the error text (`endWords`); a task record that cannot be read still reports, with the
  turn's error. While the recipient is answering (409), the report is held and the end of that session's own turn
  delivers it, several as one message. Then the next queued task starts.
- A worker that needs a decision or is stuck (a command it needs is denied, a check fails that it cannot fix, access
  it lacks) runs `task question` saying what blocks it and stops (tasks.mjs `consolePrompt`, `STUCK_WORDS`); the
  report then carries the question.
- `atelier_task_report` reads one task (request, acceptance, activity, result) or the overview (open tasks, the worker
  on one, the queue, held reports). `atelier_review_task` (POST …/tasks/:tid/review) accepts a finished task (the
  ingest: done, its decisions and open items recorded) or sends it back with a note, which the next worker receives
  (as the task's answer when it asked a question).
- A new manager picks up from disk: the tasks, their events and results, and the briefing.
- Restarts. The queue (with each entry's manager), the held reports and the managers' notes for the next round are
  kept in `<data>/workers.json`, written atomically one write at a time (EPERM and EBUSY renames are retried). Once
  the server listens, `reconcile()` reads it and, for every registered project: drops queue entries whose task closed
  or is gone (and projects that are gone); finds each task still `working` (or `ready`: cut off before its `task start`) whose last `handed_to_console` is a
  worker's, whose session runs no turn and whose session record ends with the message it was sent (cut off, not
  ended: a worker that ended without finishing reported then); appends `worker_interrupted` (once per session) and
  reports to its manager: what it was doing (since when, its last note), that its work is on disk uncommitted, and
  that `atelier_review_task` revise continues it. A task in `review` or `needs-input` whose worker was cut off after its
  finish or question gets the usual report instead, with a line saying a restart cut it off. The queue starts again where no worker runs, except over a cut-off
  worker's uncommitted files (decision row 136): it then waits until the continued task's worker ends, or the manager
  starts the next one directly. Last, the held reports are delivered, one message per recipient.
- `GET /api/workers` answers every project's worker mid-task (with its run name), the queued count and the held
  count; the restart confirmation (client/components/restart.js `restartWords`) says how many workers are mid-task,
  that their managers are told and can continue them, the other runs it stops, and how many queued tasks start again.

## 18. Skills tab

Claude Code skills are folders with a SKILL.md (frontmatter with `name` and `description`, then instructions). The
studio's companion, workers and Chat sessions are Claude Code runs in the project folder, so they use a skill on
their own when its description matches the work. The Skills tab (beside Task inspector, Processes and Focus in the
right panel: client/components/skills-panel.js) shows which ones exist and adds one.

- Places (server/lib/skills.mjs `listSkills`): the project's `.claude/skills/*/SKILL.md` (through `insideProject`),
  the person's `<claude config>/skills` (CLAUDE_CONFIG_DIR when set, else `~/.claude`, read per call), and each
  installed plugin's `skills/` folder. Plugins come from `plugins/installed_plugins.json` (v1 `{ installPath }` or v2
  `[{ installPath }]` per `name@marketplace`); without that file, folders under `plugins/` holding
  `.claude-plugin/plugin.json` (five levels at most). Only the first 64 KB of each SKILL.md is read for the list.
- `GET /api/skills?projectId=` answers `{ skills: [{ name, folder, description, category, categoryFrom, source:
  { kind: project|user|plugin, plugin }, path, problem }], places, configDir }`. `GET /api/skills/file?projectId=&path=`
  reads the SKILL.md (first 400 KB) and the folder's names only when `path` is one of the listed skills' folders.
- Category (client/components/skill-words.js, pure, shared with the server): the skill's own `category` field, then
  its `tags`, then a keyword score (name x3, description x1, whole words) over Design, UX, Backend, Frontend/Code,
  Testing & review, Docs & writing; Other when nothing scores. Ties go to the earlier category.
- `POST /api/skills/install { projectId, target: project|user, zip | files: [{ path, data }], replace, dryRun }`
  (body limit 32 MB; 20 MB and 1000 files unpacked). The shallowest SKILL.md marks the skill's folder; files beside
  it are left out, `__MACOSX`, `.DS_Store` and `Thumbs.db` dropped. Refused: no SKILL.md, two at the same depth, no
  frontmatter, name or description, a name that is not a plain folder name, any path that is absolute or climbs out.
  `dryRun` answers both destinations and whether each exists; a real install answers 409 `skill_exists` unless
  `replace` is true, writes into a hidden sibling folder and renames it into place. It emits `skills.changed`.
- The client's Add skill dialog (client/components/skill-add.js) reads a picked folder (`webkitdirectory`, `.git` and
  `node_modules` left out) or a .zip in the browser, sends it as base64 with `dryRun`, shows the two destinations with
  the project's chosen by default, asks with a box before replacing, then installs. A skill reaches sessions started
  after it; an open session sees it from its next one.
- Checked by tests/skills.test.mjs and, offscreen, scripts/ui-check/verify-skills.cjs (writes into the named project:
  run it on a throwaway one, in a folder outside any other git repo: a project created inside one commits there).

### 18.1 Skills by department

Skills are organized by department, not by one inferred category: departments use different sets of skills, and one
skill can sit in several (many-to-many).

- Store (server/lib/departments.mjs): the registry's `settings.skillDepartments`, studio-wide, an ordered list of
  `{ id, name, skills: [skill names] }`. Nothing stored means the starting six with no skills: Design, UX, Frontend,
  Backend, QA and review, Docs and writing (ids design, ux, frontend, backend, qa, docs). Changes go one at a time
  through a queue, so two quick ticks cannot overwrite each other.
- Rules (client/components/skill-departments.js, pure, shared): `applyDepartmentOp` for `add { name }`,
  `rename { id, name }`, `remove { id }`, `place { id, skill | skills, member }`; names unique in any case, at most 40 characters;
  refusals carry `invalid_input` (400), `not_found` (404) or `name_taken` (409). A rename keeps the id and the skills.
  `suggestDepartment`: only for a skill no department holds, from the skill's keyword category (section 18): a
  department named like the category, else the starting department for it while it exists; Other suggests nothing. A
  suggestion is shown, never stored, until the person confirms it.
- Routes: `GET /api/skills` also answers `departments`; `POST /api/skills/departments { action, … }` answers
  `{ departments }` and emits `skills.changed`.
- The tab: each department is a folder (a button head with a chevron, a folder mark and its count; a click, Enter or
  Space opens and closes it; the open ones are kept per browser session, and with a filter every folder with a match
  opens). A skill shows in every department that holds it; a card in two or more says Shared · also in …; its
  Departments disclosure holds a box per department. Unplaced (open on a first visit) holds what no department holds,
  sorted under Suggested for <department> · n with Place in / Place all n in <department>, then No suggestion.
  Departments in the head opens the rename, add and remove dialog (client/components/skill-dept-edit.js). A redraw puts
  the focus back on the same control of the same card in the same folder, or on its folder's head when that is closed;
  a confirmed suggestion sends it to the next Unplaced card, and a status line says where the skill went.
- Folders: a card's folder line, the SKILL.md dialog's Lives in and each place under Where the studio looked are buttons
  that open that folder in the system's file manager (POST /api/skills/reveal { projectId, path }: Explorer, open or
  xdg-open). Only a listed skill's folder or a listed place is opened, and only when it exists (404 otherwise); places
  carry exists, and one that is not there yet reads as text.
- Tasks: an optional `department` (an id or a name) on `POST /api/projects/:id/tasks`, the task form (More) and
  `atelier_create_task`; it is stored as `task.department = { id, name }`, 400 when unknown. The brief names it and has
  a Department section, written at create and at every handover. The worker's first message (server/lib/workers.mjs)
  and a task's Chat session add `tasks.departmentParagraph`: the department, its skills found for this project with
  their descriptions, the instruction to use them, and any placed skill these sessions cannot see. The department is
  looked up by id, so a rename reaches the next worker; a removed one is said to be removed. Claude Code loads every
  installed skill, so this guides the worker; it hides nothing, and the tab says so.
- Older server: the server loads routes only when it starts. A `404 No route …` from the skills routes, or an answer
  without `departments`, shows "Restart the studio to load skills: Ctrl+Alt+R." with a Restart button (app.restart).
- Checked by tests/skill-departments.test.mjs and, offscreen against a second server with throwaway data only,
  scripts/ui-check/verify-skill-departments.cjs (it changes the studio-wide departments and refuses port 4747; it
  catches the reveal request in the page, so no file manager window opens). The reveal guard is in tests/skills.test.mjs.

### 18.2 Departments for managers

The manager (section 17) gives tasks their department, so the loop closes from the Companion too.

- `atelier_list_skills` (server/lib/mcp/tools.mjs `skillsText`, over `GET /api/skills?projectId=`): one block per
  department in the list's order, `Name (id): n skills`, then a line per skill: name, where it lives (Project, Your
  skills, Plugin <name>: skill-words.js `sourceWords`), `Shared · also in …` when another department holds it, and the
  description's first sentence (`oneLine`); a department with none says so, and names it holds that no session here can
  see are listed. Then `Placed in no department` (with the keyword suggestion, as words) and `Where they live` (the places
  that exist). `department` (name or id, any case) lists that one alone; an unknown one is an error naming the
  departments. A studio that answers without `departments` is asked to restart.
- `atelier_create_task`'s `department` input is a described string, not an enum, so an id or any case still matches
  (resolveTaskDepartment). A tool may carry `listSchema()`; `tools/list` (server/lib/mcp/stdio.mjs) calls it every
  time, so the input names the departments the running studio has now (`GET /api/skills`, 3 s); on any failure the
  fixed schema is listed and the reason goes to the log. An MCP server started before a change still lists from the
  code it loaded, so a manager session started earlier sees new inputs only in a new session.
- `atelier_task_report`'s overview line is `id · status[ · worker or queue] · <Name> department | no department · title`.
- COMPANION_PROMPT asks the manager, before it starts a worker, to give every task a department, read
  `atelier_list_skills` when unsure, and name the skills that matter in the request.
- Shown: a task row's meta line starts with `<Name> department` (task-list.js `departmentWords`, also the detail's mode
  line); the bundle's task summaries (`GET /api/projects/:id` tasks, which the Tasks view's rows read) carry
  `department`. A task-bound session (worker or Chat) stores the department's name on its console record (`department`, only
  with a `taskId`), and its run, and a queued worker's placeholder run, carry it as `run.department`; the Processes
  node's detail line (process-words.js `nodeDetail`) reads `Claude Code · <Name> department`, and its title and label
  name it. A rename reaches the next session, not a run already listed.
- Checked by tests/mcp.test.mjs (a temp CLAUDE_CONFIG_DIR with three skills), tests/console.test.mjs (the sentence),
  tests/runs.test.mjs, tests/process-words.test.mjs and tests/task-activity.test.mjs (the row).

## 19. Learning view

The Companion teaches the person visually what the project is about to build (t_3b4zpsazku). A lesson is a studio
record like memory, not product source, so the Companion writes it in its own turn; no worker is involved.

**Records.** `<project>/.studio/lessons/<id>.json` = `{ id, title, createdAt, updatedAt, topic, html }`
(server/lib/lessons.mjs). Ids are `les_` + 4–40 of `[a-z0-9]` (`newId('les')` makes them); anything else is a 400 on
save and a 404 on read or delete, so no path is ever built from a request's text. `title` is one line of at most 200
characters (spaces folded), `topic` the same and optional, `html` at most 400 KB of UTF-8 (`LESSON_MAX_BYTES`; 413
over it). A save without `id` creates; with the id of a lesson that exists it replaces, keeping `createdAt`; an id
that does not exist is a 404. At most 200 lessons per project (409). Writes are queued per project folder and atomic.
The list leaves out files whose name is not a lesson id or that do not read as one, and sorts by `updatedAt`, newest
first (a replaced lesson comes to the top).

**Routes** (server/index.mjs). `GET /api/projects/:id/lessons` → `{ lessons: [{ id, title, topic, createdAt, updatedAt,
bytes }] }`; `GET …/lessons/:lid` → the lesson with its html; `POST …/lessons` `{ id?, title, topic?, html }` → the
summary and `replaced` (body limit 2 MB, for JSON escaping); `DELETE …/lessons/:lid` → `{ removed }`. Save and delete
emit `lessons.changed { projectId, lessonId, action: created | replaced | deleted }`; the `.studio` watcher reports a
write under `lessons/` as `lessons.changed { lessonId, file }` too (server/lib/watch-events.mjs), so a hand edit
reaches an open view. The client re-emits it as the app topic `lessons`.

**studio.show.** `checkShow` (server/lib/mcp/show.mjs) takes `lesson` (a lesson id): it implies `view: 'learning'` and
refuses a panel, a file, Point mode or another view. `SHOW_VIEWS` has `learning`; the client's `VIEW_ROUTES` maps it.
`handleStudioShow` selects the project first, then calls `app.showLesson(id)`, which stores `state.lessonWanted`
and routes to `#/learning` (or picks it at once when the view is on screen); the view fetches the lesson by id, so a
show that arrives before the list has it still opens it.

**MCP tools** (server/lib/mcp/tools.mjs). `atelier_show_lesson { project?, id?, title, topic?, html, open? }` checks the
id, the title, the html and its size before any request, POSTs the lesson, and with `open: true` posts
`/api/studio/show { projectId, view: 'learning', lesson }`; the answer names the id to replace it later.
`atelier_list_lessons { project? }` lists id, title, topic, size and when written. Both descriptions say a lesson is a
studio record like memory written in the companion's own turn; show_lesson's names the built-in classes.
COMPANION_PROMPT (server/lib/companion.mjs) tells the manager to answer "teach me" with a lesson opened beside the chat,
concrete to the project's real code and plans (diagrams of who talks to whom, paged steps, plain words), to look for
the Design and Docs departments' diagram skills through `atelier_list_skills`, and to replace a lesson on the same
subject rather than add one.

**The view** (client/views/learning.js, styles in client/learning.css; DESIGN.md section 9). The tab sits right after
the Workbench (`VIEWS` order in app.js = the tabs in index.html = keys 1–8 since Inspiration; the key handler takes 1 up to the number
of views). Two columns in #main: the shelf, and `div.learn-main` holding the display over the dock; the right panel
(#collab) is the app grid's third column, as on the Workbench (below). The last open lesson per project is kept in
sessionStorage (`atelier.lessonOpen`); else the newest opens. `lessons.changed` for the project lists again (150 ms
debounce) and reloads the open lesson when it was the one written, keeping its step; a deleted open lesson gives way
to the newest. A theme switch redraws the lesson in the new tokens.

**The Companion dock** (t_391f0z2rhl, decision row 139). The view runs `createDock` (client/components/dock.js), the
Workbench's own dock, with `LEARNING_DOCK`: `kinds: () => ['companion']`, `heightKey: 'learningDockHeight'` (the grip
saves `project.ui.learningDockHeight`, and `setProject` reads it; the Workbench's `dockHeight` is left alone),
`saveTab: false` (a click on the tab never writes `project.ui.dockTab`, the Workbench's last tab), `arrange: false`
(no drag, no Alt+arrows, no Reset arrangement: `dockOrder` and `stageSide` are the Workbench's), the collapsed state
under sessionStorage `atelier.dock.learning`, and `stageHeight` = the display's height plus the dock body's, so
`clampDockHeight` leaves the lesson 120 px. `bus` and `frame` are null (the dock's `post` skips a missing frame). The
dock loads `/workbenches/companion/panel.js`, so it is the same module and state as the Workbench's, and is set once
the bundle names the project (before that, a stored session id is not known and the panel would offer Start); with no
project `dock.clearProject()` unmounts it and hides the dock. The route unmounts the Workbench before it mounts
Learning, so only one mount exists at a time. On unmount the panel keeps, per project, the draft in its box, the
selected pins, the attachments, the open trajectory and a running answer's live rows, and a listener of its own adds
the run's chunks to them until the next mount takes them (decision row 138). The session lives on the server, so
nothing restarts. `app.learning.showCompanion()` opens the dock on the tab (expanding it) and answers the panel module;
Ask about this, the status chip's question (app.js `showCompanion`) and the inspector's Ask use it while Learning is
on screen.

**The right panel on Learning.** app.js `PANEL_VIEWS = ['workbench', 'learning']`: `applyLayout` sets `--collab-w`
from the `collabWidth` pref on both; `app.showPanel(tab)` (Task, Focus, Processes, Skills) goes to the Workbench only
from other views; `]` toggles the panel where it is; Esc closes the narrow overlay on both. styles.css hides
`.collab` on every view but those two, and the narrow overlay rule covers both (`top: 0` on Learning, which has no
toolbar). The lesson head carries the same `.wb-panel-btn` the Workbench's toolbar has, so the overlay's close
returns the focus to it.

**Restart and new routes.** The client's files are served from disk, so a window reload shows a new view at once,
while a new route exists only in a server started after it was written. The top bar's Restart and Ctrl+Alt+R both
call `restartStudio` (client/components/restart.js): POST `/api/studio/restart` spawns scripts/restart.mjs detached,
which stops the verified server process and spawns a fresh `node server/index.mjs`; the page reloads once
`/api/health` reports a new `startedAt`. The route writes a timestamped `requested` line to `.local/restart.log`
before the script runs, and the script stamps each of its lines, so the log tells when a restart ran. A lessons list
answering `No route` (a server older than the client) reads as such on the shelf with a Restart button.

**The frame** (client/components/lesson-frame.js). An iframe with `sandbox="allow-scripts"` and no
`allow-same-origin` (an opaque origin: no studio API, storage, cookies or parent DOM), set before its `srcdoc`. The
document: a CSP meta first (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src
data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'`), then the studio base stylesheet with
the tokens read from the window (a value holding `; { } < > \` keeps the default), then the bridge script, then the
lesson's body in `main.lesson`. A whole document is reduced to its body with its head's `<style>` blocks in front;
`<meta http-equiv>` and `<base>` are dropped. A navigation of the frame itself is not a CSP matter: the bridge stops
link clicks that leave the page, and the sandbox has no top navigation, popups or forms.

**The bridge** (`lessonBridge`, stringified into the head). It numbers every `.step` (`data-step`, `data-steps`: a CSS
counter skips the hidden steps), shows one at a time (`html.paged`), and posts `{ type: 'atelier:lesson', what:
'steps', count, index }` to the parent ('*', the only target an opaque origin has); it takes `{ what: 'step', index }`
only when `event.source` is its parent, and pages with ArrowLeft/ArrowRight. A selection, or a press on a figure (or an
outermost svg; Enter on a focused figure; figures get `tabindex=0`), shows the Ask about this button; pressing it posts
`{ what: 'ask', kind: 'selection' | 'figure', text }` (a figure's text is its caption, aria-label or title).

**The parent's check** (client/components/lesson-words.js `readLessonMessage`). The view's message listener first
requires `event.source === frame.contentWindow`; the data must then be one of the two shapes: steps with whole
numbers, count 0–500 and index inside it; ask with a known kind and text of at most 20 000 characters, folded and cut
to 280. `askLine` builds `About "<text>" in the lesson "<title>": ` (or `About the figure "…"`) with the title from
the studio's record, never from the frame, and inner double quotes turned so they cannot close the quote. The panel's
`insertDraft(line)` appends it on its own line, focuses the box and answers `{ ok, focused, reason }`; before Start
(`no_session`) or during an answer (`running`: the line waits in the disabled box) the view says so in a toast.

**Checked by** tests/learning.test.mjs (the store, the watcher, the tools on a fake studio, the tab order and keys,
the dock and right-panel wiring, the restart log lines, the document and CSP, the tokens, the message shapes, and the
bridge run on a stub DOM), tests/dock-arrange.test.mjs (a dock with `LEARNING_DOCK`: one tab, its height key, no
dockTab, order or slot writes, clearProject), tests/companion-panel.test.mjs
(the box and the live run across a remount; insertDraft), tests/studio-show.test.mjs (lesson in checkShow and the
handler) and tests/mcp.test.mjs (a lesson through the real routes, the events and studio.show). Seen in an offscreen
Electron window against a throwaway studio on 2026-11-08 (docs/evidence/ui/uc/learning-0.3.28-*.jpg).

## 20. Live: a project's own server in the preview

Some products have their own local server that does more than the static preview (it saves files, opens a terminal).
Opt-in on both sides: the project declares it, the person allows the exact command and presses the switch. Nothing
project-specific is in the studio.

**The contract** (a project's `atelier.json`):
```json
"live": { "label": "Live mode: editor + Ubuntu terminal", "command": ["node", "server/server.js", "--atelier"], "cwd": "." }
```
- `command` is an argv array (1–64 strings) run without a shell; `node` is the studio's own Node (`process.execPath`);
  a `.cmd` or `.bat` program is refused because Windows runs it through cmd. `label` is one line (≤ 120, default
  `Live`); `cwd` is relative to the project (default `.`), resolved by `insideProject`, so not outside, `.git` or
  `.studio`. Any other key is refused. `checkLive` answers `{ live, problem }`; a problem is shown, never run.
- When ready the process prints one stdout line `{"atelierLive":1,"url":"http://127.0.0.1:<port>/#k=<token>"}`.
  Accepted: `http:`, host exactly `127.0.0.1` or `localhost`, an explicit port, no user or password; anything else
  that claims to be a ready line fails the start with the reason. Other output is log.
- The env is the terminal's (`terminalEnv`: no API keys, no host Claude Code markers, `ATELIER_PROJECT`,
  `ATELIER_STUDIO`) plus `ATELIER_FRAME_ORIGIN`: the studio origin the Workbench frames from (the client's
  `location.origin` when it is this studio's `127.0.0.1` or `localhost` origin, else `http://127.0.0.1:<port>`), so
  the product can allow exactly that origin as `frame-ancestors`.

**Server** (`server/lib/live.mjs`, `createLive` in `index.mjs`; memory only, one process per project):
- `GET /api/projects/:id/live` → `{ declared, problem, cwdPath, consent: { allowed, allowedAt, changed }, state,
  reason, pid, startedAt, readyAt, endedAt, url, origin, running, stale, log }`. state is `off`, `starting`,
  `running` or `failed`; `url` and every log line are masked; `stale` says the manifest's command changed while the
  allowed one runs. `log` is a ring of 400 lines (`{ at, stream, text }`, 2000 characters each).
- `POST …/live/consent { command, cwd }` stores the allowance in `<data>/live-consent.json` (the studio's data
  folder, never the project's) keyed by sha256 of the real folder, the argv and the cwd; the body must equal the
  manifest's now (409 `live_changed` otherwise), so the click consents to what was shown. `DELETE …/live/consent`
  forgets it. A changed command, cwd or folder reads `allowed: false, changed: true` and asks again.
- `POST …/live/start { origin? }`: 403 `live_consent_needed` without the allowance, 409 `live_running` when
  starting or running, 400 `live_invalid` / `live_not_declared`. Spawns with `shell: false`, `windowsHide`, stdin
  ignored, and (off Windows) its own process group. No ready line within 20 s, a refused URL, an exit before ready
  or a program that does not start → `failed` with the reason, and the tree is ended. An exit after ready →
  `failed` "it exited by itself". Restarts are the person's: nothing restarts by itself.
- `POST …/live/stop`, and the studio's own stops: activating another project stops every other project's live
  server ("the project was closed"), removing a project stops its own, `POST /api/studio/restart` stops all before
  the restart script runs (it ends the server without exit handlers on Windows), and the exit handler and
  SIGINT/SIGTERM stop all ("the studio quit"). `killTree` is synchronous: `taskkill /PID <pid> /T /F` on Windows,
  SIGTERM then SIGKILL to the process group elsewhere.
- **The token.** `maskSecrets` replaces every URL fragment, every `k=` value and, once the ready line is read, the
  fragment and its values wherever they appear (lines logged before it are masked again). Only `GET /live/<id>`
  hands the full URL on: a 302 to it with `Cache-Control: no-store` and `Referrer-Policy: no-referrer` for the
  Workbench frame, or a 409 page when Live is not running. The client never holds the token.
- Runs: a live server is a run of kind `live` (section 16), named by its label, latest "serving 127.0.0.1:<port>",
  ended Stopped with the reason it stopped or Failed with the reason it failed.

**Workbench** (`client/components/live-switch.js`, words in `live-words.js`): when the manifest has `live`, the stage
head gets a Live switch (a checkbox with role switch), a state chip (Off, Starting, Running, Failed, Invalid) and a
Log disclosure (label, command, folder, masked address, the masked log, Forget the allowance). The first start of a
command opens a dialog naming the exact argv and folder (Cancel or Allow and start); nothing runs before that click.
While running and the head (not a version) is in view, the frame opens `/live/<id>?t=…`; the line above the preview
reads `Live · <label>` and the address, the line under it is hidden (`stageFoot`; decision row 149: the person
wanted the height), the Log says that Page, Select, Phone and side by side still read the files on disk, and Select is
disabled with that fact as its tooltip (`LIVE_SELECT_TITLE`; the frame is another origin). A failed or invalid Live says why in the
line under the preview, because the head has no room for a reason at laptop width. Off returns the frame to
`/preview/`. `live.changed { projectId, log? }` refreshes the switch; log lines only while the Log is open.

**Companion**: `atelier_live_status` (read-only) says what is declared or why it is not valid, whether the person
allowed it, the state with reason, address and pid, and the last 15 masked log lines.

**Not a sandbox.** The preview pages are same-origin with the studio's API, which also opens terminals; the consent
and the switch keep the studio from starting a project's server by itself, not a hostile page in the studio's own
origin from calling the routes.

**Checked by** tests/live.test.mjs (the manifest contract, cwd confinement, the ready-line parser on loopback,
non-loopback, junk, timeout and early exit, masking also before the ready line, consent invalidation on a changed
command or cwd, start/stop of `tests/fixtures/fake-live.mjs` with its grandchild gone after stop, stopOthers and
stopAll, the switch's words) and tests/mcp.test.mjs (the routes, `/live/<id>`'s 302 carrying the token the fake
printed, the masked tool text, the stop on activating another project). Seen by eye in an offscreen Electron window
at 1280×800 with `scripts/ui-check/verify-live.cjs` (off, consent, running, log, off again, a changed command asking
again and failing, an invalid entry).

## 21. Codex dock tab

A second brain beside the Companion: a Codex CLI session in the Workbench dock, on the login the person saved with
`codex login` (decision row 151). It is a console backend like the others (section 7), so the records, the events,
Stop, the runs registry, the ghost marker and the Claude Code view's list all hold for it unchanged.

**Backend** (`server/lib/codex.mjs`; wired into `server/lib/console.mjs` as backend `codex`, which hands the runner its
own `attachChild`, `armTimeout`, `pushEvent` and `strippedEnv`).

- **The binary** is found the way `resolveClaude` finds claude: env `ATELIER_CODEX_BIN`, else
  `settings.console.codexPath` (Settings › Console › Codex path), else `codex.exe` / `codex.cmd` / `codex` on PATH,
  else the Windows installer's own folder (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`). A set path that is not a file
  means no CLI, never a fall through to another one.
- **A turn** is `codex exec --json --skip-git-repo-check [-m <model>] [-c model_reasoning_effort="<effort>"]
  -c sandbox_mode="<sandbox>" [the MCP overrides] -` in the project folder, the message on stdin; from the second
  message on it is `codex exec resume … <thread id> -` with the id the first run's `thread.started` named
  (`rec.codexThreadId`). The sandbox goes as a `-c` override because `exec resume` has no `-s` flag (codex-cli 0.160.0).
  Nothing else is passed: no `--dangerously-…` flag, no approval policy, and `codexArgs` throws for a sandbox other than
  `read-only` or `workspace-write`. A thread id that does not match `[A-Za-z0-9][\w-]*` is not passed.
- **The env** is the console's `strippedEnv` (no Anthropic keys, no host Claude Code session variables) less
  `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` (`dropCodexKeys`), so a run can only use the login saved
  in `CODEX_HOME` (kept: it is the person's setting). Which kind that is comes from `codex login status`
  ("Logged in using ChatGPT" → `chatgpt`, "…an API key" → `api-key`, "Not logged in" → signed out), asked in the same
  env and reused for a minute; the tab's head and every turn (`turn.login`) say it.
- **The stream.** `createCodexParser` reads the JSONL lines into the turn every backend records:
  `item.completed agent_message` → text (messages joined by a blank line); `command_execution` → a `tool` event named
  `Shell` whose summary is the command without Codex's shell wrapper (`"…pwsh.exe" -Command '…'`, `bash -lc "…"`), then
  a `tool-result` (ok from `exit_code`, the output as summary and detail, 4000 characters) or `denied` when its status
  is `declined`; `mcp_tool_call` → `mcp__<server>__<tool>` with its result text, or `denied` when the error says it
  needs approval; `file_change` → one `Write` (add), `Edit` (update) or `Delete` per path (absolute, as Codex gives
  it; the row shows at `item.started`, once), so the ghost marker reads a Codex edit as it reads Claude Code's; `web_search` → `WebSearch`; `reasoning`, `todo_list`, an `error` item and any
  line that is not JSON → a status line; `turn.completed` → `turn.usage` under the names the meta line reads
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens` from `cached_input_tokens`, `reasoning_output_tokens`).
  No cost is recorded: Codex reports none. Each tool event carries `ms` since the run began.
- **How a run ends** (`parser.result`): `turn.failed` or a top-level `error` gives the message (Codex nests JSON in the
  string; `codexErrorOf` reads its `error.message`, `code` and `status`). A model Codex refuses (`model_not_found`, "is
  not supported when using Codex…") is `turn.modelRefused` with the error "Codex refused the model <id>: choose another
  model in the tab and send the message again. Codex said: …"; a run with no tool call that failed for want of a login
  (status 401 or its sign-in words) is `turn.signedOut` with "Codex is signed out on this machine: run `codex login`
  in a terminal, then send the message again." and the cached login answer is dropped. The session's model is never
  changed by either.
- **Before a message is recorded** `codex.ready()` answers 503 `console_no_codex` ("The Codex CLI was not found: install
  it, or set its path in Settings › Console (or ATELIER_CODEX_BIN).") or 503 `console_codex_signed_out` (a signed-out
  answer is asked again fresh first), so the person's words go back into the box and nothing is stored.
- **The choices.** `GET /api/console/codex[?fresh=1]` → `{ cli, bin, version, loggedIn, login, models: [{ id, name,
  efforts, defaultEffort }], source, defaults: { model, effort }, configRead, sandboxes, defaultSandbox, problem,
  checkedAt }`. `models` are `~/.codex/models_cache.json`'s with visibility `list`, in Codex's order (`source`
  `models_cache.json`), else a short built-in list (`source` `built-in`); `defaults` are the top-level `model` and
  `model_reasoning_effort` of `~/.codex/config.toml` (read line by line up to the first `[table]`; no TOML dependency),
  and a config model the list lacks is added so it can stay chosen. `problem` is the one sentence for no CLI or signed
  out, else null. `~/.codex` is only ever read.
- **A session record** (`POST /api/console/sessions { backend: 'codex', projectId, model?, effort?, sandbox?, tools? }`)
  keeps `model` and `effort` (what was asked, else config.toml's, else null for Codex's own default; config's effort only
  when the model takes it), `sandbox` (`read-only` unless asked) and `codexThreadId`. `PATCH` takes `model`, `effort`
  and `sandbox` between turns, checked by `checkCodexChoice`: an unknown model or sandbox is 400, and so is an effort
  the resulting model does not take (the studio does not move it). Another backend given a `sandbox` is 400.
- **Studio tools** (`tools: 'studio'`): the same server and env as a Companion's (`studioMcpConfig`, section 11),
  attached for the run alone with `-c mcp_servers.atelier.command="…"`, `-c mcp_servers.atelier.args=[…]`,
  `-c mcp_servers.atelier.env={ATELIER_SESSION_ID="cs_…"}` and
  `-c mcp_servers.atelier.default_tools_approval_mode="approve"`. The last one is needed: `exec` never asks, and
  without it Codex refuses the call ("MCP tool call requires approval, but approval policy is never"). It approves the
  studio's own server only, as `--allowedTools mcp__atelier__*` does for Claude Code. `~/.codex/config.toml` is not
  written.
- **What the first message carries.** Codex has no system prompt flag, so the first message opens with its role
  (`CODEX_ROLE`), the tools' sentence, the sandbox sentence and, for a session with a project, the Companion's context
  pack (section 12; the turn's meta line says "with the studio context"). A later message opens with one bracketed line
  only when the person changed the sandbox since Codex was last told (`rec.sandboxTold`). The record keeps the
  person's words alone.

**Panel** (`workbenches/codex/panel.js`, words in `client/components/codex-words.js`; the tab `codex`, labelled Codex,
the second dock tab on every project). The Companion's layout and classes; the thread, the live rows, the trajectory,
the state line and the pin cards are `client/components/session-parts.js`, which the Companion panel uses too (split
out of it for this tab). Its own:

- **The head** reads `Codex · <model name> · <login>`: "your ChatGPT login", "an API key saved in Codex", "signed out"
  or "CLI not found", from the status route. Three quiet selects follow: the model (Codex's names), the effort (the
  ones the chosen model takes, with Default effort), and the sandbox, which reads "Sandbox: read-only" or "Sandbox: may
  edit files" and takes the state colour while Codex may edit. With a session a choice is PATCHed first and shown only
  once the server took it; a model that does not take the current effort sends both in one change and a toast says so.
  The model and effort are kept per project (`project.ui.codex`); the sandbox is the session's, and New session starts
  read-only again.
- **The session** is created on Start (`tools: 'studio'`, title `Codex · <project>`), its id kept in
  `project.ui.codexSessionId`, read again on mount (a 404 clears it), so it survives a reload.
- **The state line** (`codexState`): No Codex, Signed out and Model refused are its own; a run that found no login
  reads Signed out until the CLI says it is signed in again, then Failed · the last message found no login · send it
  again; everything else is the Companion's rule (Working with the clock and the last call, Done, Needs you, Stopped,
  Failed, Idle). No CLI and signed out also show their sentence in a note under the thread with Check again
  (`?fresh=1`), and Start is off while either holds.
- **Pins** list under the thread and ride a message as in the Companion tab; attachments, Make it a task and Chrome
  are the Companion's alone.
- **Elsewhere**: the Claude Code view lists a Codex session with its model and sandbox in the head and no context
  select; its New session dialog does not offer Codex (`BACKENDS.codex.ownTab`). A turn's meta line reads
  `<model>, <effort> effort, sandbox <sandbox> · <time> · <tokens> · on your ChatGPT login` (or "billed to the API key
  saved in Codex"). The usage tally (section 17) counts Codex sessions apart from Claude Code's, with no cost.

**A Codex worker** (section 17, Codex workers) is this backend with `worker: true`: always `workspace-write`, no studio
tools, the worker's role in place of `CODEX_ROLE`, no context pack, the worker's 90 minutes, and every child's env
carries `ATELIER_ACTOR=codex` so the studio CLI it runs records Codex as the caller. Nothing else differs: the same
argv, the same stripped env, the same parser and records.

**Checked by** tests/codex.test.mjs (the config and cache readers, the argv with and without resume and MCP and never a
bypass, the choice check, the parser on every item kind, the two failure sentences, and through the console with
`tests/fixtures/fake-codex.mjs`: config defaults and read-only, refused sandboxes at create and patch, the env without
`OPENAI_API_KEY` or host Claude Code variables, resume with the thread id, the sandbox told once after a change, no MCP
without Studio tools, a refused model, signed out before and during a run, no CLI, the status, Stop),
tests/codex-panel.test.mjs (the real panel, words and shared parts on a stub DOM) and tests/http.test.mjs (the routes).
Seen in an offscreen Electron window at 1280×720 with `scripts/ui-check/verify-codex.cjs` (the fake CLI: 27 checks),
and once with `--real` on 2026-11-13 against codex-cli 0.160.0 on the person's ChatGPT login (23 checks): an answer on
gpt-6-astra at low effort, its `git status --short` as a Run row, a file it was asked to create not created under
read-only, the second message on the same thread id calling `atelier_read_briefing`, the session after a real reload,
and `~/.codex/config.toml` with the same hash before and after. The `file_change` events were read from one real
workspace-write turn in a throwaway folder (a probe, not the tab); `reasoning`, `todo_list` and `web_search` items were
not seen from the real CLI. Codex workers: tests/codex-worker.test.mjs (the stored form on both sides, the check
against what Codex offers, the recorded finish and its completion with a real repository, the CLI's caller, usage
apart and with no cost, the tools' and the Focus panel's words, and through a real server with the fake CLI: a task
set to a Codex model ends in a version and a report; a refused command, a question and a lost login end in a truthful
report or refusal), tests/workers.test.mjs (the launch, the explore refusal, the turn's end) and tests/codex.test.mjs
(the worker session's argv, env and first message); `scripts/ui-check/verify-worker-model.cjs` (34 checks, the Focus
form with the fake CLI); and three real turns on 2026-11-14, the third a whole task through a private studio and the
manager's tools (docs/evidence/codex-worker-2026-11-14.json).

## 22. Inspiration board

Each project collects design references on a board of its own (t_dfs23bojle; decision rows 152 to 154): images, links,
color swatches and short notes, each with a few tags and an optional line saying why. The person fills it in the
Inspiration view; Claude reads it in every task brief, in the briefing and through one MCP tool.

**Records** (server/lib/inspiration.mjs). `<project>/.studio/inspiration.json` = `{ cards: [...] }` in board order,
and the image files in `<project>/.studio/inspiration/<card id>.<ext>`. Like every `.studio` record they are
excluded from the product's git history (section 1, decision row 3), so the board belongs to the project folder but is
not part of a version: Restore does not touch it and a new card never makes the tree dirty (row 152). A card is
`{ id, kind, tags, why, createdAt, updatedAt }` plus, by kind:

- `image`: `file`, `type` (png, jpg, gif, webp, svg), `bytes`, `width`, `height` (when the header says them), `name`
  (the name it came with, as words only);
- `link`: `url` (as the person gave it, also after a redirect), `title`, `description`, `site`, `image` (`{ file,
  type, bytes, width, height }` or null) and `preview` (`{ ok: true, at, imageReason? }` or `{ ok: false, reason, at }`);
- `color`: `hex` (`#rrggbb`, lower case), `name`, `from` (the image card it was picked from, or null);
- `note`: `text` (at most 2000 characters, line breaks kept).

Ids are `ins_` + 4 to 40 of `[a-z0-9]` (`newId('ins')`); a file name is that id and an extension read from the bytes
(`FILE_NAME`), and nothing a request says ever becomes part of a path: any other id or name is a 404. Tags are lower
case, one line, at most 24 characters and 6 per card, each once; the default set is `color, layout, type, motion,
mood` (`DEFAULT_TAGS`) and any other word is the person's own. `why` is one line of at most 200 characters. A board
keeps at most 300 cards (409 `board_full`). A new card goes first on the board; `after: <card id>` puts it behind that
card, and colors picked from one image line up behind it in the order they were picked. Writes are atomic
(`writeJson`, `writeBytes` in fsutil.mjs) and queued per project folder; a link's preview is fetched outside the
queue, so other cards do not wait for a slow page. Remove writes the record first and then unlinks the image.

**What is read back is checked again** (`validCard`). The file can be edited by hand or come with an imported folder,
so an entry is a card only with an id of the board's shape and one of the four kinds, and a `link` only when its `url`
is an http or https address (`httpUrl` in client/components/inspiration-words.js: the scheme as written, with nothing
before it, and an address a browser can read). Any other entry is left out of every answer (the GET route, the
brief, the briefing's count, the tool, the image route for its preview file) and cannot be edited, moved or removed by
id; the next write of the board leaves it out of the file too (decision row 177). The view asks the same `httpUrl`
before it makes a link: a card that reaches it with another address shows its words in a `span` and has no `href`.
The references follow the same rule (`validRef`, section 25).

**An image is what its bytes say** (server/lib/image-type.mjs). `imageType` reads PNG, JPEG, GIF and WebP by their
signatures and SVG as UTF-8 text that opens with an `<svg>` element (past a BOM, an XML declaration, comments and a
doctype; a NUL byte or other markup is not an SVG); the name and the MIME type a browser sent are never used.
`imageSize` reads the pixel size from the header (PNG IHDR, GIF screen, JPEG start-of-frame, WebP VP8/VP8L/VP8X, SVG
width and height or viewBox). `checkImage` answers 413 `too_large` over 8 MB (`IMAGE_MAX_BYTES`; the route's body limit
is 24 MB so that a file well over the limit still gets this sentence rather than the generic one) and 415
`unsupported_image` for any other content. The file route serves only a name of the board's shape that a card on the
board names and whose bytes still are an image, under the type read from those bytes, with `X-Content-Type-Options:
nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (`fileHeaders`): an SVG
opened by its address runs no script and loads nothing, and the view shows every image through an `<img>`, where a
browser runs no script of an SVG either.

**Link previews** (server/lib/link-preview.mjs). `checkLinkUrl` takes only `http:` and `https:`, no user name or
password, no local name (`localhost`, a single label, `.local`, `.internal`, `.lan`, `.home.arpa` and the like) and no
address `isPrivateAddress` refuses: loopback, private, link-local, carrier NAT, multicast, reserved and documentation
ranges, and the IPv6 forms that carry such an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo). The WHATWG URL
parser has already folded `2130706433`, `0x7f.1` and `0177.0.0.1` into `127.0.0.1` by then. For a name, the lookup
that checks is the lookup that connects (`guardedLookup` is passed to `http.request` as `lookup`, with `agent: false`):
a name is refused when any address it resolves to is private, so it cannot answer twice. Redirects are followed by
hand, at most 4, each address checked before it is asked. One GET has a deadline (8 s, `LINK_TIMEOUT_MS`; the page and
the preview image each get one) and a byte cap (2 MB of a page, `PAGE_MAX_BYTES`, because some sites send their title
a megabyte in: linear.app's sat at 960 KB on 2026-11-13; 4 MB of an image). gzip, deflate and brotli are unpacked.
`pageMeta` reads `og:title`, `twitter:title` or the title element, the description, `og:site_name` and `og:image`
(scripts, styles and comments are not read). The preview image is fetched under the same guard and kept only when
its bytes are an image; a link straight to an image is its own preview. The request names a generic client
(`AtelierLinkPreview`), nothing of the person or the project.

What is refused and what is only left plain: the link itself being unfit (scheme, credentials, a local name or
address, or a name that resolves to a private address) is a 400 `unsafe_link` with a sentence, and no card is made.
Everything else never fails the add: a page that answers an error, times out, redirects to a private address, is
not HTML, or cannot be reached leaves a plain link card with `preview: { ok: false, reason }`, and the card shows the
reason beside its site. `PATCH … { refetch: true }` fetches again; a fetch that fails then leaves the title and image
the card had.

**Events.** Every route change emits `inspiration.changed { projectId, cardId, action: added | changed | moved |
removed }`; the `.studio` watcher reports a write of `inspiration.json` as `inspiration.changed { file }` too
(server/lib/watch-events.mjs; the image folder and temp files say nothing), so a hand edit or another window reaches
an open view. The client re-emits it as the app topic `inspiration`. An add or a remove also writes the briefing
again, since it names the count.

**What Claude reads.**
- *The brief* (server/lib/tasks.mjs `inspirationSection`): one `## Inspiration` section holding what the person typed
  for the task (as before), then the board as `briefLines` gives it: a sentence with the count and
  `.studio/inspiration.json`, then at most 12 cards (`BRIEF_CARDS`), tagged cards first and board order within each,
  one line per card (`cardLine`: kind, then an image's path in the project with its size, a link's address and title
  with its preview image's path, a hex with its name, or a note's first 160 characters; then tags and why), then
  `- and n more on the board`. An image is named by path so a worker opens it with its Read tool. The section is
  written when the task is created and again at every handover (`rewriteBrief`), so a session reads the board as it
  stands when it starts; with no typed line and an empty board there is no section. A board that cannot be read is no
  lines, never a reason not to write the brief.
- *The briefing* (server/lib/briefing.mjs): one line under Identity, `Inspiration board: 7 cards (1 image, 2 links, 3
  colors, 1 note) in .studio/inspiration.json, images in .studio/inspiration/; atelier_read_inspiration lists them`, or
  that there are no cards yet and where they would be.
- *The tool* `atelier_read_inspiration { project?, tag?, card? }` (server/lib/mcp/tools.mjs): the whole board in board
  order with each card's id and nothing cut short; `tag` only the cards with that tag (or the tags in use when none
  has it); `card` one card in full and, for a PNG, JPEG, WebP or GIF of at most 4 MB, the image as an image block (an
  SVG and a larger file are named by path instead). It reads only. `atelier_studio_show { view: 'inspiration' }` moves
  the window to the view (`SHOW_VIEWS`, `VIEW_ROUTES`).

**The view** (client/views/inspiration.js, components/inspiration-card.js, inspiration-edit.js and the pure
inspiration-words.js; styles in client/inspiration.css under the class prefix `inspo-`, since `insp-` is the task
inspector's; DESIGN.md section 10). The tab sits after Learning (key 3) and has no right panel. It shows the board of
`app.projectId()` and reads again on `project-switch`, on `inspiration` for that project (150 ms of quiet) and after
a reconnect. A read that answers the board as it already stands (the echo of this window's own change) redraws
nothing; a redraw gives the focus back to the card that held it.

- *Adding.* One field takes what is typed: `detectKind` reads one `http(s)://` or `www.` word as a link, a hex value
  as a color (without `#` only when it holds a digit, so "added" stays a word) and anything else as a note, and the
  primary button names it (Add link, Add color, Add note). Images come by **Choose images**, by a drop anywhere on the
  view and by a paste anywhere (a paste of text into a field stays the field's). A dropped or pasted link or color is
  added at once; other words wait in the field for Add. A file is read as base64 and sent; only its size is judged
  in the window (`fileProblem`, the server's own sentence), what it is the server reads from its bytes. A refusal is
  the server's sentence in a toast that stays, and a refused typed card goes back in the field.
- *The board* is a CSS grid with `grid-auto-flow: row dense` and 4 px rows: each card spans the rows its height needs
  (`spanFor`; a first guess from `estimateHeight`, then a `ResizeObserver` measures), so cards pack by height while
  the DOM order, and with it the tab order, stays the board order. Columns are `repeat(auto-fill, minmax(280px, 1fr))`:
  4 at 1280 px, 6 at 1920 px.
- *A card* takes the focus itself: Enter edits, Delete removes after one question (`Remove` / `Keep it`), Alt with an
  arrow moves it one place among the cards on screen (`stepTarget`), and a drag onto another card puts it before or
  after (`dropTarget`; a 2 px accent line in the gap shows where). A move is shown at once, then sent as
  `{ id, before }`. Its actions (Pick color on a card with an image, Edit, Remove) show on hover or focus.
- *Edit* is a dialog: why, the tags (the default set, the board's own, new ones typed) and the card's own words (a
  note's text, a color's hex and name, a link's title with Fetch the preview again). It sends only what changed and
  keeps a refusal in the dialog.
- *The eyedropper* (`startPicker`): the image is drawn to a canvas (at most 1600 px on its longer side); the pointer
  or the arrow keys choose a point, a mark and the hex follow with no transition, a click or Enter adds a color card
  `{ hex, from, after }` behind the image, Esc or Done stops. The card keeps its node across the redraws its swatches
  cause, so several colors are picked in a row.
- *The filter* is the tags in use with their counts (the default set first); the choice is kept per project for the
  window.

**Checked by** tests/inspiration.test.mjs (the image types and sizes by content; the address guard, the URL check in
every spelling, the lookup guard; `pageMeta`; the fetch against a local server: a page, a redirect, gzip, a direct
image, a title a megabyte in, and every way of not failing hard; the store: four kinds, order, edit, refetch, move,
remove with its file; every refusal with its sentence; no request text as a path; a link written into the file by
hand with a `javascript:` address or any other address that is not http or https, left out of every answer; the file
headers; the words, the brief section and the watcher; and through a real server process the routes, the briefing, a
new task's brief and the tool with its image block, and the same hand-written link not served by any of them),
tests/inspiration-view.test.mjs (the pure parts, the wiring of the tab, the design rules as source checks) and
tests/inspiration-card.test.mjs (the real `cardNode` on a stub DOM: an anchor only for an http or https address, a
`span` with no `href` for every other). Seen in an offscreen Electron window with `scripts/ui-check/verify-inspiration.cjs` on a
throwaway server and an empty throwaway project on 2026-11-13: the tab and key 3, the empty state, a note and a color
by the field, a refused local link back in the field, an image by pick, drop and paste, a refused file, a real link
(linear.app/method: title and a 1200 px preview image), Edit with a refusal kept in the dialog, the filter, a move by
Alt+Right and by drag with the focus kept, two picks with the eyedropper landing behind their image, Remove after
Keep it, and the same board after a real reload; no overlap and no sideways scroll at 1280×720 and 1920×1080. With
the word `look` the driver only reads: the studio's own board (7 cards) was captured that way at both widths
(docs/evidence/ui/uc/inspiration-01 and -02).

## 23. Fixed rules

What must stay the same in a project's design while everything else is free to change (t_coydia7ucq; decision rows 155
to 158). The person keeps the rules beside the inspiration board; Claude gets them in every task brief, in the briefing
and through one MCP tool. It is the second of the pieces the public studio needs (the board, section 22, was the first);
the customization settings that follow read the locked tokens from here.

**Records** (server/lib/rules.mjs). `<project>/.studio/rules.json` = `{ rules: [...] }` in the order the rules were
added, on the pattern of the board: every path through `insideProject()`, atomic writes (`writeJson`), one queue per
project folder so two writes never read the same list. Like every `.studio` record the file is outside the product's
git history (section 1, decision row 3): Restore does not touch it and a new rule never makes the tree dirty. A rule is
`{ id, text, kind, why, token, createdAt, updatedAt }`:

- `id`: `rule_` + 4 to 40 of `[a-z0-9]` (`newId('rule')`); any other id is a 404 and touches nothing.
- `text`: one sentence on one line, at most 200 characters; required.
- `kind`: one of `color, type, layout, motion, tone, behaviour` (`RULE_KINDS`; `behavior` is taken as `behaviour`);
  required, with no default, so a rule is never filed under a kind nobody chose.
- `why`: one line of at most 300 characters, or empty.
- `token`: `{ name, value }` or null: one CSS custom property the rule locks at one value.

A project keeps at most 60 rules (409 `rules_full`), because every brief carries all of them.

**A locked token.** `checkTokenName`: two dashes, then letters, digits, `-` or `_`, at most 64 characters, kept as
typed (custom property names are case sensitive). `checkTokenValue`: one CSS value on one line of at most 200
characters. The value is written as it is into briefs and, by the customization settings, into style sheets, so
nothing that could end the declaration, open another, hide text or load a file is taken: none of `; { } < > \ !`, no
comment, no `url()`, `src()`, `image()`, `image-set()`, `cross-fade()`, `element()`, `paint()`, `expression()`,
`attr()` or `env()`, no `@`, no control character, and every quote and parenthesis closes. Each refusal is a 400
`invalid_input` with a sentence naming what is wrong, and writes nothing. A name without a value, or a value without a
name, is refused; both empty is no lock. One token has one rule: a second rule naming a property another rule locks is
a 409 `token_locked` naming that rule and its value, also when the value is the same (`checkFree`, inside the queue,
so two requests at once cannot both win). `lockedTokens(rules)` gives `[{ name, value, ruleId, text }]`, which GET
answers as `locked`: what a settings screen must refuse to change. The Appearance settings read it for the studio
project and refuse a locked control, in the view and in the route (section 24). Nothing enforces a lock on a
project's files; there a lock is a record that Claude is told about.

**Events.** Every route change emits `rules.changed { projectId, ruleId, action: added | changed | removed }` and
writes the briefing again; the `.studio` watcher reports a write of `rules.json` as `rules.changed { file }`
(server/lib/watch-events.mjs; temp files say nothing), so a hand edit or another window reaches an open view. The
client re-emits it as the app topic `rules`. A hand edit does not write the briefing again by itself.

**What Claude reads.**
- *The brief* (server/lib/tasks.mjs `rulesSection`): a `## Must stay the same` section right after the Request and
  before Inspiration, since a constraint comes before a reference. `briefLines`: one sentence (the count, the file,
  keep to every one, leave a locked token at its exact value, and ask with `task question` when the request cannot be
  done without breaking one or asks to change one), then every rule, none cut, by kind in the kinds' order and the
  order added within a kind (`byKind`), one line each (`ruleLine`: kind, the words, the locked token as
  `--accent: #d6a455` in code marks, why). With no rules the section still stands and says so; a list that cannot be
  read says that it could not be read and to ask before changing the look, never that there are none (`briefRules`).
  Written when the task is created and again at every handover (`rewriteBrief`), so a brief from before this version
  gains the section when it is handed over.
- *The briefing* (server/lib/briefing.mjs): its own `## Must stay the same` section after Where we are: the count
  (`rulesCount`: `12 rules (4 lock a design token)`), the file and the tool, then the same lines. The rules are listed,
  not only counted, because the briefing is what a session with no task brief reads (decision row 157).
- *The tool* `atelier_read_rules { project?, kind? }` (server/lib/mcp/tools.mjs): every rule by kind with its id, the
  token it locks and why, then the locked tokens in one line; `kind` only the rules of that kind (or the kinds in use
  when none is of it). It reads only.

**The view** (client/components/rules-panel.js, rules-edit.js and the pure rules-words.js, mounted by
client/views/inspiration.js; styles in client/inspiration.css under `.rules` and `.rule`; DESIGN.md section 11). The
Inspiration view has its parts chosen by a segmented control beside its title: **Board** and **Fixed rules** with the
count of rules (and, since section 25, **References**). The address names the part: `#/inspiration` and `#/inspiration/rules`. The app's router reads the
first word of the address, so the Inspiration tab stays current, a reload keeps the part, and key 3 opens the board.
The view listens to `hashchange` while it is mounted (`applyMode`): the part not shown is hidden with its controls,
so one primary button is in sight (Add on the board, Add rule on the rules), and while the rules are shown the board's
paste, drop and eyedropper stand still.

- *The list*: the rules by kind, each kind under an overline with its count, in CSS columns of at least 420 px (two at
  1280 px, three at 1920 px; at most three). A kind is never cut between two columns. The panel reads again on
  `project-switch`, on `rules` for its project (150 ms of quiet) and after a reconnect; the echo of the window's own
  change redraws nothing, and a redraw gives the focus back to the rule that held it.
- *A rule* takes the focus itself: Enter (or a double click) edits, Delete removes after one question (`Remove` /
  `Keep it`). Its two actions keep their place in the row and show on hover or focus.
- *Add rule and Edit* are one dialog (`ruleDialog`): Rule, Kind (no kind chosen on a new rule), Why, then the locked
  token's name and value with a swatch when the value is a color (`swatchOf`). An edit sends only what changed
  (`formPatch`; both token fields emptied sends `token: null`). A refusal stays in the dialog as the server's sentence
  and the focus goes to the field it is about.

**The studio's own rules** (server/lib/rules-seed.mjs, scripts/seed-studio-rules.mjs). `STUDIO_RULES` writes down
what docs/DESIGN.md and the accepted decisions already fix, each with its source in `why`: 12 rules over the six
kinds, of which four lock the tokens that carry the look's identity in the dark theme (`--bg`, `--ink`, `--accent`,
`--serif`, each at the value client/styles.css holds, which a test compares). `seedRules` writes only into a list
that holds nothing; the script was run once on this studio folder on 2026-11-13 and the rules are the person's from
then on. The seeds are not applied to other projects.

**Checked by** tests/rules.test.mjs (the store; every refused token name and value with its sentence; refusals that
write nothing; one token, one rule, also under two writes at once; the seeds against client/styles.css; the words; the
brief section in its place, with none and with an unreadable list; the watcher; and through a real server process the
routes, two projects kept apart, the briefing, a new task's brief and the tool) and tests/rules-view.test.mjs (the
pure parts, the wiring of the part and its address, the design rules as source checks). Seen in an offscreen Electron
window with `scripts/ui-check/verify-rules.cjs` on a throwaway server and two throwaway projects on 2026-11-13, 31
checks: the switch and its address, the empty state, Add rule, a refused kind, a refused token name and a refused value
kept in the dialog with the focus on their fields, the lock with its swatch, a rule arriving from outside the window,
Edit by Enter, a paste that adds no card, Remove after Keep it, the same rules after a real reload, the other
project's own rules, the focus ring by a real key press, no overlap and no sideways scroll at 1280×720, 1920×1080 and
1000×700, and the light theme read from the captured picture (docs/evidence/ui/uc/rules-01 to -04 show the seed rules).

## 24. Appearance

The person's own look for the studio (t_8ijmo5ji11; decision rows 159 to 163): accent, density, text size, corners
and motion, chosen in Settings and applied to every view with no reload. It is the third of the pieces the public
studio needs, after the board (section 22) and the fixed rules (section 23), and it is where a rule's locked token is
first enforced by code.

**One model, used on both sides** (client/components/appearance-model.js; no DOM, no Node). `CONTROLS` names the
five controls, the CSS custom properties of client/styles.css each one writes, and for a choice its options with the
value of every token. The default option holds the stylesheet's own values (a test compares them), so a default
writes nothing.

| Control | Options (default first in bold) | Tokens it writes |
|---|---|---|
| `accent` | a hex per theme | `--accent`, `--accent-soft`, `--accent-ink`, `--focus` |
| `density` | **comfortable**, compact | `--ctl-h`, `--ctl-h-sm`, `--ctl-pad`, `--row-h`, `--top-h`, `--view-h`, `--cell-y` |
| `textSize` | small, **default**, large, larger | `--fs-title`, `--fs-h`, `--fs-body`, `--fs-sm`, `--fs-meta`, `--fs-xs`, `--fs-over` |
| `radius` | sharp, **soft**, round | `--r1`, `--r2`, `--r3` |
| `motion` | **normal**, reduced | `--t` (and `data-motion="reduced"` on the root) |

The tokens `--ctl-h`, `--ctl-h-sm`, `--ctl-pad`, `--row-h`, `--cell-y`, `--r3`, `--fs-sm` and `--fs-xs` are new in
client/styles.css, at the values that were written out before (32, 28, 5, 40, 6, 10, 13 and 12 px); the buttons,
fields, rows, tabs, tables and dialogs of styles.css, views.css, inspiration.css and learning.css read them. Density
does not touch the spacing scale (`--s1` to `--s6`): the 8 px grid is a fixed rule of the studio in words. Reduced
motion sets `--t` to 0 ms and `data-motion="reduced"`, for which the stylesheet has the same rule as for
`prefers-reduced-motion: reduce`, which is still honoured by itself.

**The accent and its contrast.** `accentCheck(hex, theme)` takes a hex of 3 or 6 digits and the WCAG 2.1 contrast
ratio against that theme's canvas (`--bg`: `#232221` dark, `#f3f1ec` light). At 4.5:1 or more it passes: text in the
accent can be read, and the focus ring, which needs 3:1, is `mix(accent, ink, 25%)`, never closer to the canvas than
the accent. Under 4.5:1 it is refused with a sentence that gives the ratio (cut to one decimal, never rounded up to a
pass), which of the two needs it misses, and `nearestPassing`: the same hue and saturation with the lightness moved
away from the canvas only as far as it must. An accent is one colour in two shades: `accentPair(hex, theme)` keeps
the picked one for the theme it was picked in and gives the other theme its nearest passing shade; both are stored,
and each is checked against its own canvas. `--accent-ink` (the words on a filled button) is the darker or the
lighter of two inks, whichever contrasts more; `--accent-soft` is the accent at 16% (dark) or 12% (light). The
studio's own accent is nothing stored (`accentPatch` sends null for it).

**Stored per person** (server/lib/appearance.mjs). `settings.appearance` in `~/.atelier/registry.json`, only what is
off its default; never in a project. `PATCH /api/settings { appearance }` takes it out of the body before the spread
that stores the rest of the settings unchecked, and `saveAppearance` runs `checkAppearancePatch`: `null` resets every
choice; otherwise any of the five keys, a choice as one of its options or `null` (or the default) for the default,
`accent` as `{ dark?, light? }` or `null`. An unknown key, a value that is no option or no hex is a 400
`invalid_input`; an accent under the ratio a 400 `low_contrast` with the nearest shade in the sentence. A refusal
writes nothing, not even the valid half of the patch. What is read back is cleaned the same way (`cleanAppearance`),
so a hand-edited registry cannot put an unknown value or a dim accent on the page.

**The fixed rules win.** The locks are those of the studio as a registered project: the project of kind `studio` in
the studio's own folder, else the first of that kind (`studioProjectOf`); with none there are no locks. Another
project's rules are about that product. `controlLocks(lockedTokens(rules))` gives the controls a lock takes away: a
control is locked when a rule locks any token it writes. `effectiveAppearance` leaves a locked control out of what
is in effect (the choice stays stored and comes back when the rule goes), and the route answers 409 `token_locked`
with `lockSentence` (the control, the project, the rule's words, the token and its value) for any patch that would
move a locked control off its default; taking a choice back to its default is never refused. If the rules cannot be
read, nothing is in effect and a change is a 409 `rules_unread`: an unreadable list is not read as no rules. The
stylesheet's own value stays on the page for a locked token; the lock's value is not applied by the settings.

`GET /api/settings/appearance`, and `appearance` in `GET /api/state`: `{ stored, effective, locks, rulesProject,
rulesUnread }`. A saved patch emits `status { settings: true }`, and `rules.changed` makes every window read the
state again, so a new lock or another window's choice arrives without a reload.

**On the page** (client/components/appearance.js; client/app.js `applyLook`, `previewLook`, `saveAppearance`).
`applyAppearance(effective, theme)` sets `cssVars()` on the root element and takes off every token of `ALL_TOKENS`
that no choice sets, so a choice taken back leaves nothing behind. It runs after every state load and inside
`applyLayout`, because the accent is a shade per theme. `previewLook` shows choices before they are saved (the
pressed option, a colour being dragged in the picker); `saveAppearance` sends the patch, reads the state again and
ends the preview, so what stays on screen is what the server kept. `rememberAppearance` keeps a copy of the tokens
for both themes in `localStorage` under `atelier.appearance`, which client/index.html applies before the first
paint, as it does the theme; the state's answer replaces it, and Reset removes it. It is a copy for one frame, not a
second store: a lock added while no window was open shows for that frame only.

**The section** (client/components/appearance-panel.js, mounted by client/views/settings.js as the first section;
styles in client/views.css under `.look`; DESIGN.md section 12). The layout preferences that were called Appearance
are the next section, Layout. The nodes are built once and updated in place (`update`), so the pressed button keeps
the focus through the save. Accent: a native colour input, a hex field, six presets (`ACCENT_PRESETS`, each passing
on the dark canvas), and the colour cards of the open project's Inspiration board (`boardColors`: each hex once, at
most 12, read again on a project switch and on `inspiration`). A colour that fails is kept as a proposal: its
sentence in a warning note with **Use #…** for the nearest shade; nothing is saved and the page keeps the last
accent. The line under the accent says its ratio and the other theme's shade, and for the studio's own accent under
the ratio (the light theme's `#a86f17`, 3.7:1) says that too, with the same offer. A locked control is disabled
with its `lockSentence` and **Show the rule** beside it. **Reset to defaults** sends `null` and offers Undo for six
seconds. A window newer than its server (no `appearance` in the state) says so and offers the restart.

**Checked by** tests/appearance.test.mjs (the model against client/styles.css; the contrast math, every preset on
both canvases and `nearestPassing` on fifteen colours per canvas; every refused patch with its sentence; cleaning
what is stored; the locks, the choices in effect and the sentence; the tokens set and taken off on a stub root; the
first-frame copy and the key index.html reads; and through a real server process the route, refusals that write
nothing, a `studio` project whose rules lock `--accent` and `--r2`, a product's rules that lock nothing, and that no
project record holds the look; the wiring and the section's styles as source checks). Seen in an offscreen Electron
window with `scripts/ui-check/verify-appearance.cjs` on a throwaway server on 2026-11-13, 45 checks: each choice in
the computed styles at once and in the route's answer, the focus kept, a preset, a refused hex and its offer, a
board card, the picker's preview, a real reload, the light theme's shade, a lock arriving without a reload and the
route's 409 from inside the page, Reset and Undo, no sideways scroll at 1280×720, 1000×700 and 1920×1080 at the
largest text, and two looks captured on the Workbench at both sizes (docs/evidence/ui/uc/appearance-01 to -08).

## 25. References

What a project keeps to build from (t_yrm68pllr3; decision rows 164 to 167): documentation links, code snippets and
component patterns to reuse, prompts that worked, notes. The inspiration board (section 22) holds how things should
look and feel and the fixed rules (section 23) what must stay the same; the references are the material. The person
keeps them in the third part of the Inspiration view; Claude gets the ones that match a task in its brief, the count
in the briefing, and all of them through one MCP tool. It is the fourth of the pieces the public studio needs.

**Records** (server/lib/references.mjs). `<project>/.studio/references.json` = `{ entries: [...] }`, newest first, on
the pattern of the board and the rules: every path through `insideProject()`, atomic writes (`writeJson`), one queue
per project folder so two writes never read the same list. Like every `.studio` record the file is outside the
product's git history (section 1, decision row 3): Restore does not touch it and a new entry never makes the tree
dirty. An entry is `{ id, kind, title, …, useFor, source, tags, createdAt, updatedAt }`:

- `id`: `ref_` + 4 to 40 of `[a-z0-9]` (`newId('ref')`); any other id is a 404 and touches nothing.
- `kind`: `link`, `snippet`, `prompt` or `note` (`REF_KINDS`); required, and an entry keeps it.
- `title`: one line of at most 120 characters. A snippet and a prompt need one (`checkTitle`: "A snippet needs a
  title to find it by"); a link's is the page's own unless one is typed; a note may have none (its first line names it).
- a link: `url` (as given), `site`, `description` and `preview { ok, at }` or `{ ok: false, reason, at }`.
- a snippet, a prompt, a note: `text`, and for a snippet `language` (one word of `[a-z0-9+#._-]`, at most 24, or '').
  `checkText` turns line ends into `\n` and drops the space after the last line; a snippet keeps its indentation and
  loses only blank lines before it; a control character is refused.
- `useFor`: one line of at most 200 characters, or empty: when to reach for it.
- `source`: one line of at most 200 characters, or empty: where it came from.
- `tags`: the board's rule (`checkTags`: lower case, no `#`, no comma, each once, at most 6 of 24 characters).

A project keeps at most 300 entries (409 `references_full`).

**Unsafe input is refused as on the board.** A link goes through `checkLinkUrl` before anything else: only `http:`
and `https:`, no user name or password, no local name, no private, loopback or link-local address (400 `unsafe_link`
with the board's sentences), and nothing is fetched for a refused link. The title then comes through
`fetchLinkPreview(url, { image: false })` (server/lib/link-preview.mjs): the same guarded lookup, redirects checked
hop by hop, 8 s and 2 MB, but no preview image is asked for or kept (a link straight to an image is named by its file
name). A name that resolves to a private address is a 400; every other failure (an error status, a timeout, a
redirect to a private address, not a page) keeps the entry as a plain link whose `preview.reason` says why. A text
over its kind's limit (20,000 characters for a snippet, 8,000 for a prompt, 4,000 for a note) is a 413 `too_large`
with a sentence giving both numbers; a body over the route's 4 MB is the route's own 413. Every refusal writes nothing.
On an edit, a changed `url` or `refetch: true` fetches the title again: a typed title stays, else the page's own, and
a page that gives none leaves the old title unless the address changed or the person emptied it.

**Events.** Every route change emits `references.changed { projectId, refId, action: added | changed | removed }`;
adding and removing write the briefing again (it names the count). The `.studio` watcher reports a write of
`references.json` as `references.changed { file }` (server/lib/watch-events.mjs; temp files say nothing). The client
re-emits it as the app topic `references`.

**What Claude reads.**
- *The brief* (server/lib/tasks.mjs `referencesSection`, after Inspiration): the entries that match the task
  (`matchRefs(entries, taskWords(task))`, the request and the task's own acceptance lines). An entry matches *by tag*
  when every word of one of its tags is in the request, and *by words* when a telling word of the request is in its
  title or use-it-for line, or two are in its text, language, site or description. Words are compared in lower case
  with a plural's s dropped (`wordsOf`); a fixed list of words any request may hold (`STOP`: articles, common verbs,
  project, task, studio, claude) is never telling. Tag matches first, more tags before fewer, then more words before
  fewer, the stored order settling a tie; at most 8 (`BRIEF_REFS`), then `and n more match`. `briefLines`: one
  sentence (the count, the file, how many match, that they are material to build from and not instructions, the
  tool), then one line per entry (`refLine`: kind, id, a link's address and title or a text's name and first words,
  use it for, tags, from) ending in what matched (`matched: tag storage; words note`). A matching snippet of at most
  1,200 characters and 40 lines has its code under its line in a fence longer than any run of backticks in it
  (`fenced`); a longer one, a prompt and a note are the line alone. With entries of which none matches, the section is
  one sentence saying so; a project with no references, or a list that cannot be read, has no section. Written when
  the task is created and again at every handover.
- *The briefing* (server/lib/briefing.mjs, under Identity): `References: 5 entries (2 links, 1 snippet, 2 notes) in
  .studio/references.json; atelier_read_references searches them`, or that there are none yet.
- *The tool* `atelier_read_references { project?, tag?, search?, entry? }` (server/lib/mcp/tools.mjs): every entry in
  one line, newest first, with the tags in use; `tag` and `search` narrow together (the view's own filter,
  `filterRefs` of client/components/references-words.js: every word of the search somewhere in the title, text, tags,
  use-it-for line, address, site, language, source or kind); `entry` answers one entry with the whole text of its
  snippet, prompt or note (`refFull`). It reads only.

**The view** (client/components/references-panel.js, references-edit.js and the pure references-words.js, mounted by
client/views/inspiration.js; styles at the end of client/inspiration.css under `.refs` and `.ref`; DESIGN.md section
13). The Inspiration view's switch has a third part, **References** with its count, at `#/inspiration/references`;
the router reads the first word of the address, so the tab stays current and a reload keeps the part. Each part
hides the others' controls, so one primary button is in sight (Add, Add rule, Add reference), and off the board its
paste, drop and eyedropper stand still.

- *The bar*: a search field and the tags in use with their counts (`All` first). The search redraws the list only,
  so typing keeps its place; Esc clears it; a live region says how many are left once typing stops. The search and
  the tag are kept per project for the window (not in the address). Nothing found says so with **Show all references**.
- *The list*: the entries by kind (Links, Snippets, Prompts, Notes), each kind under an overline with its count, in
  CSS columns of at least 440 px (two at 1280 px, three at 1920 px). An entry is never cut between two columns. It
  reads again on `project-switch`, on `references` for its project (150 ms of quiet) and after a reconnect; the echo
  of the window's own change redraws nothing, and a redraw gives the focus back to the entry that held it.
- *An entry*: a link's title is a real link (new tab, `noopener noreferrer`) with its site under it, and why when the
  page gave no title; a snippet's code is a `pre` in the mono that scrolls sideways and takes the focus (12 lines,
  then **Show all n lines**); a prompt's and a note's words wrap (8 lines, then **Show all**). Then `Use it for …`,
  and one muted line: a snippet's language and length, the tags, `from <source>`. Text is only ever set as text.
- *Actions*: **Copy** on a prompt and on a snippet, always in sight, writes the text to the clipboard and says so in a
  toast. Edit and Remove show on hover or focus; the entry takes the focus itself (Enter or a double click edits,
  Delete removes after one question, `Remove` / `Keep it`).
- *Add reference and Edit* are one dialog (`refDialog`). A new entry starts on a switch of the four kinds (Link
  first); the fields follow the kind and keep what was typed in the fields two kinds share: Address and Title for a
  link, Title, Language and Code (mono, unwrapped; the dialog is 720 wide) for a snippet, Title and the words for a
  prompt and a note; then Use it for, Tags (a comma separated field, with the project's tags in use as buttons that
  put one in or take it out) and Where it came from. An edit sends only what changed (`formPatch`); a link's title
  emptied on an edit sends `refetch: true`. A refusal stays in the dialog as the server's sentence, over the buttons
  and outside the part that scrolls, and the focus goes to the field it is about.

**The studio's own references** (server/lib/references-seed.mjs, scripts/seed-studio-references.mjs).
`STUDIO_REFERENCES` holds five entries taken from what this repository records, each with its source in `source`: the
two public documentation addresses the sources name (Claude Code authentication, the API pricing page), the
per-folder write queue as code, a note on the companion's tools (section 11) and the server conventions of CLAUDE.md.
`seedReferences` writes only into a list that holds nothing; the script was run once on this studio folder on
2026-11-13 (both titles were fetched) and the entries are the person's from then on. No other project is seeded.

**Checked by** tests/references.test.mjs (the store for each kind; every refusal with its sentence, writing nothing;
two writes at once; the title fetched from a server of the test with no request for its image; the words; the
matching rule case by case; the brief section in its place, capped, with none matching and with none kept; the
seeds against the files they name; the watcher; and through a real server process the routes, two projects kept
apart, the briefing, a new task's brief and the tool with a tag, a search and one entry) and
tests/references-view.test.mjs (the pure parts, the wiring of the part and its address, the design rules as source
checks). Seen in an offscreen Electron window with `scripts/ui-check/verify-references.cjs` on a throwaway server and
two throwaway projects on 2026-11-13, 41 checks: the switch and its address, the empty state, a private address and
a missing title refused in the dialog with the focus on their fields, a real link's title (`https://example.com/`,
"Example Domain"), a snippet in the mono, one Copy button on a prompt and what it copied, entries arriving from
outside the window, a long snippet opened and closed, the search by text, by title and tag together and with nothing
found, Esc, the tag filter, Edit by Enter, a paste that adds no card, Remove after Keep it, the same entries after a
real reload, the other project's own, the focus ring by a real key press, no overlap and no sideways scroll at
1280×720, 1920×1080 and 1000×700, and the light theme read from the captured picture
(docs/evidence/ui/uc/references-01 to -04). `scripts/ui-check/verify-rules.cjs` still holds 31 of 31 with the third part.

## 26. Visualizer

The design system a project really has, drawn from its real files beside the one the person wants (t_6kbrrw0jz1;
decision rows 168 to 173): the colours, the type, the spacing, the radii and the motion its stylesheets hold, next to
the inspiration board's colour cards (section 22) and the fixed rules (section 23). It is the fifth of the pieces the
public studio needs. It only reads: one GET route, no record of its own, nothing written to the project.

**Which files** (server/lib/visualizer.mjs `findSheets`). The stylesheets the project's web entry loads, read from
the entry's own HTML (`manifest.entry`): every `<link rel="stylesheet">` (not `alternate`, not `media="print"`) and
every `<style>` element in page order (`sheetsInHtml`; a comment hides what is inside it), then every `@import`
inside a sheet, at most 5 deep. Each file is read once however often it is named; at most 40 sheets of at most 1 MB
(the entry at most 2 MB). An address is resolved by `hrefCandidates`: relative to the file that names it; a path from
the site's root (`/styles.css`) first from the entry's own folder, which is the root the preview serves (the studio's
own page links its sheets that way), then from the project's. Every path goes through `insideProject()`. What is not
read is answered in `skipped` with why: `on another site; only files of the project are read` (a web font's sheet),
`outside the project`, `inside .git or .studio, which are not read`, `not found in the project`, larger than the
limit, more than 40. An entry that is no HTML page, or cannot be read, answers `entry: null` with `reason`. The Page
tab finds the files a page uses from the preview frame (section 13, decision row 106); this view has no frame, so it
follows the same files from the page's source instead. Not read: styles a script sets, `style` attributes, the
entry's sibling pages.

**The scanner** (server/lib/css-scan.mjs, pure, no dependency). `scanCss(text, { lineOffset })` walks the text once
and answers every declaration as `{ prop, value, line, selector, at, important }`: `line` is where the declaration
starts (plus the offset of a `<style>` element in its page), `selector` the nearest enclosing rule's (a keyframe's
`to` inside `@keyframes`, a nested rule's own), `at` the enclosing at-rules. Comments and strings are skipped as
such, and `;`, `{`, `}` inside parentheses belong to the value (a data URL). It reads what is written and does not
run the cascade: it cannot say which declaration wins on an element. The same module holds the value parts:
`splitTop` (cut outside parentheses and quotes), `resolveVars` (a `var()` replaced by what the property is set to,
else its fallback, at most 8 deep), `evalLength` (a `calc()`, `min()` or `max()` over px, rem and numbers worked out;
anything it cannot be sure of is null: a percentage, another unit, `clamp()`, `env()`), and the colours: `parseColor`
(a hex of 3, 4, 6 or 8 digits, `rgb()` and `hsl()` in both spellings, the 148 names, `transparent`), `canonColor`
(one spelling per colour: `#rrggbb`, or `rgba(r, g, b, a)` when it lets the surface through), `colorsIn` (the colours
written out in a value; nothing inside quotes or `url()`; a name only where the property takes a colour), and
`colorDistance` / `distanceToPalette` (OKLab distance times 100). `oklch()`, `lab()`, `color-mix()` and the like are
kept as written and drawn by the browser, but not converted, so they are not compared.

**The design** (server/lib/design-read.mjs `readDesign(sheets, { rules, boardColors })`, pure). Every value keeps its
places as `{ file, line, scope, prop }` (at most 40 listed; `count` is always whole) and a `home`: where its custom
property is set, else the first place it is written.

- *Custom properties*: every definition with its scope; the one outside any `@media`, `@supports` or `@container`
  (else the first) is the **base**, what holds where no condition does. A property is counted once for every `var()`
  that reads it.
- *Colours*: a custom property whose base value is one colour (also through another property) is a colour token with
  all its definitions; every other colour written out is a literal, counted by its one spelling, with `twin` when a
  token holds the same colour. Each has a `use`, the kind of property that holds it most: `surface` (background),
  `text`, `line` (border, outline), `effect` (shadow, fill, stroke, inside another custom property), or `unused` for
  a token no stylesheet reads.
- *Type*: the families (`font-family` and the tail of the `font` shorthand, also through a property that holds the
  whole shorthand; `@font-face` marks a family `webfont`), the sizes in px (rem times the root's px size, which is the
  `:root` or `html` font size when it is set in px, else 16; em, % and unworkable sums as written), and `base`, the
  family the root or the body sets, which the scale is drawn in.
- *Spacing*: every length of `margin`, `padding` and `gap` in all their forms; *radii*: every `border-radius`.
  A value read through a custom property names it (`tokens`), also when it is that property negated in a `calc()`.
- *Motion*: the durations of `transition` and `animation` (the first time of an item; the second is the delay and is
  not counted) and the easings, each with its curve as four numbers, or its steps.
- *Drift*, said gently in the view: `far` for a colour whose distance to every board colour, and to every blend of
  two of them, is over 8 (`FAR`; the alpha aside; with no colour card on the board nothing is far); `once` for a
  value written out in exactly one place and not through a custom property. A family is never a one-off, and a sum
  that could not be worked out is not judged.
- *Locks*: every rule that locks a token is checked against every definition of that property (`sameValue`: two
  spellings of one colour, or the same text but for case, spaces and the kind of quote; also after reading a
  `var()`). `matches`: every definition has the locked value. `varies`: the base has it and another definition (a
  theme, a media query) does not. `breaks`: the base does not. `missing`: no stylesheet read sets the property. The
  studio's own seed locks hold the dark theme's values (decision row 158), so three of them read `varies` with the
  light theme's value named; a test now holds that none of them breaks.
- *The board*: each colour card with the nearest colour the files hold (`exact` under 1, `close` up to 8, else
  `absent`).

`visualizerAnswer` reads the rules and the cards through their own modules, after parsing each file itself: a damaged
record is answered as `rulesError` / `boardError` (never read as none), and the copy the records' reader keeps beside
a damaged file is not made here, so this route writes nothing at all.

**The view** (client/components/visualizer-panel.js, visualizer-draw.js and the pure visualizer-words.js, mounted by
client/views/inspiration.js; styles in client/visualizer.css; DESIGN.md section 14). The Inspiration view's switch has
a fourth part, **Visualizer**, at `#/inspiration/visualizer`. It asks the route when it comes on screen, on a project
switch, when the window gets the focus, on **Read the stylesheets again**, and 150 ms after a `rules` or
`inspiration` event for its project; the server watches only `.studio`, so a hand edit of a stylesheet is found by
the focus or the button. The same answer redraws nothing. Every value has one `file:line` button, which opens the
Source tab there through `app.openSource` (section 15), and, when it stands in more than one place, a count button
that lists where it is set and read, each place a button into the Source tab. **Make it a task** builds a request
from the broken locks, the far colours and the one-offs, each with its place (`taskRequest`, 30 a list), shows it in
a dialog to read and edit, and on **Create task** sends it to `POST /api/projects/:id/tasks` (mode handle, the
stylesheets as its files, the Design department when the studio has one): the task is ready and handed to no one.
That task is the only thing the view can make. `atelier_studio_show` cannot open this part, and no MCP tool reads
the answer yet.

**Checked by** tests/visualizer.test.mjs (the scanner's lines through comments, strings, data URLs, nested rules and
a `<style>` offset; values and sums; colours and distance; the design from a fixture: tokens, literals, uses, drift,
type, spacing, radii, motion, the four lock states, the board; the sheets followed and refused; nothing written,
also beside a damaged record; the studio's own stylesheets with the seed locks; every template; and the route
through a real server process, with no version, task or changed file) and tests/visualizer-view.test.mjs (the words,
the task's request, the wiring of the part and its address, the design rules as source checks). Seen in an offscreen
Electron window with `scripts/ui-check/verify-visualizer.cjs` on a throwaway server on 2026-11-13, 43 checks, on two
throwaway projects: a copy of the studio's own page and five stylesheets with the studio's twelve seed rules and
three board colours, and a product from the notes template with four locks in the four states (docs/evidence/ui/uc/
visualizer-01 to -06). `verify-rules.cjs` still holds 31 of 31 and `verify-references.cjs --offline` 40 of 40 with
the fourth part.
