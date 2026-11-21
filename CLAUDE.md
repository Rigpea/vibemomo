# Atelier — studio source (Claude Code notes)

This repo is the studio itself. It is published as vibemomo; the code and the screen still say
Atelier. Products live beside it as their own folders. Read `docs/ARCHITECTURE.md` (contracts)
and `docs/DESIGN.md` (the look) before changing anything; `docs/GUIDE.md` walks through every
screen.

## Commands

```
npm start          # server on http://127.0.0.1:4747 (.local/server.pid holds the PID)
npm run check      # syntax + template self-checks + tests + server health
npm test           # node --test --test-reporter=spec "tests/*.test.mjs"
npm run evidence   # which models ran in your own Claude Code sessions -> docs/evidence/model-participation.json
node bin/atelier.mjs --help
```

`npm run evidence` reads the Claude Code transcripts of this machine and its output names their
folder, so `.gitignore` keeps that file out of git. Leave it that way.

Restart only the studio's own process: `npm run restart` (it stops the server only after
`/api/health` names the pid, that pid is the port listener and the process is node;
`npm run restart -- --status` prints the verdict, `-- --stop` only stops). Never kill every
node process on the machine, and never kill a pid from `.local/server.pid` without that check:
a pid written under WSL means nothing on Windows.

## Conventions

- Plain ES modules, no bundler, no framework, no new dependency without writing down why.
- Server: every project file access goes through `insideProject()`; records are
  written atomically; status is derived from evidence (events, git), never set by a claim.
- Client: design tokens in `client/styles.css`; components in `client/components/`;
  one file per view in `client/views/`; keep files under ~500 lines; motion <= 160 ms.
- Extension points: `workbenches/<kind>/{server.mjs,panel.js}` (see `workbenches/README.md`),
  `server/api-utility/tasks.mjs` (bounded utility tasks), `templates/<name>/` (project templates).
- Tests are focused on concrete risks (`tests/`); add one when you fix a real bug.
- Studio versions are git tags `studio/vX.Y.Z`; product versions live in each project.
- Secrets: `STUDIO_ANTHROPIC_API_KEY` (env or `~/.atelier/secrets.json`). Subscription sign-ins belong to the
  Claude Code and Codex CLIs (Settings › Connected accounts); an older install's `CLAUDE_CODE_OAUTH_TOKEN` in
  secrets.json is ignored and only removable. Never log, return or commit any of them.

## Studio tasks

When the studio is registered as a project of its own, task briefs appear under
`.studio/tasks/<id>/brief.md` here, and the studio writes `.studio/BRIEFING.md`, which the
last line of this file imports. Neither exists before that (`.studio/` is ignored by git), and
the line is already here so a registered studio leaves this tracked file unchanged.
Report with `node bin/atelier.mjs task start|note|question|finish <id>`.
A studio task that changes behavior must: pass `npm run check`, be inspected in
the browser, and name the check in `task finish --verification`.

## What this copy leaves out

This is a clean copy of a private working repository. Its working records stayed behind: the
decision log (`docs/DECISIONS.md`), the plan (`docs/PLAN.md`), the build's running record
(`docs/CONTINUATION.md`), the verification records and screenshots (`docs/evidence/`) and a
concept image (`docs/design/inspiration/`). Comments and docs still cite them, most often as
"decision row N". Those citations cannot be followed here: go by the comment itself and by
`docs/ARCHITECTURE.md`, and do not go looking for the files. When you change course, write the
choice and its reason where the next reader will find it; a decision log of your own would start
empty.

<!-- Atelier -->
@.studio/BRIEFING.md
