# Clagentic:Console Ecosystem

> Repositories, their roles, and how they connect.

---

## Project Registry

| Repo | Type | Description |
|------|------|-------------|
| **clagentic-console** | Core | Main server, daemon, webapp, SDK bridge, YOKE multi-vendor adapter |
| **clagentic-chrome** | Extension | Chrome/Arc extension for browser automation and MCP relay (lr-ead6: fork vs keep clay-chrome compatibility) |

---

## Architecture

```mermaid
graph TD
    subgraph console ["Clagentic:Console Daemon"]
        direction TB
        YOKE["YOKE Multi-Vendor\nClaude | Codex"]
        MCP_IN["Built-in MCP Servers\nask-user, browser"]
    end

    subgraph local_mcp ["Local MCP (same machine)"]
        MCP_LOCAL["mcp-local.js\nreads ~/.clagentic/mcp.json"]
        MCP_PROC_L["MCP Processes\nGitHub, Notion, etc."]
    end

    subgraph remote ["Remote MCP (different machine)"]
        WEBAPP["Browser / PWA"]
        EXT["Chrome Extension\nbrowser_* tools"]
        BRIDGE["clagentic-mcp-bridge\nNative Messaging Host"]
        MCP_PROC_R["MCP Processes\nGitHub, Notion, etc."]
    end

    console -- "WebSocket" --> WEBAPP
    console -- "stdio JSON-RPC" --> MCP_LOCAL
    MCP_LOCAL -- "stdin/stdout" --> MCP_PROC_L

    WEBAPP -- "postMessage" --> EXT
    EXT -- "Chrome Debugger API" --> BROWSER_TABS["Browser Tabs"]
    EXT -- "Native Messaging" --> BRIDGE
    BRIDGE -- "stdin/stdout" --> MCP_PROC_R
```

---

## Connection Paths

### Local user (same machine as daemon)

No extension or bridge needed. `mcp-local.js` reads `~/.clagentic/mcp.json` directly.

### Remote user (browser on different machine)

Requires Chrome extension + `clagentic-mcp-bridge` native host installed on the user's machine. See `native-host/install.sh`.

---

## Vendor Support (YOKE)

| Vendor | Adapter | MCP Support |
|--------|---------|-------------|
| Claude | `yoke/adapters/claude.js` | Full (in-process SDK MCP servers) |
| Codex | `yoke/adapters/codex.js` | Via stdio MCP bridge (see CODEX-INTEGRATION.md) |

---

## Key Config Files

| File | Purpose |
|------|---------|
| `~/.clagentic/mcp.json` | MCP server definitions (command, args, env) + include list |
| `~/.clagentic/daemon.json` | Project list, per-project settings |
| `~/.codex/config.toml` | Codex CLI configuration |
| `~/.claude/settings.json` | Claude Code settings |

---

## Cross-repo References

When modifying MCP message flow, these files must stay in sync:

| Message | clagentic-console (server) | chrome extension | mcp-bridge (host) |
|---------|---------------------------|------------------|-------------------|
| Tool call | `project-mcp.js` createToolHandler | `background.js` mcpRelayToolCall | `clagentic-mcp-host.js` relayToolCall |
| Tool result | `project-mcp.js` handleToolResult | `background.js` mcpHandleNativeMessage | `clagentic-mcp-host.js` handleMcpResponse |
| Server list | `project-mcp.js` handleServersAvailable | `background.js` broadcastMcpServers | `clagentic-mcp-host.js` getServers |

See [MCP-IMPLEMENTATION.md](./MCP-IMPLEMENTATION.md) for detailed message flow diagrams.
