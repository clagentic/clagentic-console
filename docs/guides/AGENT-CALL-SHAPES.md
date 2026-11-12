# Agent call shapes

Every agent verb of Clagentic: Console as one literal command. Each shape below runs as written, with the placeholders replaced: no pipe, no filter such as `jq` or `grep`, and no shell variable. The verbs do the narrowing themselves, so output that is already the size you need is printed whole.

The reference for what each verb means, its results and its exit codes is [AGENT-GUIDE.md](./AGENT-GUIDE.md). This page is the shortest route to a correct call. Every verb and subcommand also prints its usage with `-h` or `--help`, on stdout, with exit 0:

```bash
clagentic-console send-input --help
clagentic-console schedule-input --help
clagentic-console schedule-input create --help
```

Examples use the generic project `my-project`, the generic agents `reviewer` and `builder`, and placeholder ids.

## Find a session

Without `--state`, `list-sessions` lists live and idle sessions only, newest first, one compact row each. A project with hundreds of reaped sessions and one running lane returns one row.

```bash
clagentic-console list-sessions --project my-project
```

One named agent's current session:

```bash
clagentic-console list-sessions --project my-project --agent reviewer --limit 1
```

Live and idle are the defaults; name the states to change that. A comma list takes several, `any` takes every state:

```bash
clagentic-console list-sessions --project my-project --state live
clagentic-console list-sessions --project my-project --state idle,reaped
clagentic-console list-sessions --project my-project --state any --limit 20
```

Reaped sessions are left out unless asked for. A caller that relied on the old default, every session, passes `--state any`.

The full record per row, with the opener, the last sender, the turn count, whether a turn is running, the memory held and the host load:

```bash
clagentic-console list-sessions --project my-project --verbose
```

| Flag | Takes | Notes |
|---|---|---|
| `--project` | a project slug | |
| `--agent` | an agent name | compared by slug |
| `--vendor` | a vendor id | |
| `--state` | `live`, `idle`, `reaped`, `any`, or a comma list | default `live,idle` |
| `--limit` | a whole number, 1 or more | the newest rows, after the filters |
| `--verbose` | nothing | the full record and `host` |

Compact row fields: `consoleSessionId`, `sessionId`, `project`, `label`, `name`, `state`, `lastActivity`, `pendingPrompts`. `--verbose` adds `agent`, `vendor`, `title`, `openedAt`, `opener`, `lastInjectedSender`, `turnCount`, `midTurn` and `memory`, and the result gains `host`.

## Open a session

```bash
clagentic-console open-session --project my-project --agent reviewer --prompt "Review the open change."
clagentic-console open-session --to reviewer@my-project --prompt "Review the open change."
clagentic-console open-session --to reviewer@my-project/pass-2 --prompt "Second pass."
clagentic-console open-session --project my-project --vendor codex --name lane-a --prompt "Start the migration."
```

## Send input

By address, to the one session it names:

```bash
clagentic-console send-input --to reviewer@my-project --prompt "The build passed."
clagentic-console send-input --to reviewer@my-project/pass-2 --prompt "The build passed."
clagentic-console send-input --to @my-project --prompt "Standup in five."
```

By project and session id, from a `list-sessions` row:

```bash
clagentic-console send-input --project my-project --session 12 --prompt "The build passed."
```

Back to whoever last sent to this session, from inside a console session:

```bash
clagentic-console send-input --reply --prompt "Done."
```

An address that names several sessions in its top tier is refused with exit 3 and the candidates, each carrying the `--verbose` fields; send again with `--project` and `--session` for the one you want.

## End a session

```bash
clagentic-console end-session --to reviewer@my-project/pass-2
clagentic-console end-session --project my-project --session 12 --reason "finished"
```

## Answer a prompt

The request id is in the `pendingPrompts` of the session's `list-sessions` row.

```bash
clagentic-console answer-prompt --project my-project --session 12 --request 4f1c --decision allow
clagentic-console answer-prompt --to reviewer@my-project --request 4f1c --decision deny
```

## See what a session sent

`--session` takes the vendor session id (`sessionId` in a `list-sessions` row), never a console id. Compact rows by default:

```bash
clagentic-console list-outbound --session 4f1c9d2e-7a3b-4c55-9e0a-1b2c3d4e5f60
clagentic-console list-outbound --session 4f1c9d2e-7a3b-4c55-9e0a-1b2c3d4e5f60 --since 2h --kind sent
clagentic-console list-outbound --session 4f1c9d2e-7a3b-4c55-9e0a-1b2c3d4e5f60 --verbose
```

Compact row fields: `ts`, `kind`, `result`, `reason`, `initiator`, `prompt`, `promptWithheld` and a `target` of `project`, `sessionId`, `agent`, `name`, `address`.

## Schedule input

Once, after a delay or at a local time:

```bash
clagentic-console schedule-input create --session 12 --project my-project --in 10m --prompt "Check the build."
clagentic-console schedule-input create --session 12 --project my-project --at 08:00 --prompt "Morning check."
```

On a repeat, which always has an end:

```bash
clagentic-console schedule-input create --session 12 --project my-project --every 30m --until 21:00 --prompt "Status?"
clagentic-console schedule-input create --session 12 --project my-project --every 2h --count 4 --prompt "Status?"
```

Long text from a file:

```bash
clagentic-console schedule-input create --session 12 --project my-project --in 1h --prompt-file notes.txt
```

List and cancel. `list` shows armed schedules as compact rows; `--state` takes `armed`, `done`, `ended` or `any`:

```bash
clagentic-console schedule-input list --project my-project
clagentic-console schedule-input list --project my-project --state any --verbose
clagentic-console schedule-input delete --id 7c1e --project my-project
```

`schedule-input create` inside a console session may leave out `--project`: it defaults to the calling session's own project.

## Long prompt text

`open-session` and `send-input` take long or multi-line text from standard input with `--prompt -`, redirected from a file:

```bash
clagentic-console send-input --to reviewer@my-project --prompt - < message.txt
```

## Daemon checks

Each prints the daemon's whole answer as JSON, flushed before the command exits, so a field the daemon adds later is never cut off.

```bash
clagentic-console --activity-diagnostics
clagentic-console --usage
clagentic-console --process-build-status
```

## After an upgrade

The verbs run in the CLI, but `--verbose`, `--limit`, the state list and the richer fields are answered by the daemon. Restart the daemon after installing a build that has them; until then an older daemon answers `list-sessions` with every state and without the extra fields.
