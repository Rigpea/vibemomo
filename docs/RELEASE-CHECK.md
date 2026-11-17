# Source release verification

Verified on 2026-11-17, using Windows 11, Node.js 26.13.0, and npm 11.20.0.

## Changes prepared for the public preview

- MIT license, copyright 2026 rigpea; repository links target `rigpea/vibemomo`.
- Reproducible quick start, contributor guide, bug/PR templates, and a sample workbench image.
- Windows GitHub Actions checks for Node.js 22 and 26, with read-only repository permissions.
- Local project records and personal studio data excluded from Git.
- `.env` loads before configuration is captured by the server, CLI, desktop app, and restart/check scripts.
- New/imported projects nested in another Git repository get their own repository root.
- The first project's workbench loads immediately after creation or import.
- CommonJS files are now included in the syntax checks.

## Evidence

- Clean `npm ci` completed successfully from the lockfile.
- `npm run check`: 6/6 checks passed; 313 module syntax checks, all three template
  self-checks, **894 tests passed**, and the isolated server's health check passed.
- Seven regression tests cover configuration loading, repository boundaries, and project selection.
- Browser verification at 1280 × 720: create the first project from Quick Notes, see its
  initial version and workbench immediately, and add a note in the working preview.
- Server and `npm run restart -- --status` honored the `.env` port and custom PID/data paths.
- Gitleaks 8.30.1 found no leaks in the original public Git history or the final public
  source snapshot. Ignored local tools and personal runtime files were excluded from the snapshot.
- `git diff --check` passed. Package and lockfile name, version, and license agree.
- `npm audit --omit=dev`: zero reported vulnerabilities. The full audit has 11 affected
  packages in the optional desktop build chain; see [known limitations](../CONTRIBUTING.md#known-limitations).

## Not verified

Live paid Claude/Codex calls, packaged executables, macOS/Linux, and Node.js 22 have not been
exercised in this local release pass. The GitHub Actions workflow is configured but needs a
hosted run. Fake CLI fixtures cover the automated integration tests. This scan and test pass
do not establish safety for opening untrusted project code.
