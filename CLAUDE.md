# clagentic-console — CLAUDE.md

Agent context for the clagentic-console repo. Read before writing any code or user-facing text.

## BRAND RULES — MANDATORY, NO EXCEPTIONS

- **Product name:** `Clagentic: Console` (capital C, colon, space, capital C)
- **CLI binary / repo identifier:** `clagentic-console`
- **npm package:** `@clagentic/console`
- **`clagentic` alone is NEVER correct** — not as a command, not as a product name, not in user-facing strings, not in help text, not in comments that will be read by users
- **Host identifiers this tool owns are scoped to the product.** `clagentic` is the shared family brand (router, relay, directory, gatekeeper, loadout, triage, lite, console, and the `clagentic` multiplexer). Everything console installs, names, reads or writes on a host uses `clagentic-console`, `CLAGENTIC_CONSOLE_*` and `~/.clagentic/console/`. Bare `CLAGENTIC_*` env vars (other than another product's own, e.g. `CLAGENTIC_LITE_HOME`, read for lite detection) and the bare `~/.clagentic/` root are the shared brand namespace and off-limits.
- The un-scoped env names console used to read (`CLAGENTIC_HOME`, `CLAGENTIC_CONFIG`, `CLAGENTIC_DEV`, `CLAGENTIC_DEBUG`, `CLAGENTIC_SELF_UPDATE`, `CLAGENTIC_MAX_CONCURRENT_SESSIONS`) are accepted for one release with a deprecation warning, only through `lib/env-compat.js`. New code reads `CLAGENTIC_CONSOLE_<NAME>`; a test fails on any new bare read.
- Legacy paths console still reads (documented per the naming standard): `~/.clagentic/` root files (copied into `console/`), `~/.clagentic-rc` and `~/.clayrc` (copied once to `console/recent-projects.json`), `~/clagentic-projects`, `~/clay-projects` and `/var/clagentic/projects` (used in place if present, never moved; see `lib/projects-dir.js`). Never move, rename or delete user project directories.

### Where this bites

`bin/cli.js` usage strings and status lines. Every place the product name or CLI command appears in user-visible output must use `clagentic-console` (command) or `Clagentic: Console` (product name). **Never `clagentic` alone.**

## Key paths

| Path | Purpose |
|---|---|
| `bin/cli.js` | CLI entry point + crash supervisor |
| `lib/daemon.js` | Long-running daemon process |
| `lib/relay*.js` | WebSocket relay layer |
| `lib/yoke/` | Vendor-agnostic agent adapter (YOKE) |
| `lib/public/` | Frontend assets |
| `~/.clagentic/console/daemon.sock` | Unix IPC socket |
| `deploy/clagentic-console.service` | systemd unit template; `scripts/postinstall.js` fills in the global bin path (`ExecStart=<bin> daemon`) |

## CLI Naming

This project follows the clagentic CLI Naming Standard:
clagentic-brand/docs/CLI-NAMING-STANDARD.md

Binary names, env vars, syslog identifiers, and config paths are governed by that doc.
Violations are a review blocker.

## CLI is the default for LLM calls

Any code in this repo that invokes Claude must use the `claude` CLI, not the Anthropic SDK. See workspace CLAUDE.md rule 17.

## Tests

Run before opening a PR: `npm test` from the repo root.
## Architecture reference

`docs/guides/architecture.md` — read this before making structural changes.
