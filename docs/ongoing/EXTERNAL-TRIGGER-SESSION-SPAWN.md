# External Trigger: Context-Injected Session Spawn

**Status:** Implemented — shipped in clagentic-console PR #22 (lr-790e). Upstream issue to be filed separately (lr-a953).

**Decision (a):** implemented in clagentic-console fork; upstream issue filed for upstream consideration — see §5.

---

## 1. Problem Statement

Clagentic:Console sessions today start in two ways: a user opens one manually from the UI, or the scheduler's `onTrigger` path creates one from a cron-timed Ralph Loop. Neither path lets an external process (a script, a daemon, another agent) say: "open a session in this project, and start it with this context already loaded."

The gap is not just missing UI — the underlying session-spawn primitive does not accept an initial prompt, and there is no watched directory or event bus that an external writer can push to. Clagentic:Console has no inbox for the outside world.

This matters for any workflow where an event happens outside Clay (a deploy finishes, an alert fires, a queue fills up, another agent hits a decision it cannot resolve) and the right response is a human-with-context, not another automated step. The current options are: (1) open Clagentic:Console manually and reconstruct context by hand; (2) use a scheduled loop that polls — which wastes sessions on nothing and cannot carry event-specific context; or (3) use neither.

The feature requested is: a generic "external trigger → contextual session spawn" primitive that any external process can use by writing a structured file to a watched directory.

---

## 2. Proposed Primitive

### 2.1 Event file format

An external process drops a JSON file at:

```
~/.clagentic/external-triggers/<trigger-id>.json
```

The file schema (v1):

```json
{
  "version": 1,
  "id": "trigger-abc123",
  "projectSlug": "escalations",
  "initialPrompt": "String shown as the first user-turn in the new session.",
  "contextNote": "Optional extra context prepended to the session title or shown as a system message.",
  "cwd": "/workspace/escalations",
  "createdAt": "2026-05-01T12:00:00Z"
}
```

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `version` | yes | Schema version. Must be `1`. |
| `id` | yes | Unique trigger ID. File name must match. |
| `projectSlug` | yes | Clay project slug to open the session in. |
| `initialPrompt` | yes | Text injected as the first user-turn of the new session. |
| `contextNote` | no | Short string used as the session title prefix. Defaults to "External trigger". |
| `cwd` | no | Override project working directory. Defaults to the project's registered cwd. |
| `createdAt` | no | ISO timestamp for ordering and diagnostics. |

### 2.2 Clay behavior on trigger file arrival

1. The external trigger watcher (`project-external-trigger.js`) fires `fs.watch` on `~/.clagentic/external-triggers/`.
2. On file appear event: read and validate the JSON. Reject unknown versions silently (log only).
3. Find the matching project by `projectSlug`. If not found, log and skip.
4. Call `sm.createSession()` on the target project (same call as `new_session` handler, `project-sessions.js:129`).
5. Pre-seed the session with `initialPrompt` by pushing a synthetic `user_message` history entry and immediately calling `sdk.startQuery(session, initialPrompt, ...)` — exactly the pattern in `project-loop.js:500-511`.
6. Broadcast `session_list_changed` so any open browser client reflects the new session.
7. Move or delete the trigger file to `~/.clagentic/external-triggers/processed/<id>.json` to prevent re-fire on Clay restart.
8. **No UI notification is emitted.** The trigger is its own notification channel (ntfy, email, etc.). Adding a notification is opt-in via a future `notifyUser` field in the schema.

### 2.3 What the new session looks like

- It appears in the project's session list like any manually-created session.
- The first turn is the `initialPrompt` text — already visible in history.
- Clay processes it automatically (auto-continue on, same as a Ralph Loop iteration). If the caller wants the session to pause for human input rather than auto-process, `initialPrompt` should end with a question mark and the project's auto-continue setting controls behavior.
- The session has no special marker — it is a normal session. The `contextNote` is used as the title prefix if supplied.

---

## 3. Existing Clay Surfaces This Builds On

### 3.1 Session creation — `sm.createSession()`

`project-sessions.js:129`

```js
var newSess = sm.createSession(sessionOpts, ws);
```

`createSession` today takes `sessionOpts` (ownerId, sessionVisibility, vendor). It does not accept an `initialPrompt`. The change needed: either pass `initialPrompt` into `createSession` opts and have the loop call `startQuery` after return, or call `startQuery` externally after `createSession` returns (no signature change). The loop path (`project-loop.js:415, 500-511`) does the latter — creates the session bare, then pushes the prompt and calls `sdk.startQuery`. That pattern is reusable without changing `createSession`.

**Net change to project-sessions.js: zero.** The new module calls existing APIs in the same order the loop does.

### 3.2 Initial prompt injection — `sdk.startQuery()`

`project-loop.js:500-511` shows the complete pattern:

```js
var userMsg = { type: "user_message", text: loopState.promptText };
session.history.push(userMsg);
sm.appendToSessionFile(session, userMsg);
session.isProcessing = true;
onProcessingChanged();
session.acceptEditsAfterStart = true;
session.singleTurn = true;
sdk.startQuery(session, loopState.promptText, undefined, getLinuxUserForSession(session));
```

This is the exact pattern the new module would use. `session.singleTurn = true` is optional — omit it for a session that stays open for human follow-up; include it for a fire-and-forget agentic dispatch.

**Net change to sdk-bridge.js / project-loop.js: zero.** Both are used as-is.

### 3.3 File watching — `project-file-watch.js`

`project-file-watch.js` is purpose-built for the UI's file/dir browser: `startFileWatch`, `startDirWatch`. It is scoped to paths within a project's cwd via `safePath(cwd, relPath)`. It is not reusable for a global config-dir watcher without modification.

The external trigger watcher watches `~/.clagentic/external-triggers/` — a path outside any project's cwd. It should be a **separate module** (`project-external-trigger.js`) that calls `fs.watch` directly on the config dir. The pattern is identical to `startDirWatch` (debounced `fs.watch`, read on change event) but scoped to the global config dir, not a project path.

**Reuse: pattern, not code.** ~60 lines of `fs.watch` setup can be copied from `project-file-watch.js`.

### 3.4 Scheduler `onTrigger` path — `scheduler.js` + `project-loop.js`

`scheduler.js:288-295` defines `onTrigger: function(record)` which creates a session and calls `startLoop`. This is the only existing path for non-user-initiated session creation. The external trigger feature is structurally the same pattern: external event → create session → inject first message → call startQuery. The scheduler's path is the proof-of-concept.

**No changes to scheduler.js needed** — the new module mirrors its pattern.

### 3.5 Notification system — `project-notifications.js`

`project-notifications.js` is all-or-nothing per event type — there is no per-event-type opt-out today (line 144: `function notify(event, data)` routes through a `formatters` map, but all events write to the same queue and broadcast to all clients). Adding a new `external_trigger` formatter would show a notification, which Andy has disabled because notifications are too coarse today.

**Recommendation:** bypass the notification system entirely for this event class. Wire the watcher directly to session-spawn with no `notify()` call. The human-pull channel is ntfy (or whatever the caller chose). A future `notifyUser: true` field in the trigger schema can opt back in.

---

## 4. Net New Code Estimate

| File | Status | Estimated lines | Ownership per MODULE_MAP.md |
|------|--------|----------------|------------------------------|
| `lib/project-external-trigger.js` | **new** | ~120 | New module, `attachXxx(ctx)` pattern |
| `lib/project.js` | **edit** | ~8 (wire + `attachExternalTrigger(ctx)` call) | project.js thin coordinator |
| `lib/config.js` | **edit** | ~5 (export `EXTERNAL_TRIGGERS_DIR` constant) | config.js |

Total: **1 new file (~120 lines), 2 small edits (~13 lines combined).** No changes to project-sessions.js, sdk-bridge.js, project-loop.js, project-file-watch.js, or project-notifications.js.

### `project-external-trigger.js` internal structure

```
attachExternalTrigger(ctx)
  ctx fields needed: CONFIG_DIR, getProjectBySlug, createSessionAndPrompt

  - startWatcher()        ~25 lines  fs.watch on CLAGENTIC_HOME/external-triggers/
  - handleFile(filePath)  ~40 lines  read/validate JSON, find project, spawn session
  - spawnSession(project, trigger)  ~30 lines  createSession + pushMessage + startQuery
  - archiveTrigger(id)    ~10 lines  move to processed/ subdir
  - stopWatcher()          ~5 lines
  - exports: { startWatcher, stopWatcher }
```

### Module map placement

Per `MODULE_MAP.md`, the new module is an **Infrastructure Module** (alongside `project-file-watch.js`) — it watches a path and emits side effects. It is not a message handler. Wired in `project.js` at startup (not via handleMessage dispatch).

---

## 5. Upstream Viability Assessment

### Evidence

**CONTRIBUTING.md is explicit:** "Feature PRs — Will be closed regardless of quality. This isn't personal — the project has a specific direction and I need to keep it focused." This is a solo-maintained project by chadbyte. Feature submissions are closed by policy, not by fit.

**Upstream PR cadence:** Recent merged work (`feat(mention)`, `fix(scheduler)`, `fix(input)`, `fix(yoke)`, `fix(scroll)`) is bugfixes and small features authored by chadbyte. No feature PRs from external contributors in the visible history. Issues are used for discussion; implementation stays with the maintainer.

**Feature shape:** A watched inbox directory for external session triggers is a non-trivial feature — it adds a new process model (Clay as a recipient of external events, not just a user-driven UI) and a new file schema. This is exactly the class of feature CONTRIBUTING.md says to "open an issue" for, not submit a PR.

**Conflict surface if fork-only:** The new file `project-external-trigger.js` is a standalone module. `project.js` gets ~8 lines of wiring. `config.js` gets one constant. Upstream churn on those files:
- `project.js`: high churn (every feature adds a line). Merge conflicts likely but mechanical (~3 lines of context, easy to resolve).
- `config.js`: low churn. Rare conflicts.
- `project-external-trigger.js`: no upstream equivalent. Zero conflict risk.

**Conclusion:** Upstream merge by PR is not viable — feature PRs are closed by policy. The viable path is:

1. **Implement in clagentic-console** (the fork).
2. **Open a upstream issue** describing the feature generically ("external trigger → session spawn for CI/CD and agentic workflows"). If chadbyte is interested, they implement it themselves. If they do, the fork's patch is dropped. If not, the fork carries 3 changed files with low conflict surface.

**Recommended call: (a) — implement in clagentic-console, file a upstream issue for upstream consideration.**

Deferral is not warranted: the feature is ~135 lines total and unblocks the agentic-program escalation flow with no upstream dependency.

### Conflict surface estimate for long-term fork carry

| File | Upstream churn | Merge effort |
|------|---------------|-------------|
| `project-external-trigger.js` | Zero (new file) | None |
| `project.js` | High | Low — 8-line addition, mechanical |
| `config.js` | Low | Trivial |

Estimated merge cost per upstream release: **~5 minutes.**

---

## 6. Consumer Example: Agentic-Program Escalation Flow

The agentic-program escalation flow is one consumer of this primitive. When a lead-to-lead disagreement cannot resolve autonomously, `clagentic-relay` writes a trigger file to `~/.clagentic/external-triggers/<dispatch-id>.json` with `projectSlug: "escalations"`, `initialPrompt` containing the disagreement summary and the two lead positions, and `cwd: /workspace/escalations`. Simultaneously it fires an ntfy notification so Andy knows to look. Clagentic:Console picks up the trigger file, opens a session in the escalations project already loaded with context, and waits. Andy opens Clagentic:Console, sees the pre-loaded session, reads the summary, and types a decision. The session history (including Andy's response) is written to disk. The next lead session that orients reads the escalations project's session history or a LORE task created from it. No polling, no blocked relay subprocess, no context reconstruction.

---

## 7. Open Questions

1. **Trigger file security.** `~/.clagentic/external-triggers/` is under the user's home directory. Any process running as the same user can write trigger files. Is this acceptable, or should Clay verify a shared secret in the trigger JSON? For single-user self-hosted installs (Andy's use case), it is acceptable. For multi-user Clay deployments, a secret or per-user subdir would be needed.

2. **Auto-continue behavior.** Should the spawned session auto-process the `initialPrompt` immediately (like a loop iteration), or wait for the user to open it first? The proposal defaults to auto-process. If the project's `autoContineMode` setting is off, this will not fire. Should the trigger schema include an `autoProcess: true/false` override?

3. **`singleTurn` vs. open session.** The consumer example wants an open session (human responds). Loop sessions use `singleTurn: true`. The trigger schema should expose this as an optional field. Default: `false` (open, multi-turn).

4. **Processed file retention.** The proposal moves trigger files to `~/.clagentic/external-triggers/processed/`. How long are they kept? A TTL or max-count cleanup is not specified here.

5. **What if Clay is not running?** If Clagentic:Console daemon is down when the trigger file lands, the file sits unprocessed. On next daemon start, Clay would pick it up (the watcher fires on startup scan if a `ready` file or mtime check is added). This restart-recovery behavior is not fully specified.

6. **`projectSlug` vs. `cwd` routing.** The proposal uses `projectSlug` as the primary routing key. If the slug is unknown (project not registered), the trigger is dropped. Should Clay also accept routing by `cwd` alone (auto-register the project if not present)? Simpler to require the project to be registered first.
