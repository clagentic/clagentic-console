<p align="center">
<svg viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg" width="72" height="72">
  <defs>
    <linearGradient id="cg" gradientUnits="userSpaceOnUse" x1="36" y1="4" x2="36" y2="68">
      <stop offset="0%"   stop-color="#00CFFF"/>
      <stop offset="50%"  stop-color="#4A7FE8"/>
      <stop offset="100%" stop-color="#7B3FE4"/>
    </linearGradient>
  </defs>
  <path d="M 58.98 16.71 A 30 30 0 1 0 58.98 55.29"
        stroke="url(#cg)" stroke-width="5" stroke-linecap="round" fill="none"/>
  <circle cx="58.98" cy="16.71" r="2.8" fill="#00CFFF"/>
  <circle cx="58.98" cy="55.29" r="2.8" fill="#7B3FE4"/>
</svg>
</p>

<h2 align="center">CLAGENTIC:CONSOLE</h2>
<h4 align="center">AI tooling. Built for builders.</h4>

<p align="center">
  <a href="https://www.npmjs.com/package/@clagentic/console"><img src="https://img.shields.io/npm/v/@clagentic/console" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@clagentic/console"><img src="https://img.shields.io/npm/dw/@clagentic/console" alt="npm downloads" /></a>
  <a href="https://github.com/clagentic/clagentic-console/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://ko-fi.com/clagentic"><img src="https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white" alt="Support on Ko-fi" /></a>
</p>

A self-hosted browser console for Claude Code and Claude agents. Run sessions, talk directly to named agents, manage multiple projects, get push notifications on your phone — all from a single tab.

## What it does

- **Named agent sessions.** Talk directly to any agent defined in your Claude Code config. Agents get their own sessions, context, and conversation history. No synthetic scaffolding.
- **Multi-project dashboard.** Every repo on your machine in one sidebar. Jump between projects, run agents across several in parallel, see live status at a glance.
- **Mobile PWA + push notifications.** Installable on iOS and Android. Your phone buzzes when Claude needs approval or finishes a long task — tap to respond.
- **Loop automation.** Write a `PROMPT.md`, hit go. Clagentic:Console iterates: run, evaluate, retry until done or capped. Schedule with standard cron. Wake up to results.
- **One toggle between vendors.** The YOKE adapter speaks Claude Agent SDK and Codex app-server protocol natively. Switch per session.
- **Your data, your machine.** Sessions are JSONL, settings are JSON, knowledge is Markdown. No cloud relay, no proprietary database. Walk away and everything walks with you.

## Getting Started

**Requirements:** Node.js 20+. Authenticated Claude Code CLI, Codex CLI, or both.

```bash
npx @clagentic/console
```

On first run, you'll be asked for a port and whether you're running solo or multi-user. Open the URL from any device on your network.

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

Also available as `clagentic` or `clagentic-console` if installed globally.

## Architecture

Clagentic:Console is a self-hosted daemon. It drives Claude Code via the Claude Agent SDK and Codex via the `codex app-server` JSON-RPC protocol through a vendor-agnostic adapter layer (YOKE), and serves a multi-user web workspace over HTTP/WS. Sessions and settings live as plain JSONL/JSON/Markdown on disk.

```mermaid
graph LR
    subgraph Clients
      B1["Browser"]
      B2["Browser (multi-user)"]
      Phone["Phone PWA + Push"]
    end

    subgraph Daemon["Clagentic:Console Daemon (your machine)"]
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

## FAQ

**"Is this a Claude Code wrapper?"**
No. Clagentic:Console drives Claude Code through the Claude Agent SDK and Codex through the Codex app-server protocol. It adds multi-session orchestration, named agent sessions, scheduled agents, multi-user support, built-in MCP servers, and a full browser UI on top.

**"What are named agents?"**
Agents defined in your Claude Code config (`.claude/agents/`) become first-class sessions. You talk to them directly — they get their own conversation history, context window, and session state. No synthetic projects, no workarounds.

**"Can I run Claude Code and Codex in the same workspace?"**
Yes. Pick a vendor when you open a session. Switch per session. Same projects, same history.

**"Does my code leave my machine?"**
Only as model API calls — the same as using the CLI directly. Sessions, settings, and knowledge all stay on disk.

**"Does my existing CLAUDE.md / AGENTS.md work?"**
Yes. Native instruction files are loaded per vendor and merged automatically.

**"Can I continue a CLI session in the browser?"**
Yes. CLI sessions appear in the sidebar. Browser sessions can be picked up in the CLI.

**"Can I use it on my phone?"**
Yes. Install as a PWA on iOS or Android. Push notifications for approvals, errors, and task completion.

**"Does it work with MCP servers?"**
Yes. User-configured MCPs from `~/.clagentic/mcp.json` plus built-in ask-user and browser servers work in both Claude and Codex sessions.

**"What about multi-user teams?"**
Multi-user mode is supported. On Linux, opt in to OS-level isolation: each user maps to a real Linux account, file ACLs enforced via `setfacl`, processes spawn under the correct UID/GID.

## Philosophy

One idea: **user experience sovereignty**.

Not a grand statement. A simple wish: not to have your thinking, your work, and your data locked in the moment a vendor changes a price or rewrites a ToS.

That shows up in the technical choices:

- **Your machine is the server.** Browser → your daemon → model API. No vendor cloud, no relay, no middle tier.
- **One toggle between vendors.** YOKE speaks Claude Agent SDK and Codex app-server natively. Switching is a setting, not a migration.
- **Plain text on disk.** Sessions, settings, and knowledge live as JSONL and Markdown. No proprietary database. You can `cat`, `grep`, version, and back up everything.
- **Standard formats only.** CLAUDE.md, AGENTS.md, `.cursorrules`, MCP, Unix cron. Walk away and your data is already in formats every other tool understands.

## Support

If Clagentic:Console is useful to you: [ko-fi.com/clagentic](https://ko-fi.com/clagentic)

## Credits

Forked from [Clay](https://github.com/chadbyte/clay) by Chad, used under the MIT License.

## Disclaimer

Not affiliated with Anthropic or OpenAI. Claude is a trademark of Anthropic. Codex is a trademark of OpenAI. Provided "as is" without warranty. Users are responsible for complying with their AI provider's terms of service.

## License

MIT
