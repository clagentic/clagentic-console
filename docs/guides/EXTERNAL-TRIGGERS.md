# External Triggers — Agent Guide

Clagentic: Console watches a directory for JSON trigger files. Any process or
agent running on the same machine can drop a file there to either **spawn a new
session** or **inject a message into a live session**. This document is the
authoritative reference for agents writing trigger files.

## Drop directory

```
~/.clagentic/console/external-triggers/
```

The legacy path `~/.clagentic/external-triggers/` is kept as a symlink to the
above. Use the canonical path.

## How it works

1. Write a valid JSON file to the drop directory (name it anything, must end
   in `.json`).
2. The daemon picks it up within milliseconds (inotify watcher) or within 30
   seconds at most (polling backstop).
3. On success the file is moved to `processed/` inside the same directory.
4. On `not_found` (inject into a session that isn't live) the file is left in
   place so it can be retried after a daemon restart. Clear `dispatched` state
   resets automatically on retry.

## Schema

### Spawn a new session (v1 or v2 without `sessionId`)

```json
{
  "version": 2,
  "id": "my-trigger-unique-id",
  "projectSlug": "my-project",
  "initialPrompt": "Pick up where we left off on task lr-1234.",
  "contextNote": "Resuming work",
  "cwd": "/workspace/my-project",
  "createdAt": "2026-06-13T15:00:00Z"
}
```

### Inject into a live session (v2 with `sessionId`)

```json
{
  "version": 2,
  "id": "my-trigger-unique-id",
  "projectSlug": "my-project",
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "initialPrompt": "The build passed. Continue with step 3.",
  "createdAt": "2026-06-13T15:00:00Z"
}
```

## Field reference

| Field | Required | Description |
|---|---|---|
| `version` | yes | `1` or `2`. Use `2`. |
| `id` | yes | Unique string. Used for dedup and archive filename. Use a slug + timestamp or UUID. |
| `projectSlug` | yes | **The registered project slug** — see critical note below. |
| `initialPrompt` | yes | The message text to send. For a spawn, this is the opening user message. For an inject, it is pushed into the live session as a new user turn. |
| `sessionId` | v2 only, optional | The `cliSessionId` of the target session. Find it in the session's JSONL file under `~/.clagentic/console/sessions/`. When present, injects into that session instead of spawning. |
| `contextNote` | optional | Human-readable label shown in the session title for spawned sessions. Ignored on inject. |
| `cwd` | optional | Working directory for spawned sessions. Ignored on inject. |
| `createdAt` | optional | ISO timestamp. Informational only. |

## Critical: `projectSlug` is NOT a path encoding

`projectSlug` must be the **registered slug** from the daemon's project list —
the short name the daemon uses internally, not a filesystem path or an encoded
path.

**Wrong:**
```
"-workspace-clagentic-relay"   // path encoding — REJECTED
"/workspace/clagentic-relay"   // absolute path — REJECTED
```

**Right:**
```
"clagentic-relay"              // registered slug — accepted
```

To find the correct slug: look at the session JSONL files under
`~/.clagentic/console/sessions/`. The directory name one level above the JSONL
file is the encoded path; the slug is the bare name visible in the daemon log
(`[server] Adding project: clagentic-relay → /workspace/clagentic-relay`) or
in `~/.clagentic/console/daemon.json` under `projects[].slug`, or by running:

```bash
grep '"slug"' ~/.clagentic/console/daemon.json
```

## Finding `sessionId` for an inject

The `sessionId` is the `cliSessionId` field in the session JSONL file, not the
filename and not the `localId`. Example:

```bash
grep -m1 '"cliSessionId"' \
  ~/.clagentic/console/sessions/-workspace-my-project/<session-id>.jsonl
```

That value is what goes in the trigger's `sessionId` field.

## Retry and failure behaviour

- **Spawn failures** (project not found, `startQuery` throws): trigger is
  dropped (not archived). Fix the slug and drop a new file.
- **Inject — session not found**: trigger is left in the drop dir and
  `dispatched` state is cleared. The daemon retries on the next watcher event
  or poll cycle. Useful for daemon-down recovery.
- **Inject — session found, `pushMessage` throws**: trigger stays dispatched
  (no rapid retry loop). Drop a new file to retry.
- **Unknown `projectSlug`**: trigger is dropped with a log warning. Not
  retried. Fix the slug.

## Checking daemon logs

```bash
journalctl -u clagentic-console -n 100 | grep external-trigger
```

Key log lines:

| Log | Meaning |
|---|---|
| `push_message delivered to session <id>` | Inject succeeded |
| `push_message: session not found: <id>` | `sessionId` not in live session map — retry pending |
| `Unknown projectSlug '<slug>'` | Wrong slug — fix and re-drop |
| `Invalid trigger <file>: <reason>` | Schema validation failed |
| `Session spawned: project=<slug> session=<id>` | Spawn succeeded |
