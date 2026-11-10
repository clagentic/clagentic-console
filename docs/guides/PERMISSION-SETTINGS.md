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
- [What an "Allow for session" answer covers](#what-an-allow-for-session-answer-covers)
- [Commands typed with !](#commands-typed-with-)
- [A loop that turns hooks off](#a-loop-that-turns-hooks-off)
- [The browser extension adds tools](#the-browser-extension-adds-tools)
- [What is not changed by these settings](#what-is-not-changed-by-these-settings)

## The settings at a glance

| Setting | Where | Default | Who may change it |
|---|---|---|---|
| Auto-approve read-only tools | Server settings, Security | On | An admin. In single-user mode, the authenticated connection. |
| Approve tools automatically during this loop | Each loop and scheduled task (the loop preview, the task's settings, the schedule form) | On | Anyone who can edit the loop or schedule. |
| Mode for sessions opened by the CLI or a trigger | Server settings, Security | Accept edits | An admin. In single-user mode, the authenticated connection. |
| `--permission-mode` on `open-session` | The CLI and the daemon IPC request | Not given: the setting above applies | The caller of that one `open-session`. |
| Apply to running sessions | The default-mode picker in Server settings and Project settings | Off, for each change | Whoever may change that default. |
| Run commands typed with `!` | Server settings, Security | On | An admin. In single-user mode, the authenticated connection. |

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
- `bypassPermissions` is refused everywhere: the console has no setting, flag or file key that turns it on. The old `--dangerously-skip-permissions` flag was removed and now exits with a message saying so; a `dangerouslySkipPermissions` key left in `daemon.json` by an older release is ignored and dropped the next time the console rewrites the file.

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
- A saved mode is checked when it is read. One the server does not allow (for example `bypassPermissions` written by an older release or by hand) loads as `default`, and the daemon logs why. A mode the session's agent cannot run is replaced by `default` when the session's next turn starts.
- What you see in the mode chip, on a reconnect and after a session switch is the mode of the session you are viewing, never the project's default.

## Changing a default mode

The default-mode picker (Server settings and Project settings) sets the mode **new sessions** start in. By default it changes nothing else: sessions that are already open keep their own mode.

Beside the picker is **Apply to running sessions**, off every time. Turn it on before you pick a mode and that one change also moves the sessions the project holds. Each session is checked for its own agent; one that cannot run the mode (Don't ask or Auto on a Codex session, say) is left as it was and the result lists it with the reason. The choice is not remembered: the next change starts with it off.

The picker offers Don't ask and Auto only when the project's default agent declares them. Whoever may change the default may use Apply: an admin or the project owner for a project default; an admin for the server default.

## What an "Allow for session" answer covers

"Allow for session" on a permission prompt stores a grant for the whole tool, not for the one call. A grant on `Bash` covers every later `Bash` call in that session, whatever the command. The grant is kept across a daemon restart and a resume.

The way back is the list-and-revoke dialog for the session's grants: remove the tool there and the next call asks again. If you want to approve one command at a time, answer "Allow" rather than "Allow for session".

## Commands typed with !

A message that starts with `!` and has a command after it runs as a shell command in the session's folder. Its output is shown in the conversation and added to what the agent has seen, and no turn starts. The `!` line is for the person at the keyboard; nothing in it is offered to an agent.

It is checked in this order, and the first check that applies decides:

1. **The setting is off.** The message is sent as ordinary text, `!` included, and no command runs.
2. **OS-user isolation is on.** It is refused, with the reason on screen. The console has no way yet to run a command as the session owner's own account, and it never runs one as the daemon's account on a user's behalf.
3. **The session is in plan mode.** It is refused, with the reason on screen: plan mode does not run commands.
4. **The permission gate.** The command goes through the same check a `Bash` tool call goes through, so the session's mode and your allow rules decide as they do for the agent's own commands: a read-only command on the console's list runs, an "Allow for session" answer on `Bash` covers it, bypass mode runs it, and otherwise the permission prompt opens and the command runs only if you approve it. The console's gate does not treat Accept edits specially for `Bash`, so a command typed with `!` asks in that mode too; any shortcut the agent's own CLI applies in Accept edits happens before this gate and does not apply to the `!` line.

A command also needs the agent to be idle and to have a live process (send a message first in a brand-new session), and in a multi-user server the user needs the terminal permission. A refusal is shown to the person who typed it, nothing runs, and the line goes back into an empty composer.

**Limits.** A command is stopped after **10 minutes** and keeps at most **256 KiB** of output; past the cap the output ends with `[output truncated at N bytes]`, and a timed-out command says so. Stopping the agent while a command runs (the stop button) stops the command too. Both limits are `daemon.json` settings, `userShellTimeoutMinutes` (1 to 1440) and `userShellMaxOutputKiB` (1 to 4096), and an admin can change them and the switch with `set_user_shell_settings`; a value equal to its default is not written. They are read each time a command is sent.

**What it is not.** The command is not sandboxed: it runs with the account the console runs as, in the session's folder, as it would in a terminal there. The gate is the only check, which is why a permission prompt for it is the same prompt the agent's own command would get.

## A loop that turns hooks off

A loop's `LOOP.json` may carry `settings.disableAllHooks`. When it is on, the loop's agent runs with hooks off, and that is not limited to hooks the loop brought: it also turns off your own hooks, including `PreToolUse` guard hooks that block or confirm tool calls. A guard you rely on does not run for that loop's tool calls.

The console keeps the setting as the loop's author wrote it. Wherever a loop's settings are shown with `disableAllHooks` on (the Model tab of a task in the scheduler, and the loop preview), a notice says so. Nothing else changes.

## The browser extension adds tools

The console's browser tools are offered to Claude sessions only while the browser extension is connected. Connecting the extension is the opt-in: it adds those tools to the Claude sessions the console runs, and there is no separate setting for it. The two watch tools are on the read-only list (see "Auto-approve read-only tools"). The grants described above apply to these tools like any other.

## What is not changed by these settings

- A loop keeps its own mode source (the mode in its `LOOP.json`); these settings do not set it.
- Answering a plan prompt changes the answering session's mode only, as before.
- Nothing here lets a session do something its agent's own permissions refuse.
