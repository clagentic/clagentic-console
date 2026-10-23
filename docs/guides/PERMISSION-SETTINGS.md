# Permission settings

Clagentic: Console has a small set of permission settings a person can change. Each has a documented default, and every default equals the behaviour before the setting existed, so nothing changes until someone changes one.

The console never adds or removes what an agent may do: an agent brings its own permissions and the console works with them. These settings only decide when the console asks you, and which mode a session starts in.

## Contents

- [The settings at a glance](#the-settings-at-a-glance)
- [Auto-approve read-only tools](#auto-approve-read-only-tools)
- [Approve tools automatically during this loop](#approve-tools-automatically-during-this-loop)
- [Mode for sessions opened by the CLI or a trigger](#mode-for-sessions-opened-by-the-cli-or-a-trigger)
- [A session keeps its own mode](#a-session-keeps-its-own-mode)
- [Changing a default mode](#changing-a-default-mode)
- [What is not changed by these settings](#what-is-not-changed-by-these-settings)

## The settings at a glance

| Setting | Where | Default | Who may change it |
|---|---|---|---|
| Auto-approve read-only tools | Server settings, Security | On | An admin. In single-user mode, the authenticated connection. |
| Approve tools automatically during this loop | Each loop and scheduled task (the loop preview, the task's settings, the schedule form) | On | Anyone who can edit the loop or schedule. |
| Mode for sessions opened by the CLI or a trigger | Server settings, Security | Accept edits | An admin. In single-user mode, the authenticated connection. |
| `--permission-mode` on `open-session` | The CLI and the daemon IPC request | Not given: the setting above applies | The caller of that one `open-session`. |
| Apply to running sessions | The default-mode picker in Server settings and Project settings | Off, for each change | Whoever may change that default. |

The first, third and fourth rows are stored with the other server settings in `daemon.json` as `autoApproveReadOnly` and `openedSessionMode`. A value equal to its default is not written. They are read at the moment they apply, so a change needs no restart.

## Auto-approve read-only tools

**On (the default).** These run without a prompt:

- the read-only built-in tools: `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`;
- Bash commands on the console's read-only list (`lib/bash-auto-approve.js`), such as `ls`, `cat`, `grep` and `git status`, in forms that cannot write, run another program or hang. `sleep` is not on the list: it can wait forever, so it asks;
- the browser tools `browser_watch_tab` and `browser_unwatch_tab` from the console's own browser server;
- the tools of the MCP servers you enabled in project settings.

**Off.** Every item above goes to the normal permission prompt instead, for Claude and Codex sessions alike. Nothing else changes: a call that is already auto-approved by the session's mode, by an "Allow for session" answer you gave, or by your own allow rules still is, and an ask that one of your own ask rules forces is still a prompt either way.

Only an administrator can change it. A non-admin's request is refused with a message.

## Approve tools automatically during this loop

Loop and scheduled-task runs have nobody at the keyboard. By default they approve every tool call.

**On (the default, and what a loop does when its record never had the field).** The loop runs every tool without asking.

**Off.** The loop's tool calls take the normal path: the read-only list (if "Auto-approve read-only tools" is on), then a permission prompt. A prompt in a run nobody is watching waits for an answer.

The setting is stored on the loop's own record (`approveToolsAutomatically`), so a one-off loop, a recurring schedule and a re-run each keep their own. It is shown and edited in three places: the loop preview before a loop starts, the Model tab of a task in the scheduler, and the schedule form. A loop's `LOOP.json` settings do not carry it.

Either way the loop stays autonomous in two respects this setting does not touch: a question to you (`AskUserQuestion`) and entering plan mode are denied, and an MCP server's request for input is rejected.

## Mode for sessions opened by the CLI or a trigger

A session opened by `clagentic-console open-session` (or the daemon request behind it) or by a trigger file starts in this mode. The default is **Accept edits**.

The mode a session starts in is, in order:

1. the `--permission-mode <mode>` of that one `open-session` call;
2. the server setting;
3. Accept edits.

The mode names are the console's: `default`, `plan`, `acceptEdits`, `dontAsk` and `auto`. `dontAsk` and `auto` are only for an agent that declares them (Claude does; Codex does not). Every value goes through the console's one mode check for the agent the session will run on:

- A `--permission-mode` that fails the check makes the `open-session` call fail with `result: "refused"` and a reason, and no session is created.
- A stored server setting that fails it (an agent that cannot run the mode, or a setting edited by hand) is not used: the session opens in Accept edits and the daemon logs why.
- `bypassPermissions` is refused everywhere unless the server's skip-permissions option is on, which it is not by default.

A trigger file cannot name a mode; it takes the server setting.

Example:

```bash
clagentic-console open-session --project my-project --agent reviewer \
  --permission-mode plan \
  --prompt "Review the open change and propose fixes. Do not edit files."
```

An admin changes the server setting in Server settings, Security. The session keeps the mode it opened in (see below); changing the setting does not move sessions already open.

## A session keeps its own mode

Each session has its own permission mode. It is saved with the session, so a resume, a reconnect and a daemon restart all bring the session back in the mode it had.

- A new session takes the project's default mode when it is created, and that is saved.
- A session saved before modes were kept takes the project's default when the project starts, and keeps it from then on.
- A saved mode is checked when it is read. One the server does not allow (for example `bypassPermissions` written while the option was on) loads as `default`, and the daemon logs why. A mode the session's agent cannot run is replaced by `default` when the session's next turn starts.
- What you see in the mode chip, on a reconnect and after a session switch is the mode of the session you are viewing, never the project's default.

## Changing a default mode

The default-mode picker (Server settings and Project settings) sets the mode **new sessions** start in. By default it changes nothing else: sessions that are already open keep their own mode.

Beside the picker is **Apply to running sessions**, off every time. Turn it on before you pick a mode and that one change also moves the sessions the project holds. Each session is checked for its own agent; one that cannot run the mode (Don't ask or Auto on a Codex session, say) is left as it was and the result lists it with the reason. The choice is not remembered: the next change starts with it off.

The picker offers Don't ask and Auto only when the project's default agent declares them. Whoever may change the default may use Apply: an admin or the project owner for a project default; an admin for the server default.

## What is not changed by these settings

- A loop keeps its own mode source (the mode in its `LOOP.json`); these settings do not set it.
- Answering a plan prompt changes the answering session's mode only, as before.
- Nothing here lets a session do something its agent's own permissions refuse.
