# Module Map

> Where to put new code. Read this before adding features or message handlers.

---

## Architecture

`project.js` is a thin coordinator. It wires modules together and dispatches messages. All logic lives in dedicated modules following the `attachXxx(ctx)` pattern.

### Rules

1. **Never add inline logic to project.js handleMessage.** Find the right module and add it there.
2. **500 line limit per module.** If a module grows past 500 lines, split it.
3. **All new modules use the `attachXxx(ctx)` pattern.** Accept dependencies via ctx, return a public API object.
4. **Mutable state uses getters/setters in ctx.** Never capture a primitive that might change later.

---

## Server-side Modules (lib/)

### project.js (thin coordinator, ~1,200 lines)

Wires all modules, sets up session manager and SDK bridge, dispatches messages.

### Message Handler Modules

| Module | Message types | Concern |
|--------|--------------|---------|
| `project-knowledge.js` | `knowledge_list`, `knowledge_read`, `knowledge_save`, `knowledge_delete`, `knowledge_promote`, `knowledge_depromote` | Knowledge file CRUD |
| `project-sessions.js` | `new_session`, `switch_session`, `delete_session`, `rename_session`, `resume_session`, `fork_session`, `rewind_*`, `permission_response`, `elicitation_response`, `set_model`, `set_effort`, `set_thinking`, `set_betas`, `set_*_mode`, `browse_dir`, `add_project`, `create_project`, `clone_project`, `create_worktree`, `remove_project*`, `schedule_move`, `reorder_projects`, `set_project_title`, `set_project_icon`, `get_daemon_config`, `set_pin`, `set_keep_awake`, `set_auto_continue`, `set_image_retention`, `shutdown_server`, `restart_server`, `process_stats`, `stop`, `stop_task`, `kill_process`, `set_update_channel`, `check_update`, `update_now`, `ask_user_response`, `input_sync`, `cursor_*`, `text_select`, `push_subscribe`, `load_more_history`, `search_sessions`, `search_session_content`, `list_cli_sessions`, `set_session_visibility`, `transfer_project_owner`, `set_mate_dm` | Session lifecycle, config, project management, daemon settings, permissions, updates |
| `project-filesystem.js` | `fs_list`, `fs_read`, `fs_write`, `fs_watch`, `fs_unwatch`, `fs_file_history`, `fs_git_diff`, `fs_file_at`, `get_project_env`, `set_project_env`, `read_global_claude_md`, `write_global_claude_md`, `get_shared_env`, `set_shared_env` | File browser, file history, project env/settings |
| `project-user-message.js` | `message`, `note_*`, `term_*`, `context_sources_save`, `browser_tab_list`, `extension_result`, `loop_*` (delegation), `schedule_*`, `send_scheduled_now`, `cancel_scheduled_message` | User message dispatch, sticky notes, terminals, context sources, browser extension |
| `project-loop.js` | `loop_start`, `loop_stop`, `ralph_wizard_complete`, `ralph_wizard_cancel`, `ralph_cancel_crafting`, `ralph_preview_files`, `loop_registry_*`, `schedule_create`, `hub_schedules_list`, `delete_loop_group` | Loop/Ralph engine, loop registry, scheduling |
| `project-notifications.js` | `notification_mark_read`, `notification_mark_all_read`, `notification_delete`, `notification_clear_all` | Notification center persistence and CRUD |
| `project-user-mention.js` | (called from project.js) `user_mention` | User-to-user @mention side conversations within a session. Records to history, broadcasts to other session viewers, fires notification + push for the target user (push only when offline) |
| `project-memory.js` | `memory_list`, `memory_search`, `memory_delete` | Session digest memory |
| `project-mcp.js` | `mcp_servers_available`, `mcp_tool_result`, `mcp_tool_error`, `mcp_toggle_server` | Remote MCP server bridge via Chrome Extension |

### Infrastructure Modules

| Module | Concern |
|--------|---------|
| `project-connection.js` | WebSocket connection setup, initial state sync, session restore, presence |
| `project-http.js` | All HTTP routes: image serving, file upload, push, skills, git status, info |
| `project-image.js` | `hydrateImageRefs`, `saveImageFile`, image directory setup |
| `project-file-watch.js` | File and directory fs.watch wrappers |
| `sdk-bridge.js` | SDK bridge coordinator: createSDKBridge factory, worker lifecycle, query stream, tool permissions, mention sessions |
| `sdk-skill-discovery.js` | Skill directory scanning, shell segment splitting, SDK/filesystem skill merging |
| `sdk-message-queue.js` | Async iterable message queue for streaming input to SDK |
| `sdk-message-processor.js` | SDK stream event processing (message_start, content_block_*), sub-agent message routing |
| `codex-defaults.js` | Codex-specific default values (sandbox, approval, web search). **Single source of truth** - do not duplicate elsewhere |
| `users.js` | User CRUD, invites, profile/PIN update, storage, Linux user integration |
| `users-auth.js` | Authentication, PIN hashing, auth tokens, multi-user mode, setup codes |
| `users-permissions.js` | RBAC permissions, project/session access control |
| `users-preferences.js` | DM favorites/hidden, auto-continue, chat layout, user preferences |
| `daemon-projects.js` | Worktree tracking (scan, rescan, cleanup), removed project filtering |
| `ws-schema.js` | WebSocket message type registry (328 message types, informational) |
| `server-hub-sessions.js` | `computeAllProjectSessions` — pure cross-project session gather + per-user access filter for the Home Hub recent-sessions list, extracted from `lib/server.js`'s `getAllProjectSessions` for direct unit testability |
| `server-hub-sessions.js` | `computeAllProjectSessions` — pure cross-project session gather + per-user access filter for the Home Hub recent-sessions list, extracted from `lib/server.js`'s `getAllProjectSessions` for direct unit testability |



> **Note:** `mapSessionForClient` in `lib/sessions.js` is the canonical mapper for `session_list` payloads. All session list builders must use this function — do not inline-build session wire objects.
### YOKE Adapters (lib/yoke/)

YOKE is the vendor-agnostic interface layer. Each adapter implements the same contract (init, createQuery, etc.) for a specific agent runtime.

| Module | Concern |
|--------|---------|
| `yoke/index.js` | Adapter factory, wraps createQuery with project instructions |
| `yoke/interface.js` | YOKE interface contract definition |
| `yoke/adapters/claude.js` | Claude adapter using `@anthropic-ai/claude-agent-sdk`. In-process + worker (OS user isolation) paths |
| `yoke/adapters/codex.js` | Codex adapter using `codex app-server` JSON-RPC protocol. Handles approval events, skill injection, MCP bridge config |
| `yoke/codex-app-server.js` | Codex `app-server` child process manager. JSON-RPC 2.0 over stdin/stdout, request ID tracking, event routing |
| `yoke/mcp-bridge-server.js` | Stdio MCP server spawned by Codex. Proxies tool list/call to the daemon via HTTP at `/api/mcp-bridge` |

**When adding a new vendor**: implement the YOKE interface, register in `yoke/index.js` createAdapter switch. Do not add vendor-specific logic outside the adapter.

**For Codex-specific patterns and gotchas**: see [CODEX-INTEGRATION.md](./CODEX-INTEGRATION.md).

### Server Modules (lib/server-*.js)

server.js is a thin router. It wires all server modules, sets up HTTP/WS, and dispatches requests.

| Module | Routes | Concern |
|--------|--------|---------|
| `server-auth.js` | `/auth`, `/auth/setup`, `/auth/login`, `/auth/request-otp`, `/auth/verify-otp`, `/auth/register`, `/auth/logout`, `/invite/*`, `/recover/*` | PIN auth, multi-user login, OTP, invite registration, admin recovery, rate limiting |
| `server-admin.js` | `/api/admin/users*`, `/api/admin/invites*`, `/api/admin/smtp*`, `/api/admin/projects/*/visibility`, `/api/admin/projects/*/owner`, `/api/admin/projects/*/users`, `/api/admin/projects/*/access` | User CRUD, permissions, invites, SMTP config, project access control |
| `server-skills.js` | `/api/skills`, `/api/skills/search`, `/api/skills/detail` | Skills proxy cache, leaderboard, search, detail page scraping |
| `server-settings.js` | `/api/profile`, `/api/avatar/*`, `/api/user/pin`, `/api/user/auto-continue`, `/api/user/chat-layout` | User profile, avatars, user preferences |
| `server-palette.js` | `/api/palette/search` | Cross-project session search (recent + BM25 ranked) |
| `server-dm.js` | WS: `dm_list`, `dm_open`, `dm_typing`, `dm_send`, `dm_add_favorite`, `dm_remove_favorite` | Cross-project DM messaging, typing indicators, push notifications |

### Where to add a new server HTTP endpoint

1. Identify which concern it belongs to (auth? admin? skills? settings?)
2. Add the handler in the matching module's `handleRequest` function
3. If no module fits, add it directly in `server.js` appHandler or create a new `server-*.js` module

### Where to add a new message type

1. Identify which concern it belongs to (session mgmt? filesystem? loop? etc.)
2. Add the handler in the matching module's `handleXxxMessage` function
3. If no module fits, create a new one following the `attachXxx(ctx)` pattern
4. Wire it in project.js with a single `if (module.handleXxxMessage(ws, msg)) return;` line

### Where to add a new HTTP endpoint

Add it in `project-http.js` inside the `handleHTTP` function.

---

## Client-side Modules (lib/public/modules/)

### app.js (bootstrap coordinator, ~1,100 lines)

Bootstraps UI, initializes store, wires remaining Tier 3 modules. All business logic lives in modules. See [NO-GOD-OBJECTS.md](./NO-GOD-OBJECTS.md) for architectural principles.

| Module | Concern |
|--------|---------|
| `app-connection.js` | WebSocket creation, reconnect with exponential backoff, connection status UI, disconnect/restore notifications |
| `app-messages.js` | WebSocket message router: a handler registry (`registerHandlers({ type: fn })` populated by this file's own core registration plus domain modules that self-register — e.g. filebrowser.js, server-settings.js). `processMessage(type)` dispatches to every registered handler for that type, in registration order |
| `app-history-replay.js` | `history_meta` / `history_done` handlers: sticky-bottom scroll arming across a full history replay batch, batched syntax highlight/mermaid pass, context/usage panel restore from the last result in history |
| `app-dm.js` | DM mode (open/enter/exit), DM message rendering, typing indicators |
| `app-home-hub.js` | Home hub rendering, weather, tip rotation, upcoming schedules, project summary |
| `app-rate-limit.js` | Rate limit UI, countdown timers, scheduled message bubbles, fast mode indicator |
| `app-cursors.js` | Remote cursor presence, text selection sharing, cursor toggle UI |
| `app-rendering.js` | Message rendering, streaming, scroll management, pre-thinking dots, suggestion chips, system messages |
| `app-projects.js` | Project list, switching, add/remove project modals, update available pill, topbar presence |
| `app-panels.js` | Config chip (model/mode/effort/thinking/beta), usage panel, status panel, context panel, context popover |
| `app-loop-ui.js` | Ralph Loop UI: bars, banners, preview modal, execution modal |
| `app-loop-wizard.js` | Ralph Loop wizard: step navigation, mode/authorship selection, data collection |
| `app-notifications.js` | Notification center panel, badge, rendering, click-to-navigate |
| `app-skills-install.js` | Skill install dialog, requireSkills |
| `app-favicon.js` | Dynamic favicon, IO blink, urgent blink, send button mode, activity indicator |
| `app-header.js` | Session rename, session info popover, progressive history loading |
| `app-misc.js` | Image/paste/confirm modals, force PIN overlay, PWA install, Chrome extension bridge |
| `sidebar.js` | Sidebar coordinator: init, open/close, page title, panel switching, collapse/expand, resize handle, dust particles |
| `sidebar-sessions.js` | Session list rendering, search/filter, loop groups, inline rename, context menus, presence avatars, countdown timers, CLI session picker, unread badges |
| `sidebar-projects.js` | Project icon strip, context menus, emoji picker, drag-and-drop reorder, worktree modal, project access popover, project rename, project badges |
| `sidebar-mates.js` | User icon strip, DM picker, user context menus, icon strip tooltips, sidebar presence, DM badges, user state |
| `sidebar-mobile.js` | Mobile sheet overlays (projects, sessions, mate profile, search, tools, settings), mobile tab bar, drag-to-dismiss, mobile loop groups, mobile session rendering |
| `scheduler.js` | Scheduler coordinator: init, open/close, calendar views (month/week), detail view, crafting mode, sidebar task list, cron utilities |
| `scheduler-config.js` | Schedule create/edit modal, delete dialog, cron builder, recurrence/interval UI, calendar date picker, preview events |
| `scheduler-history.js` | Run history rendering, schedule event message handlers (registry updates, run started/finished, loop scheduled) |

---

## Client Module Architecture

**Three-layer callback registration pattern:** The client uses a three-layer system for wiring module behavior:
1. The module exports an `init(ctx)` function that receives a context object.
2. The context object carries callbacks and DOM refs injected by the caller (app.js or a parent module).
3. The module binds event listeners only once during init using these callbacks — never re-binding on each render.

This avoids listener accumulation on re-renders and keeps modules stateless between session switches. When adding a new module, follow this pattern rather than using globals or re-binding on each update.

---

## Extraction Pattern Reference


```js
// lib/project-example.js
var fs = require("fs");

function attachExample(ctx) {
  var cwd = ctx.cwd;
  var send = ctx.send;

  // Module-private state
  var counter = 0;

  function handleExampleMessage(ws, msg) {
    if (msg.type === "example_increment") {
      counter++;
      send({ type: "example_count", count: counter });
      return true;
    }
    return false; // not handled
  }

  return {
    handleExampleMessage: handleExampleMessage,
  };
}

module.exports = { attachExample: attachExample };
```

---

## See Also

- [STATE_CONVENTIONS.md](./STATE_CONVENTIONS.md) for state management rules
- [CLIENT_MODULE_DEPS.md](./CLIENT_MODULE_DEPS.md) for client-side dependency rules (store.js, ws-ref.js, direct imports)
- [NO-GOD-OBJECTS.md](./NO-GOD-OBJECTS.md) for architectural principles (why and how we keep modules small)
- [MCP-IMPLEMENTATION.md](./MCP-IMPLEMENTATION.md) for MCP server architecture (local + extension-bridged)
- [CODEX-INTEGRATION.md](./CODEX-INTEGRATION.md) for Codex-specific patterns, gotchas, and testing checklist
- [REFACTORING_ROADMAP.md](../roadmaps/completed/REFACTORING_ROADMAP.md) for decomposition history
