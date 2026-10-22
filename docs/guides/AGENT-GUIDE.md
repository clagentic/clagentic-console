# Agents in Clagentic: Console

Agents are first-class users of Clagentic: Console. A script, a CI job or an AI agent running inside a console session can use these shell verbs, with no browser and no API token:

- `clagentic-console open-session` opens a new session and runs its first prompt.
- `clagentic-console send-input` sends input to an existing session, and resumes it if its runtime was reaped.
- `clagentic-console list-sessions` lists the console's sessions with their state and any prompts they are waiting on.
- `clagentic-console schedule-input` schedules text to be sent into a session later, once or on a repeat that always has an end. A person does the same from the clock button in the browser.

This guide is the canonical reference for these verbs. [architecture.md](./architecture.md) describes how they are built; where the two ever differ, fix the difference in the same change. Writers who cannot run the CLI can use the file drop, covered in [EXTERNAL-TRIGGERS.md](./EXTERNAL-TRIGGERS.md) and not repeated here.

Every verb talks to the running daemon over its Unix socket (`~/.clagentic/console/daemon.sock`, mode 0700), so the caller must be the daemon's own OS user and the daemon must be running. Each verb prints its result as JSON on stdout. Without a running daemon the result is `{ "ok": false, "result": "error", "reason": "no running daemon" }`.

Examples use the generic project `my-project` and the generic agents `reviewer` and `builder`.

## Contents

- [Addressing a session](#addressing-a-session)
- [open-session](#open-session)
- [send-input](#send-input)
- [list-sessions](#list-sessions)
- [Scheduled input](#scheduled-input)
- [Delivery semantics](#delivery-semantics)
- [Results and exit codes](#results-and-exit-codes)
- [The sender record](#the-sender-record)
- [Named-agent sessions get their definition's tools](#named-agent-sessions-get-their-definitions-tools)
- [External triggers (file drop)](#external-triggers-file-drop)
- [Suggested allow rules](#suggested-allow-rules)

## Addressing a session

`send-input` names its target in exactly one of three ways. Giving more than one is refused.

| Form | Meaning |
|---|---|
| `--project <slug> --session <id>` | One session by id. The id is scoped to the project, so a session is never addressed by id alone. `--session` takes the console session id (`consoleSessionId`, returned by `open-session` and `list-sessions`) or the id the vendor assigned (`sessionId`). |
| `--to <address>` | A session by who it is, with no id. See the address forms below. |
| `--reply` | The sender of the most recent injected message in the calling session. |

### Address forms (`--to`)

| Address | Matches |
|---|---|
| `<agent>@<project>` | a session running that named agent, for example `reviewer@my-project` |
| `<vendor>@<project>` | a plain session (no named agent) on that vendor, for example `claude@my-project` or `codex@my-project` |
| `@<project>` | any session in the project |

Each form accepts an optional `/<name>` after the project, naming one session by the name it was opened with: `reviewer@my-project/pass-2`, `claude@my-project/scratch`, `@my-project/pass-2`.

An address is at most 192 characters. `--project` may be given beside `--to`, and must then be the address's project.

### Resolution tiers

An address names a class of sessions, and the console never guesses within one. Among the sessions an address matches, the highest state tier that has any match decides:

1. `live`: a turn is running.
2. `idle`: a runtime is attached and no turn is running.
3. `reaped`: no runtime (the idle reaper, a daemon restart). Input resumes it.

Exactly one match in the deciding tier: the input goes to it. Several in that tier: nothing is delivered and the result is `ambiguous`, with the tied sessions as `candidates` (the exit code is 3). Lower tiers are not consulted once a higher tier matched. No match at all is `not-found` (exit code 4). An address that does not parse, or names an unknown project, is `refused`.

When a result is `ambiguous`, pick a candidate and send again with `--project <slug> --session <consoleSessionId>`, or name the session (below).

### Session names (`/<name>`)

A name makes one session addressable exactly. It is set once, when the session is opened, and cannot be changed:

```bash
clagentic-console open-session --project my-project --agent reviewer --name pass-2 --prompt "Review the open change."
clagentic-console open-session --to reviewer@my-project/pass-2 --prompt "Review the open change."
```

Both forms do the same thing. Rules, from `lib/session-directory.js` and `lib/session-input.js`:

- A name is 1 to 32 characters of `a-z`, `0-9`, `-` and `_`, starting with a letter or digit. It is compared without regard to case and stored in lowercase.
- A name has one holder per project. `open-session` refuses a name that a session of the project holds in the `live` or `idle` state; the message names that session. A name held only by reaped sessions is taken from them when the new session claims it.
- The named form is exact: `reviewer@my-project/pass-2` resolves only to the session holding that name, in any state (a reaped holder is resumed on delivery), and never falls to a different session. A name no session holds is `not-found`.
- `list-sessions` shows the name as `name`; it is `null` for an unnamed session.
- `open-session --to <address>/<name>` and `--name` together are refused: name the session one way.

## open-session

Opens a new session in a project and starts its first turn with the prompt. The call returns as soon as the first turn has started.

```
clagentic-console open-session (--project <slug> | --to <address>) --prompt <text|->
    [--vendor <id>] [--agent <name>] [--name <session-name>] [--visibility shared|private]
    [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--project <slug>` | one of `--project`, `--to` | The registered project slug. |
| `--to <address>` | one of `--project`, `--to` | Opens the kind of session the address names: `<agent>@<project>` opens that named agent, `<vendor>@<project>` a plain session on that vendor, `@<project>` the project default. It resolves no existing session, so it cannot be ambiguous. With `--to`, do not also give `--vendor` or `--agent`. A `/<name>` suffix names the new session, so do not also give `--name`. May be given beside `--project`, which must then be the address's project. |
| `--prompt <text\|->` | yes | The first prompt. `-` reads the prompt from stdin (a single trailing newline is removed). |
| `--vendor <id>` | no | A registered vendor, for example `claude` or `codex`. Absent: the project's default vendor. An unknown vendor is `refused`. |
| `--agent <name>` | no | A named agent from the picker's catalog (`.claude/agents/` in the project or `~/.claude/agents/`). Absent: a plain session. An unknown agent is `refused`. |
| `--name <session-name>` | no | The session name; see [Session names](#session-names-name). |
| `--visibility shared\|private` | no | Absent: `shared`. Any other value is `refused`. |
| `--initiator <kind>` | no | Who started the turn. See [Initiator](#initiator). |
| `--context-note <text>` | no | A label. It becomes the session title (absent: `External trigger`) and is stored on the recorded message. |
| `--from <name>` | no | Declares the caller's name. See [The sender record](#the-sender-record). |
| `--from-session <id>` | no | The sending session's id at its own vendor. See [The sender record](#the-sender-record). |

Example:

```bash
clagentic-console open-session --project my-project --agent reviewer --name pass-2 \
  --context-note "Review of the open change" \
  --prompt "Review the open change and report findings."
```

Result:

```json
{
  "consoleSessionId": "12",
  "sessionId": null,
  "localId": 12,
  "vendor": "claude",
  "agent": "reviewer",
  "name": "pass-2",
  "ok": true,
  "result": "opened"
}
```

`consoleSessionId` is the console's own id and is always present. `sessionId` is the vendor-assigned id and is `null` until the vendor has assigned one. Either id is what `send-input --session` takes. The session stays open for follow-up from a person.

If the first turn fails to start, the session the call created is removed and the result is `error` with `retryable: false`; open again if you want to.

## send-input

Sends input to a session. The input becomes the session's next turn. A reaped session is resumed first.

```
clagentic-console send-input (--project <slug> --session <id> | --to <address> | --reply) --prompt <text|->
    [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--project <slug>` | with `--session` | The registered project slug. |
| `--session <id>` | with `--project` | The console session id or the vendor-assigned id. An id that is not a plain id (letters, digits, `_`, `-`) is `refused`. |
| `--to <address>` | one target | See [Addressing a session](#addressing-a-session). May be given beside `--project`, which must then be the address's project. |
| `--reply` | one target | A switch, it takes no value. Answers the sender of the most recent injected message in the calling session; see below. |
| `--prompt <text\|->` | yes | The input. `-` reads it from stdin. An empty prompt is rejected. |
| `--initiator <kind>` | no | See [Initiator](#initiator). |
| `--context-note <text>` | no | A label stored on the recorded message. |
| `--from <name>` | no | See [The sender record](#the-sender-record). |
| `--from-session <id>` | no | See [The sender record](#the-sender-record). |

Name the target one way only: `--session` (with `--project`), or `--to`, or `--reply`. `--reply` cannot be combined with `--project` or `--session`; `--to` cannot be combined with `--session` or `--reply`.

Examples:

```bash
# By id
clagentic-console send-input --project my-project --session 12 --prompt "Continue with step 3."

# By address
clagentic-console send-input --to reviewer@my-project --prompt "The build passed. Re-run your checks."

# By name
clagentic-console send-input --to reviewer@my-project/pass-2 --prompt "One more file to review."

# A long prompt from a file
clagentic-console send-input --to builder@my-project --prompt - < message.txt
```

A delivered result:

```json
{
  "consoleSessionId": "12",
  "sessionId": "6f1c…",
  "localId": 12,
  "vendor": "claude",
  "agent": "reviewer",
  "name": "pass-2",
  "ok": true,
  "result": "delivered",
  "resolvedBy": "to",
  "project": "my-project",
  "label": "reviewer@my-project"
}
```

When the target was named by `--to` or `--reply`, the result also carries `resolvedBy` (`to` or `reply`), `project` and `label`, so the caller learns which session took the input. `sessionId` can be `null` for a session that has no vendor id yet.

### Replying with `--reply`

`--reply` answers whoever last sent input to the calling session, without knowing their id or address:

```bash
clagentic-console send-input --reply --prompt "Done. Findings are in the change description."
```

It works only from inside a console session started by the console, because the caller is identified by two environment variables the console sets in that session: `CLAGENTIC_CONSOLE_PROJECT` and `CLAGENTIC_CONSOLE_SESSION_ID`. The verb reads them automatically; there is no flag. The sender is found by the project, vendor and vendor session id recorded with the most recent injected message, through the same lookup as `--to`, so the same tiers apply.

`--reply` is `refused`, with a reason, when:

- no session reference is set (a terminal outside the console, or a Codex session, which carries none);
- the console does not hold the calling session as a running session;
- the calling session has received no injected message;
- the most recent injected message has no recorded sender session (its sender was `declared` or `undeclared`), or recorded no vendor or vendor session id (older messages);
- the matched sender session runs as another OS user.

It is `not-found` when no session of the recorded project has the recorded vendor and vendor session id, and `ambiguous` (with candidates) when the identity matches several sessions. A reply is delivered like any other input, so its own sender is recorded the same way and the receiver can reply in turn.

## list-sessions

Read-only. Lists the sessions the console holds, newest activity first. Every session recorded in the console's own store is listed, whether or not it has a runtime; a session started outside the console is not. Background helper sessions are not listed.

```
clagentic-console list-sessions [--project <slug>] [--agent <name>] [--vendor <id>] [--state live|idle|reaped|any]
```

| Flag | Meaning |
|---|---|
| `--project <slug>` | Only this project. An unknown project is `refused`. |
| `--agent <name>` | Only sessions running this named agent. Compared by slug, so `Reviewer` and `reviewer` are one agent. |
| `--vendor <id>` | Only sessions on this vendor (case-insensitive). |
| `--state live\|idle\|reaped\|any` | Only sessions in this state. Default `any`. Another value is `refused`. |

The filters combine. Examples:

```bash
clagentic-console list-sessions
clagentic-console list-sessions --project my-project --state live
clagentic-console list-sessions --agent reviewer --state any
```

Result:

```json
{
  "ok": true,
  "result": "listed",
  "count": 1,
  "sessions": [
    {
      "consoleSessionId": "12",
      "sessionId": "6f1c…",
      "project": "my-project",
      "agent": "reviewer",
      "vendor": "claude",
      "label": "reviewer@my-project",
      "name": "pass-2",
      "title": "Review of the open change",
      "state": "live",
      "lastActivity": "2026-10-22T14:03:11.000Z",
      "pendingPrompts": [
        {
          "requestId": "…",
          "kind": "permission",
          "tool": "Bash",
          "summary": "…",
          "ageSeconds": 42
        }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `consoleSessionId` | The console's id for the session, scoped to the project. |
| `sessionId` | The vendor's id, or `null` if none has been assigned yet. |
| `project` | The project slug. |
| `agent` | The named agent, or `null` for a plain session. |
| `vendor` | The vendor the session runs on. |
| `label` | `<agent>@<project>`, or `<vendor>@<project>` for a plain session: the same string `--to` accepts. |
| `name` | The session name set at open, or `null`. |
| `title` | The session title (empty string if none). |
| `state` | `live` (a turn is running), `idle` (a runtime is attached, no turn is running) or `reaped` (no runtime; input resumes it). |
| `lastActivity` | ISO 8601 time of the last activity (falling back to creation time), or `null`. |
| `pendingPrompts` | The operator prompts the session is blocked on, oldest first; an empty array when it waits on nothing. |

`pendingPrompts` tells a session that is waiting on an answer from one that is working: a session blocked on a prompt is still `live`. Each element is `{ requestId, kind, tool, summary, ageSeconds }`. `kind` is the prompt kind (`permission`, `plan`, `ask_user`, `elicitation`), `tool` the tool name or `null`, `ageSeconds` the whole seconds since the prompt opened, and `summary` the one-line text the permission banner already shows for a tool call (empty for other kinds). Tool input beyond that line, a question's or form's text and a plan's content are never included. The list is read from the daemon's memory; an answered, expired or cancelled prompt is gone from the next call. An older daemon's entries lack the field: treat a missing `pendingPrompts` as "not reported", not as "nothing pending".

## Scheduled input

Scheduled input is text the console sends into one session at a later time. It is a feature for people and agents alike: a person uses the clock button next to the message box, an agent or a script uses `clagentic-console schedule-input`. Both make the same record, show in the same list and use the same firing path, so a schedule made in the browser appears in the CLI's list and the reverse.

There are two kinds:

| Kind | What it does |
|---|---|
| **Once** | Sends one time, at a time you give: in N minutes, or at a clock time. |
| **Repeat** | Sends every N minutes, from one minute to 24 hours, and always has an end: until a clock time, or for N times. A repeat with no end is refused. |

Scheduling is never always-on. Every record has a time it ends, and the caller sets it.

### From the browser

1. Click the clock button next to the message box. A small panel opens.
2. Choose **Once** or **Repeat**.
   - **Once:** type minutes (`In 10 min`) or a clock time (`At 20:01`, for example just after an 8 pm limit reset).
   - **Repeat:** type the interval in minutes (`Every 30 min`) and an end, either `Until 21:00` or `For 4 times`.
3. The panel says when the message will go before anything is armed, for example `Sends today at 20:01.` A clock time that has already passed today means tomorrow, and the panel says `tomorrow`. Clock times use the browser's local time zone.
4. Press **Schedule**, then type your message and press Send as usual. The message does not go now: it appears as a scheduled-message bubble at the end of the chat, with its next time and **Send now** and **Cancel**.
5. The same panel lists the session's armed scheduled messages, with their kind, next time and end, and Send now and Cancel for each. A repeat is labelled `Scheduled repeat`, a one-time message `Scheduled message`. The console's own automatic continue after a rate limit is listed as `Automatic resume after rate limit`.

The browser schedules only for the session on screen. A session can hold 5 armed scheduled messages; at 5 the clock button is off until one is cancelled or sent (the bubbles keep their Cancel).

### From a shell

```
clagentic-console schedule-input create --session <id> [--project <slug>]
    (--in <dur> | --at <time> | --every <dur> (--until <time> | --count <n>))
    (--prompt <text|-> | --prompt-file <path>)
clagentic-console schedule-input list [--session <id>] [--project <slug>] [--state armed|done|ended|any]
clagentic-console schedule-input delete --id <id> [--project <slug>]
```

All options are flag/value pairs, so each command shape can be allow-listed (see [Suggested allow rules](#suggested-allow-rules)).

`create`:

| Flag | Required | Meaning |
|---|---|---|
| `--session <id>` | yes | The session to send into: the console session id or the vendor-assigned id, as `send-input --session` takes. It may be any session of the project; the CLI is not limited to the caller's own. |
| `--project <slug>` | when not inside a console session | The project the session is in. Inside a console session it defaults to that session's own project. |
| `--in <dur>` | one timing flag | Once, after this long. |
| `--at <time>` | one timing flag | Once, at this local time. |
| `--every <dur>` | one timing flag | Repeat at this interval. The first send is one interval from now. |
| `--until <time>` | with `--every`, or `--count` | The repeat ends at this local time. |
| `--count <n>` | with `--every`, or `--until` | The repeat ends after this many sends (1 to 1000). |
| `--prompt <text\|->` | one text flag | The text to send. `-` reads it from stdin (a single trailing newline is removed). |
| `--prompt-file <path>` | one text flag | Reads the text from a file (a single trailing newline is removed). Use it for long or multi-line text. |

Exactly one of `--in`, `--at`, `--every`. `--until` and `--count` belong to `--every`, and a repeat needs exactly one of them.

`<dur>` is a number of minutes or a run of `s`, `m`, `h` and `d` parts: `90`, `10m`, `2h`, `1h30m`. `<time>` is a local `HH:MM` (24-hour), or a local `YYYY-MM-DDTHH:MM`. Times are read in the caller's own time zone. An `HH:MM` that has already passed today means tomorrow, and the result shows the absolute time it resolved to, so a mistake is visible:

```bash
# Once, in ten minutes
clagentic-console schedule-input create --session 12 --project my-project --in 10m \
  --prompt "Check whether the deploy finished."

# Once, at a clock time (tomorrow if 08:00 has passed)
clagentic-console schedule-input create --session 12 --project my-project --at 08:00 \
  --prompt "Start the morning review."

# A repeat every 30 minutes, until 21:00
clagentic-console schedule-input create --session 12 --project my-project --every 30m --until 21:00 \
  --prompt "Wake up and report where the build stands."

# A repeat every 2 hours, four times, with the text from a file
clagentic-console schedule-input create --session 12 --project my-project --every 2h --count 4 \
  --prompt-file message.txt

# From inside a console session, for itself (the project defaults to the caller's own)
clagentic-console schedule-input create --session "$CLAGENTIC_CONSOLE_SESSION_ID" --every 20m --count 6 \
  --prompt "Check the queue again."
```

Result:

```json
{
  "ok": true,
  "result": "scheduled",
  "record": {
    "id": "si_3f9a1c7b2e",
    "sessionId": "6f1c…",
    "kind": "recurring",
    "state": "armed",
    "preview": "Wake up and report where the build stands.",
    "createdBy": "reviewer@my-project",
    "at": null,
    "nextAt": 1793000000000,
    "every": 1800000,
    "until": 1793010000000,
    "count": null,
    "firedCount": 0,
    "lastFiredAt": null,
    "lastOutcome": null,
    "endReason": null
  },
  "project": "my-project",
  "resolved": {
    "every": 1800000,
    "firstAt": 1793000000000,
    "firstAtLocal": "2026-10-22 19:30",
    "until": 1793010000000,
    "untilLocal": "2026-10-22 21:00",
    "tomorrow": false
  }
}
```

`createdBy` records who made the schedule: the calling console session as `<agent>@<project>` (or `<vendor>@<project>`), the plain `cli` outside a session, `browser` or `browser:<user>` for the clock button, and `rate-limit` for the console's own automatic continue. A once record has `at`; a repeat has `every` and `until` or `count`. `nextAt` and the other times are milliseconds since the epoch. `resolved` repeats the times in the caller's local time (`atLocal`, `firstAtLocal`, `untilLocal`, as `YYYY-MM-DD HH:MM`) and says whether a clock time rolled over to `tomorrow`; for a once record it is `{ at, atLocal, tomorrow }`.

`list` prints `{ "ok": true, "result": "listed", "count": N, "inputs": [...] }`: for each record its `id`, `project`, `sessionId`, `kind`, `state`, `preview` (the start of the text), `nextAt`, the end (`until` or `count`), `firedCount`, `lastOutcome` (`delivered`, `resumed-and-delivered`, or why the last attempt was skipped or failed), `endReason` and `createdBy`. The default is the armed records of every project, soonest first; `--state done`, `ended` or `any` shows finished ones too (the last 20 per project are kept). `--session` and `--project` narrow it.

`delete --id <id>` cancels a record and removes it; `--project` is only needed to narrow the search, since an id is unique. An unknown id is `not-found`. A record whose text is being sent at that moment is not deleted: the answer is `busy` (exit 1) with the reason "that scheduled input is being sent; try again in a moment", and the record is unchanged. Try again once the send is over. The CLI has no send-now verb: use `send-input` for an immediate send.

Exit codes: `0` when the request was acted on (scheduled, listed, deleted), `1` when it was refused, not found or failed. A usage mistake (an unknown option, a missing value, conflicting timing flags, a repeat with no end) prints the usage line to stderr and exits 1 without contacting the daemon.

### Rules

- **The limits.** `--every` from 1 minute to 24 hours. At most 5 armed records per session; a sixth is refused. The automatic continue after a rate limit still counts toward the 5 but is never refused for it, so a person's own schedules can never make a rate-limited session lose its resume. A once record may be at most 366 days ahead.
- **One session, never another.** A record targets exactly one session and never moves to a different one. There is no address resolution when it fires. It is stored under the session's vendor-assigned id, which survives a restart; a session that has not run its first turn has no vendor id yet, so a record armed on it is keyed by the console id. Such a record is upgraded to the vendor id as soon as the session has one; if the daemon restarts first it is `ended` ("the session had not started when the daemon restarted") at the next start, because the console id is renumbered by a restart and could name another session. Records keyed by the vendor id survive a restart.
- **It goes through `send-input`'s path.** At its time the text is delivered into the session the way `send-input` delivers: into the running query, or, for a session whose runtime was reaped, by resuming it by id first. No new session is created. The chat shows it as the automation (`Scheduled message`, labelled `scheduled message` or `scheduled repeat`), never as a person's turn.
- **Mid-turn firings are skipped.** If the session is in the middle of a turn when a record is due, nothing is sent; the console tries again every 15 seconds and sends once the session is idle. For a repeat, only one send is made when the turn ends (missed sends are not made up in a burst), and the next send is one interval after that delivery.
- **Send now is the exception.** A person pressing Send now forced the send, so it is not skipped: it goes into the running turn, as `send-input` does, with the initiator `scheduled-now`. Send now on a repeat counts as one of its sends and the next is one interval later.
- **A repeat's next time is the delivery time plus the interval.** It ends at its `--until` time or after its `--count` sends and is then `done`.
- **Downtime.** Records are kept on disk, per project in `~/.clagentic/console/scheduled-input/`, and survive a daemon restart. A once record whose time passed while the daemon was down is sent once, a few seconds after startup, rather than lost. A repeat is not caught up: it sends at most once, then carries on from that delivery; if its end passed while the daemon was down it is `done` without a send.
- **Ended.** A record is `ended` when its session is closed or deleted. A session whose runtime was only reaped is not ended: the next send resumes it by id. A record that reached its end is `done`.
- **A successor arms its own.** When one session hands off to another, the outgoing session deletes its schedules and the successor arms its own as a step of the handoff. Nothing is inferred from an address, and a record never follows a session to its successor.
- **Failures.** A send that fails is retried every 30 seconds; after 10 failures in a row the record ends with the reason.
- **At most once.** The record is advanced and saved before its text is delivered, so a restart or crash around a delivery can lose that one send but never makes it twice. If the list cannot be saved, nothing is delivered: the project's firing stops, is logged, and is retried every 30 seconds until a save works. `schedule-input list` then answers `store` (one project) or `storeErrors` (all projects) with `state` `unhealthy`. If a store file is unreadable and cannot be moved aside, the project's store is `read-only`: nothing is saved or delivered and the file is left as it is, until the file is fixed and the daemon restarted. Creating or deleting a record whose change cannot be saved is refused with `error`. If the list cannot be saved after a text was delivered, the record keeps its saved `sending` outcome and is not delivered again.
- **The browser's limit.** At 5 armed records the clock button still opens the panel, where Send now and Cancel work; only Schedule is off, with the reason shown.

## Delivery semantics

- **Push, not poll.** Input is pushed into the target session when the call is made. There is no inbox to poll and no queue the receiver must drain. The call returns after the session's query has actually started or accepted the input.
- **Mid-turn input is queued into the running turn.** If the session has a running query (`live` or `idle` with a runtime), the input is pushed into it and the result is `delivered`.
- **A reaped session is resumed.** If the session's runtime has ended, it is resumed on its own vendor and agent from the console's store, and the input starts its next turn. The result is `resumed-and-delivered`. A resume for injected input does not move any connected browser off the session it is viewing.
- **Only the console's own store is asked.** A session started outside the console (a vendor CLI run by hand) is not addressable. An id the store does not hold is `not-found`.
- **Load shedding.** When the daemon is shedding new work under memory pressure, a request that would start a runtime is `refused` with `retryable: true`. Try again later.
- **No human turns.** Injected input is never recorded as a person's turn. See [Initiator](#initiator).

## Results and exit codes

The `result` field of the JSON, and the process exit code:

| `result` | Meaning | Exit code |
|---|---|---|
| `opened` | `open-session` started a new session. | 0 |
| `delivered` | The input went into the session's running query. | 0 |
| `resumed-and-delivered` | A reaped session was resumed and took the input. | 0 |
| `listed` | `list-sessions` answered. | 0 |
| `ambiguous` | An address (or `--reply`) matched several sessions in its deciding tier; `candidates` lists them. Nothing was delivered. | 3 |
| `not-found` | `--to` or `--reply` matched no session. | 4 |
| `not-found` | `--session` named a session the console does not hold. | 1 |
| `refused` | The request is invalid or not allowed; `reason` says why (unknown project, vendor, agent or visibility, bad initiator, bad name or address, a name already held, an empty prompt, an unsafe id, conflicting targets). Not a failure to deliver. | 1 |
| `error` | Delivery was attempted and failed, or the daemon could not be reached. `retryable` says whether sending again can help. | 1 |

`schedule-input` answers `scheduled`, `listed` or `deleted` (exit 0), and `refused` (an invalid request: a bad interval or time, no end on a repeat, the limit of 5, an unknown project), `not-found` (an unknown session or id), `busy` (a delete of a record that is being sent) or `error` (exit 1). See [Scheduled input](#scheduled-input).

A CLI usage mistake (an unknown option, a missing value, a missing target or `--prompt`) prints the usage line to stderr and exits 1 without contacting the daemon.

`refused` and `error` results carry `ok: false`, `result` and `reason`; some carry `retryable`. For a send whose turn failed to start, `retryable: true` is safe: the input was not delivered, so sending again cannot deliver it twice.

## The sender record

Injected input is not typed by the person at the browser, so the console records who sent it and never borrows the operator's identity. **An agent's message is never recorded as the human's.**

### Initiator

`--initiator` names what started the turn. Accepted values:

| Value | Meaning |
|---|---|
| `trigger` | Input from a script, a file drop or an agent. This is the default when `--initiator` is absent. |
| `scheduled` | A scheduled input the console sent at its time (see [Scheduled input](#scheduled-input)). `send-input` accepts the value too, but only the console's own firing is recorded as the automation. |
| `scheduled-now` | A scheduled input sent early with Send now. |
| `loop` | One iteration of an automated loop. |

`human` is refused: human turns come only from the authenticated browser. Any unknown value is refused too, with the accepted list in the reason. For an agent or a script, leave `--initiator` out.

### Who sent it

Each injected message is recorded with a sender, in this order of precedence:

| `senderKind` | How the console knows |
|---|---|
| `extracted` | The caller is a process the console started, and it passed the session reference from its environment (`CLAGENTIC_CONSOLE_PROJECT`, `CLAGENTIC_CONSOLE_SESSION_ID`). The console resolves the pair in its own store and shows the sender as `<agent>@<project>` (a plain session uses its vendor, for example `claude@my-project`). Claude sessions carry the reference; Codex sessions do not. A same-user process can copy the two variables, so `extracted` is not proof against that. |
| `declared` | The caller named itself with `--from <name>` (at most 64 characters, no control characters, else `refused`). Self-reported and unverified. |
| `undeclared` | The caller named nobody. |
| `automation` | A turn the console composed itself (scheduled, run-now, loop). |
| `unrecorded` | A message whose sender the console cannot show. It renders as "sender not recorded", never as the operator. |

If both an extracted reference and `--from` apply, the extracted identity is displayed and the `--from` name is kept beside it as `declaredName`.

`--from-session <id>` names the session the message comes from, by its id at its own vendor (at most 128 characters, no control characters, else `refused`). It is self-reported and is a navigation target, never authority. When the sender is `extracted`, the id the console recorded for the sender is stored instead of the declared one.

An agent calling the verbs from inside a console session gets `extracted` for free, with no flags. Pass `--from` when the caller has no session reference (a script, a CI job) and you want it named in the chat.

The chat draws every injected message as coming from its sender, with the initiator, context note and sender kind as its label, never as the local user. For tools that read sessions, every message is also published in a per-message sender record; see "Integrating other tools" in [architecture.md](./architecture.md#integrating-other-tools).

## Named-agent sessions get their definition's tools

A session that runs a named agent hands the Claude Agent SDK the tools list from the agent's own definition: the `tools:` field in the frontmatter of the agent file (`~/.claude/agents/<name>.md`). The console names no tool itself. This applies to a new session, a resumed one and injected input into a reaped one, because every turn start builds its options from the session's agent name.

- **Field absent** (or not a JSON array): the option is unset, as for a plain session; the console restricts nothing.
- **Field present:** the agent gets the built-in tools it names. Write it as a one-line JSON array, for example `tools: ["Read", "Grep", "Glob"]`. A comma-separated list is not parsed as a list and leaves the option unset. Permission-pattern entries such as `Bash(git:*)` are reduced to the tool name (`Bash`); MCP tool names are never filtered by this list.
- **Explicit `[]`:** `tools: []` disables every built-in tool. It is a list that names no tool, not an absent field, and it is never widened to the default.
- **Codex** sessions never read it.

## External triggers (file drop)

Writers that cannot run the CLI can drop a JSON file into `~/.clagentic/console/external-triggers/` to open a session or inject a message. The file drop takes a session id only (no `--to`, `--reply` or session names). Its schema, retry rules and log lines are in [EXTERNAL-TRIGGERS.md](./EXTERNAL-TRIGGERS.md).

## Suggested allow rules

This is a suggestion only. Clagentic: Console never reads or writes your Claude Code settings: the installer does not touch them, and no verb adds a rule. Add entries to `permissions.allow` in your own Claude Code settings only if you want agents to run these verbs without a permission prompt:

```json
{
  "permissions": {
    "allow": [
      "Bash(clagentic-console list-sessions *)",
      "Bash(clagentic-console send-input *)",
      "Bash(clagentic-console open-session *)",
      "Bash(clagentic-console schedule-input create *)",
      "Bash(clagentic-console schedule-input list *)",
      "Bash(clagentic-console schedule-input delete *)"
    ]
  }
}
```

`list-sessions` and `schedule-input list` only read. `send-input` and `open-session` start work in other sessions, so allow them only where you want agents to be able to do that. `schedule-input create` does too, later: the text it schedules is sent into the session you name, which can be any session of the project, so allow it only where you would allow `send-input`. `schedule-input delete` cancels a schedule, including one a person made in the browser.

An allowed `send-input` or `open-session` lets the calling agent start work in another session, and that session may run with broader tool permissions than the caller (a different named agent, or a plain session). The rules therefore let an agent act at the target session's level. Allow them only for agents you trust to do that.

Migration: the 1.10.x installer added the `list-sessions` rule to the Claude Code settings of the installing account. Later releases stop doing so. A rule already added is left in place and is yours to keep or remove.

Passing long or multi-line prompt text inline in a Bash argument can still trigger Claude Code's own safety prompt, whatever the allow rules say. `open-session` and `send-input` have no `--prompt-file` option. They do read the prompt from stdin when you give `--prompt -`, so put long text in a file and redirect it (`schedule-input create` also takes `--prompt-file <path>`):

```bash
clagentic-console send-input --to reviewer@my-project --prompt - < message.txt
```

## Keeping this guide current

Every pull request that adds or changes an agent-facing feature updates this guide in the same change: a new verb, flag, address form, result code, sender field or session behaviour that agents can see. The pull request checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md) records the rule.
