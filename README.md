<p align="center">
  <img src="media/logo/console-lockup-256.png" alt="Clagentic: Console" width="260" />
</p>

<h4 align="center">A shared workspace for humans and AI agents.</h4>

<p align="center">
  <a href="https://clagentic.ai"><img src="https://img.shields.io/badge/-clagentic.ai-00CFFF?style=flat&logoColor=white" alt="clagentic.ai" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat" alt="License: MIT" /></a>
  <a href="https://github.com/clagentic/clagentic-console/actions/workflows/pr-checks.yml"><img src="https://github.com/clagentic/clagentic-console/actions/workflows/pr-checks.yml/badge.svg?branch=main" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js 20+" />
  <a href="https://www.npmjs.com/package/@clagentic/console"><img src="https://img.shields.io/npm/v/@clagentic/console?style=flat&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@clagentic/console"><img src="https://img.shields.io/npm/dw/@clagentic/console?style=flat&label=downloads" alt="npm downloads" /></a>
  <a href="https://ko-fi.com/clagentic"><img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=flat&logo=ko-fi&logoColor=white&label=support" alt="Support on Ko-fi" /></a>
</p>

Clagentic: Console is a self-hosted team workspace where human developers and named AI agents share the same interface. Multiple users connect to a single daemon, each with their own account and project access. Agents are first-class participants — not background processes you poll, but named entities with their own conversation history, context window, and session state, visible to the whole team. Every project, every session, every tool approval lives on your machine and stays there.

## Install

```bash
npm install -g @clagentic/console
```

Then start the daemon:

```bash
clagentic-console
```

Or try without installing:

```bash
npx @clagentic/console
```

**Requirements:** Node.js 20+. Authenticated Claude Code CLI, Codex CLI, or both.

### Postinstall / systemd

On Linux, a global npm install runs a postinstall script that registers and enables a `clagentic-console.service` systemd unit. The script never restarts an already-running daemon — active sessions are not interrupted. Self-updates triggered from inside the app skip the restart entirely and let systemd's `Restart=always` handle the handoff after graceful shutdown.

To skip the postinstall script:

```bash
npm install -g @clagentic/console --ignore-scripts
```

## What it does

- **Real team accounts.** Every team member gets their own login. Multiple users connect to the same Console daemon simultaneously — each with their own session history, project access, and tool approval flow. No shared credentials, no per-user installs.

- **Agents as first-class participants.** Named agents defined in `.claude/agents/` or `~/.claude/agents/` are not background scripts — they're full participants. Each runs in its own session with its own conversation history, context window, and state. Team members can favorite agents, DM them directly, and see which agents are active. Type `@` in the session input to launch one by name.

- **Team panel.** A dedicated Team surface lists every human user and named agent connected to the Console. Direct-message any participant, see who's online, and manage the agent roster — all from the same sidebar that shows your projects.

- **Vendor-agnostic via YOKE.** The YOKE adapter layer treats Claude Code (Claude Agent SDK), ChatGPT Codex (codex app-server JSON-RPC), and future local models as interchangeable backends. Switch vendors per session; sessions remember their choice. YOKE also cross-injects instruction files — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `COPILOT.md`, `.github/copilot-instructions.md` — so project context reaches whichever model is running.

- **Multi-project dashboard.** Every repo registered with the daemon in one sidebar. Jump between projects, run sessions in parallel, see live status at a glance.

- **Context injection.** Pin running terminals, live browser tabs, and sticky notes as active context sources. Their content flows into every message automatically: terminal output as a delta since your last message, browser tabs as full snapshots. No manual copy-paste. No extra prompting.

- **Loop automation.** Write a `PROMPT.md`, start a loop. Clagentic: Console runs the prompt, evaluates the result, and retries until done or capped. Schedule loops with standard cron syntax to run unattended.

- **External triggers.** Drop a JSON file into `~/.clagentic/console/external-triggers/` to spawn a new AI session or inject a message into an existing one. Use this to wire agents into scripts, CI pipelines, or other AI processes — no API, no polling, just a file drop.

- **Mobile PWA + push notifications.** Installable on iOS and Android. Approve tool calls from your phone. Push fires on approval requests, errors, and task completion.

- **OS-level isolation (Linux).** On Linux, opt in: each user maps to a real system account, file ACLs via `setfacl`, processes spawn under the correct UID/GID.

- **MCP servers.** Built-in ask-user and browser servers. User-configured MCPs via `~/.clagentic/mcp.json`. Works in both Claude and Codex sessions.

- **Your data, your machine.** Sessions are JSONL, settings are JSON, knowledge is Markdown. No cloud relay, no proprietary database.

- **Clagentic: Lite (optional).** If [Clagentic: Lite](https://clagentic.ai/tools) is installed, project settings surface per-project enrollment controls and system settings add a global auto-enroll toggle. Console detects it passively — nothing changes if it isn't present.

## Getting Started

On first run you'll be asked for a port and prompted to create your admin account. Open the URL from any device on your network — team members can log in with their own accounts from their own machines.

Enable multi-user mode in System Settings to activate OS-level isolation (Linux) and the team-management panel. Additional accounts are created from the admin UI or CLI; each user gets independent session history and project access.

For remote access, use a tunnel — Tailscale, Cloudflare Tunnel, or your existing VPN.

## CLI Options

```bash
npx @clagentic/console              # Default (port 2633)
npx @clagentic/console -p 8080      # Specify port
npx @clagentic/console --yes        # Skip prompts, use defaults
npx @clagentic/console -y --pin 123456
npx @clagentic/console --add .      # Add current directory to running daemon
npx @clagentic/console --remove .   # Remove project
npx @clagentic/console --list       # List registered projects
npx @clagentic/console --shutdown   # Stop daemon
npx @clagentic/console --dangerously-skip-permissions
```

Also available as `clagentic-console` if installed globally.

## Architecture

Clagentic: Console is a self-hosted daemon. It drives Claude Code via the Claude Agent SDK and Codex via the `codex app-server` JSON-RPC protocol through a vendor-agnostic adapter layer (YOKE), and serves a multi-user web workspace over HTTP/WS. Sessions and settings live as plain JSONL/JSON/Markdown on disk.

```mermaid
graph LR
    subgraph Clients
      B1["Browser"]
      B2["Browser (multi-user)"]
      Phone["Phone PWA + Push"]
    end

    subgraph Daemon["Clagentic: Console Daemon (your machine)"]
      Auth["Auth + RBAC"]
      Server["HTTP / WS Server"]
      Project["Project Context"]
      YOKE["YOKE Adapter Layer"]
      MCP["Built-in MCP servers\nask-user / browser"]
      Push["Push (VAPID)"]
    end

    subgraph Vendors["Agent runtimes"]
      Claude["Claude Agent SDK"]
      Codex["codex app-server\n(JSON-RPC stdio)"]
    end

    B1 <-->|WS| Server
    B2 <-->|WS| Server
    Phone <-->|WS + push| Server
    Server --> Auth
    Server --> Project
    Project --> YOKE
    Project --> MCP
    Project --> Push
    YOKE --> Claude
    YOKE --> Codex
    Push -.-> Phone
```

For architecture details, sequence diagrams, and key design decisions, see [docs/guides/architecture.md](docs/guides/architecture.md).

## Security

These are implementation-level properties, not configuration options — they apply to every installation.

- **Token TTL.** Multi-user auth tokens expire after 30 days (`TOKEN_TTL_MS`). Tokens issued before TTL support was added are migrated on first use to a fresh 30-day window, avoiding forced logouts on upgrade.

- **Atomic writes, mode 0o600.** All config and state files (`users.json`, `auth-tokens.json`, and similar) are written via rename-after-write: data goes to a `.tmp.<pid>` path, then `rename()` atomically replaces the target. After rename, `chmod 0o600` is applied. Concurrent writes to the same file are serialized in call order.

- **Append-only audit log.** Privileged actions — user creation, lockouts, token revocation, multi-user enable/disable — are written as newline-delimited JSON to `~/.clagentic/console/audit.log` (mode 0o600, opened with `O_APPEND`).

- **Progressive lockout.** Failed login attempts trigger escalating per-username backoff: 1s, 5s, 30s, 5 min. Reaching the threshold results in permanent lockout until an admin explicitly unlocks the account. Per-IP rate limiting runs in parallel.

- **OS-level isolation (Linux, multi-user mode).** Each app user maps to a real system account. File ACLs are set via `setfacl`; processes spawn under the correct UID/GID.

## Testing

The test suite covers 12 areas across 26 test files:

- **Boot / smoke** — daemon startup, config bootstrap, guard checks
- **Security gates** — auth token TTL, lockout thresholds, PIN rate limiting, audit log entries
- **WebSocket permission gates** — per-user RBAC enforcement on WS message types
- **Session lifecycle** — session open, resume, shutdown, and reaper behavior
- **External triggers** — v1 and v2 trigger processing, file archival, restart survival
- **Scheduler** — cron parsing, loop execution, run accounting
- **Store atomicity** — concurrent write serialization, atomic rename, 0o600 mode
- **XSS escaping** — output sanitization for user-controlled strings rendered in HTML
- **YOKE robustness** — vendor adapter error handling and fallback paths
- **SDK bridge** — slot counter, message processor, slash command enrichment, workflow and skill discovery, worker shutdown
- **Replay** — session replay correctness
- **ESM import check** — verifies the package is importable as an ES module

Run the suite: `npm test`

## FAQ

**"Is this a Claude Code wrapper?"**
No. Clagentic: Console drives Claude Code through the Claude Agent SDK and Codex through the Codex app-server protocol. It adds multi-session orchestration, named agent sessions, scheduled agents, multi-user support, built-in MCP servers, context injection, external triggers, and a full browser UI on top.

**"What are named agents?"**
Agents defined in your Claude Code config (`.claude/agents/` or `~/.claude/agents/`) are first-class team participants. Type `@` in the session input to see every installed agent and launch one directly — its own conversation history, context window, and session state. Team members can favorite agents and DM them from the Team panel alongside human users.

Named agents are **currently Claude Code only.** The Codex adapter has no equivalent API for per-session agent identity injection. When you're in a Codex session, the agent entry point is hidden. Partial Codex parity (system-prompt prepend) is planned.

**"How does context injection work?"**
Open the Context panel in the session input area. Pin a running terminal, a browser tab (requires the Clagentic: Console Chrome extension), or a sticky note. From that point on, every message you send automatically includes the latest content from those sources — terminal output as a delta since the last message, browser tabs as a full page snapshot. The injection happens before your message reaches the model; you don't need to mention the sources in your prompt.

**"What's the external trigger system?"**
Drop a JSON file into `~/.clagentic/console/external-triggers/`. The daemon picks it up within seconds. A v1 trigger spawns a new session with an `initialPrompt`. A v2 trigger can either spawn a session or inject a message into an existing session by `sessionId`. The file is archived to `processed/` on success. Unprocessed files survive daemon restarts. Use this to wire Claude into scripts, CI pipelines, cron jobs, or other AI processes.

**"What instruction files does it read?"**
YOKE scans the project directory for `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `COPILOT.md`, and `.github/copilot-instructions.md`. Each vendor reads some of these natively — Claude reads `CLAUDE.md`, Codex reads `AGENTS.md`. Files the active vendor doesn't read natively are merged and injected as additional context, so your project instructions reach the model regardless of which vendor is running.

**"Is feature parity between Claude Code and Codex complete?"**
Not yet. Named agents are the main gap — the Claude Agent SDK exposes agent identity injection directly; Codex does not. Claude Code has been the primary development target. Codex support covers sessions, tool approvals, model selection, MCP servers, loop, and most UI surfaces. Features that depend on Claude Agent SDK internals have no Codex equivalent today.

**"Can I run Claude Code and Codex in the same workspace?"**
Yes. Pick a vendor when you open a session. Switch per session — sessions remember their vendor.

**"Does my code leave my machine?"**
Only as model API calls — the same as using the CLI directly. Sessions, settings, and knowledge all stay on disk.

**"Does my existing CLAUDE.md / AGENTS.md work?"**
Yes. Native instruction files are loaded per vendor and merged automatically. Non-native files are cross-injected by YOKE.

**"Can I continue a CLI session in the browser?"**
Yes. CLI sessions appear in the sidebar and can be picked up in the CLI.

**"Can I use it on my phone?"**
Yes. Install as a PWA on iOS or Android. Push notifications for approvals, errors, and task completion.

**"Does it work with MCP servers?"**
Yes. User-configured MCPs from `~/.clagentic/console/mcp.json` plus built-in ask-user and browser servers work in both Claude and Codex sessions.

**"Multi-user support?"**
Yes — it is a core design goal, not an add-on. Real accounts, independent session history, and a Team panel that shows every human user and agent connected to the Console. On Linux, enable OS-level isolation: each user maps to a real Linux account, file ACLs via `setfacl`, processes spawn under the correct UID/GID.

**"Does it integrate with Clagentic: Lite?"**
Yes, optionally. [Clagentic: Lite](https://clagentic.ai/tools) adds agentic gates, session memory, and audit trails to any repo. If Lite is installed (`~/.clagentic/lite/`), Console detects it automatically and shows an enrollment panel in each project's settings. Enable auto-enroll in system settings to wire up every project on add. Lite is never required — Console works normally without it.

## Support

If Clagentic: Console is useful to you: [ko-fi.com/clagentic](https://ko-fi.com/clagentic)

## Credits

Forked from [Clay](https://github.com/chadbyte/clay) by Chad, used under the MIT License.

## Disclaimer

Not affiliated with Anthropic or OpenAI. Claude is a trademark of Anthropic. Codex is a trademark of OpenAI. Provided "as is" without warranty. Users are responsible for complying with their AI provider's terms of service.

## License

[MIT](LICENSE)
