# Running Claude on Bedrock, Vertex or Foundry host-wide

This page is for administrators. It explains how to point every Claude Code session on a Clagentic: Console host at Amazon Bedrock, Google Vertex AI or Microsoft Foundry by saving the provider's environment variables once, in Settings.

## How it works

Settings keeps a shared environment text that an administrator edits (Settings, Environment). Every Claude runtime the console starts is given the daemon's own environment with that text laid over it, so a variable saved there reaches every project and every user. Claude Code selects its provider from its environment, so the shared text is enough to move all Claude sessions onto a provider. The text is read each time a runtime starts: a change applies to sessions started after you save it, and a runtime already running keeps the environment it started with.

## Set it up

Save the variables for one provider in the shared environment.

| Provider | Selecting variable | Credentials it needs |
|---|---|---|
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | `AWS_REGION`, and one of `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`, or `AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE` |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | `ANTHROPIC_VERTEX_PROJECT_ID`, a region variable, and `GOOGLE_APPLICATION_CREDENTIALS` |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `ANTHROPIC_FOUNDRY_API_KEY`, and `ANTHROPIC_FOUNDRY_RESOURCE` or `ANTHROPIC_FOUNDRY_BASE_URL` |

A credential that is a profile name or a file path is resolved on the host, as the account the Claude runtime runs as. Put the file or profile where that account can read it.

The console does not need a Claude sign-in for these sessions and does not offer one.

## What the console does differently

- **Sign-in checks read the same environment the session runs with.** A provider chosen only in Settings counts, the same as one set in the daemon's environment.
- **A rejected credential is reported as the provider's.** If a session on a configured provider fails with an authentication error, the message names the provider and says its credentials failed. It does not say Claude Code is not logged in and offers no login.
- **Some controls are turned off, with the reason beside them.** On Bedrock, web search is unavailable. When `ANTHROPIC_BASE_URL` points at anything other than the first-party service, MCP tool search and Remote Control are unavailable. The decision is made from the environment the session starts with.

## A variable in the Claude settings file wins

Claude Code applies the `env` block of its own settings file (`settings.json` in the Claude configuration directory) to its environment after it receives the environment the console built. For a name set in both places, the settings file's value is the one the session sees, and the value saved in Settings has no effect. The environment editors list any variable that you save and that the settings file also sets. Remove it from one of the two places. The sign-in status and the capability limits (for example no web search on Bedrock) are decided from the same result, so a provider flag the settings file turns off or on counts as the settings file says.

The editors check the settings file of the account the daemon runs as. With per-user OS isolation a runtime reads its own user's settings file, which the editors cannot see.

### Which settings file the console reads

The console reads the settings file itself only to decide the sign-in status, the provider name and the capability limits, and to warn about overlapping names (key names only; no value leaves the process). `CLAUDE_CONFIG_DIR` picks the directory, as it does for Claude Code. The directory must be an absolute path with no `..` segment.

- A `CLAUDE_CONFIG_DIR` in the daemon's own environment or in the administrator-shared Settings environment is always used.
- A `CLAUDE_CONFIG_DIR` in a project's environment text is used only on a single-user host, or for a session an administrator owns. For anyone else the console ignores it for these decisions and reads the file from the directory the daemon and the shared Settings name (Claude Code itself still honours it in the session).
- With per-user OS accounts (`os-users` mode), the session runs as another account and the console never reads a settings file for it. The overlap warning is off, and the sign-in status and capability limits are decided from the composed environment without the file. A provider selected only in a user's own settings file is therefore not seen by the console there; select it in the shared Settings environment instead.

## Isolation: who can read what you save

- The shared text is stored as plaintext in the daemon's configuration. Treat every value in it as readable by anyone who can read that file.
- Only administrators can read or change it in Settings.
- Without per-user OS isolation (os-users), every session runs under the daemon's own account. Any user's agent can therefore read the shared values, including the provider credentials, from its own environment.
- With os-users, each user's runtime runs as that user and the shared text is still given to every runtime. The credentials are still host-wide, and still reach every user.

Use this only when one set of provider credentials for the whole host is what you want. Prefer short-lived or role-based credentials (a profile, a web identity token file) over long-lived keys.

## Codex

Codex is a separate agent and does not read the Claude provider variables. Codex can use Amazon Bedrock through its own built-in `amazon-bedrock` provider, which is selected in the user's own Codex configuration file, `~/.codex/config.toml`, not in Clagentic: Console. Variables Codex needs for that provider (for example `AWS_REGION`) can come from the shared environment, because the shared text reaches Codex runtimes too.

Codex is unavailable when os-users is on. The console does not start it in that mode.
