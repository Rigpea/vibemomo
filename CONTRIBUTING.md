# Contributing to vibeMomo

vibeMomo is an early developer preview of the Atelier studio. Useful contributions include
reproducible bug reports, clearer setup instructions, and small improvements to the build,
preview, and version workflow. Open an issue before starting a large feature so we can agree
on the problem and scope.

## Local setup

Install Node.js 22 or later and Git. Claude Code is needed for real AI sessions, but the
automated tests use fake CLI fixtures and do not need an API key or account.

```sh
git clone https://github.com/rigpea/vibemomo.git
cd vibemomo
npm ci
npm run check
npm start
```

Open http://127.0.0.1:4747. Windows is the initial supported development platform; macOS and
Linux have code paths but have not been verified. Keep platform limitations explicit in reports.

The native terminal dependency is `node-pty`. If your npm version reports blocked install
scripts, inspect them with `npm install-scripts ls` and, on versions supporting that command,
approve the package with `npm install-scripts approve node-pty`, then run `npm ci` again.
On platforms without a matching prebuilt binary, its fallback build needs Python and the
platform's C++ build tools. Electron is installed for the optional desktop app.

For experiments, copy `.env.example` to `.env` and point `ATELIER_DATA_DIR` and
`ATELIER_PROJECTS_DIR` at dedicated development folders. `.env`, `.local`, `.studio`, and
`.atelier` directories are ignored. Tests create temporary data and repositories.

## Make a focused change

- Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts and [DESIGN.md](docs/DESIGN.md)
  before changing the interface. [GUIDE.md](docs/GUIDE.md) explains the user journey.
- Use plain ES modules. Explain why a new dependency is needed.
- Keep project file access behind `insideProject()` and use the existing atomic file stores.
- Derive status from files, events, and Git rather than optimistic labels.
- Never log, return, or commit credentials. Keep personal runtime records out of pull requests.
- Add a regression test for a concrete behavior bug. For interface changes, try the affected
  workflow in a browser and include a screenshot with sample data.

Some comments cite decision rows from the private development history. Those records were
intentionally omitted; the surrounding explanation and architecture document are the public
contract. Put new decisions and their reasons beside the relevant code or documentation.

## Before a pull request

Run `npm run check`: module syntax, template self-checks, automated tests, and an optional
health check of a running studio. Use `npm test` for the tests alone. The `scripts/ui-check/`
tools are manual Electron checks; read a script before running it because some create or
change projects on the server they target. Use a separate development data directory.

Describe the problem, the resulting behavior, and what you verified. Mention any remaining
limits, skipped tests, and platforms you tried. Keep discussions respectful and focused on
the work. Contributions are offered under the repository's [MIT license](LICENSE).

## Known limitations

On 2026-11-17, `npm audit --omit=dev` reported no known runtime dependency vulnerabilities.
The full audit reported 11 affected packages (6 high, 5 moderate) in the optional
`electron-builder` dependency chain, including glob-matching denial-of-service advisories
in [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249) and
[picomatch](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

The suggested automated fix was a major downgrade of `electron-builder`; it has not been
applied or validated. Re-run `npm audit` when changing packaging dependencies. A source
checkout and browser session have been verified; packaged executables and macOS/Linux
support have not. This is an early preview, not a hardened sandbox for untrusted projects.
