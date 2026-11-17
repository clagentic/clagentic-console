# Security architecture and mode matrix

This is the up-front security design document for Clagentic: Console. It describes what the console protects today, what it shares, and who can see what, for each mode it runs in. It states the current behaviour. Where the intended state is not the current one, the section says so and names the task that tracks it.

Target reader: an operator of a small trusted team on one host, who may grow the team and needs to know where the boundaries are before they rely on them. The design goal for isolation between users is full independence. This document states where today's modes stand against that goal; for the shared-account mode the answer is "not independent", and the text says why.

## 1. Authentication as it is

There is one account system. A running daemon is always multi-user: startup migrates an older single-user install and forces multi-user mode. Accounts live in `users.json` in the console config directory, written owner-only.

- **Local account.** A username and a 6-digit PIN. The PIN is stored as a salted scrypt hash. A user created by an admin gets a generated temporary PIN and a `mustChangePin` flag. The flag is reported to the browser, which shows a change overlay; no server route refuses other requests while it is set.
- **Emailed code.** When SMTP is configured and email login is switched on, a user signs in with a one-time code sent to their address instead of a PIN. A code is valid for 10 minutes, allows 3 attempts, and one code is issued per address per minute.
- **Session cookie.** Every sign-in ends in one function that issues the session: a random token stored server-side with a 30-day lifetime, delivered as an `HttpOnly`, `SameSite=Lax` cookie. The cookie's own `Max-Age` is one year; the server-side lifetime is what ends the session. The cookie carries `Secure` when the daemon terminates TLS itself, and also when the console is behind a trusted proxy (`trustedProxy` in `daemon.json`) that reports `X-Forwarded-Proto: https`. Sign-out deletes the server-side token and clears the cookie; it does not touch an external identity provider.
- **WebSocket tickets.** A WebSocket upgrade is authenticated by the session cookie. A phone browser does not reliably attach that cookie to a script-opened socket, so an authenticated request can fetch a ticket: an opaque value bound to the user, valid for 30 seconds and single use, offered in the `Sec-WebSocket-Protocol` header. The ticket is never the session token.
- **Lockout.** Failed PIN and code attempts are counted per client address (5 failures lock the address for 15 minutes) and per username (backoff of 1 s, 5 s, 30 s, 5 min, then a lockout with no timeout). The counters are in memory. A username lockout lasts until the daemon restarts; no route unlocks it. The address is the socket address, or the forwarded address only when `trustedProxy` is set.
- **First-time setup.** On a console with no admin, a one-time setup code (shown by the CLI) lets the first admin choose a username and PIN at `/auth/setup`. The route checks the code and nothing else.
- **Invites.** An admin creates an invite link (24 hours, single use) or emails one. `/auth/register` takes the invite code, a username and a PIN (or an email, in email-login mode) and creates a user with the `user` role. An invite may carry a target email address; registration does not compare it with what the registrant submits. `/auth/setup` and `/auth/register` have no rate limit.
- **Recovery.** An operator at the host can run the CLI recovery menu, which tells the daemon (over the local socket) to open a one-time recovery page at a secret path with a one-time password. The page resets the admin PIN and then closes. The password check is rate limited per address.
- **External sign-in (shipped).** See section 6.

The pre-auth request bodies (`/auth/*`, recovery, push subscribe) are read through one capped reader; the default cap is 1 MB.

## 2. Roles and permissions

Two roles: `admin` and `user`.

An admin has every permission and can see and change every project. A user has eight per-user permissions, set by an admin. Defaults for a new user:

| Permission | Default |
|---|---|
| Terminal | off |
| File browser | on |
| Create projects | on |
| Delete projects | off |
| Skills | on |
| Delete sessions | off |
| Scheduled tasks | off |
| Project settings | off |

When OS-level isolation is on and a user is mapped to a Linux account, that user is exempt from these permissions (the operating system is expected to do the separating).

**Project access.** A project has an owner, a visibility and an allowed-users list. A project with no visibility is private; only an explicit `public` opens it to every signed-in user. Access is granted to the owner, to listed users, and to admins. One resolver answers every access question, and an answer that cannot be given is a refusal. Authentication is proven separately from principal resolution, so a route that forgets its login check refuses.

**Session access.** A session has an owner and a visibility. New sessions default to `shared`: any user with access to the project can see and type into the session. A `private` session is visible only to its owner. A session with no owner (opened by the local socket, a trigger file or a loop) is visible only to admins through the session access rule.

**What only admins do.** User management, invites, SMTP, external sign-in settings, project ownership and visibility, the global Claude instructions, and the shared environment variables.

## 3. Mode matrix

The console runs in one of two modes. Which one is set by whether OS-level isolation (`osUsers`) is on. Columns say who can read and who can act. "Daemon account" is the operating-system account the daemon runs as; in the OS-level mode it is root.

| Asset | Shared-account mode (default) | OS-level mode (`osUsers`) |
|---|---|---|
| **Project files** | Read and write by the daemon account. Other users: through the console, limited by project access rules only. Admin: every project. | Each user's agent, terminal and file browser run as that user's Linux account; an ACL on the project directory grants the owner's account access. The kernel enforces it, so another user's agent cannot read the files. Daemon account: all. Admin: every project in the console. |
| **Sessions and transcripts** | One store in the console config directory, for all users. Other users: per the session rule (shared by default, private on request). Admin: all projects; private sessions are not exempted by the session rule. Daemon account: all files. | Same store, same rule. A shared session's turn runs as the session owner's account and Claude login, whoever types. A session with no owner runs as the daemon account. |
| **Claude credentials** | One login, the daemon account's own Claude directory, used by every user's sessions. Other users with the file browser can read that directory through the plan-file preview. | Each user has their own Linux home and their own Claude login. The file browser's plan-file preview path check also admits the daemon account's Claude directory; the read itself is made as the user's account, so the operating system decides. |
| **Terminals** | Needs the Terminal permission (off by default for users). Runs as the daemon account. Another user: no access to an owned terminal. Admin: access. | Runs as the user's Linux account. Same ownership rule. |
| **Settings environment variables** | Admin-only to read and write. The saved variables are added to every runtime started afterwards, for every user. | Same: shared variables reach every user's runtime. |
| **Direct messages** | Any signed-in user can open a direct message to any other user, and adding a favourite returns the list of every user. Admin: same. | Same. |
| **Logs** | In the console config directory (owner-only directory). Other users: no access through the console. Admin: the tail of the audit log of privileged actions, through the admin API. Daemon account: all. | Same. |
| **The config directory** | Owner-only (mode 0700), holds `users.json`, tokens, sessions, direct messages, push subscriptions, logs and the local socket. Daemon account only. | Same. One directory holds every user's data, owned by the daemon account. |

Reading the matrix against the goal of full independence: shared-account mode separates users only by the console's own rules. They share one account, one Claude login, one file system identity and one set of logs. OS-level mode separates the files, the processes and the Claude login of one user from another, and does not separate the sessions store, direct messages, shared environment variables or the daemon account. Neither mode separates users from the host admin or the daemon account.

## 4. Trust boundaries

- **The daemon account.** It can read everything the console stores and acts for every user in shared-account mode. In OS-level mode it must be root. Anyone who can run commands as it owns the console.
- **The local socket.** The CLI talks to the daemon over a Unix socket in the console config directory. The directory is owner-only, so the daemon account is the only one that can connect. There is no per-command check; the socket is how the CLI opens sessions, sends input, ends sessions and enables recovery.
- **The MCP bridge.** The built-in MCP server's helper process cannot carry a login cookie. Its request is admitted by a per-project credential in a header, derived from a random secret held in memory, compared in constant time. The peer address grants nothing.
- **External triggers.** A trigger file dropped in the triggers directory can open a session or send input. The directory is inside the owner-only config directory; the writer must be the daemon's account. Injected input is never recorded as a human turn.
- **The trusted-proxy setting.** `trustedProxy` is one boolean. When set, the console reads the forwarded client address, protocol and host from the proxy. A multi-valued forwarding header is refused rather than guessed, because one boolean cannot say which hop to trust. The WebSocket origin check compares the origin's host with the request host (or the forwarded host when `trustedProxy` is set) or an entry of `allowedOrigins`.
- **Endpoints that need no login.** The sign-in routes (`/auth/*`, including the external sign-in routes), the invite page, the recovery page while enabled, the setup and install guide pages, the push public key, the push subscribe endpoint (it stores a subscription only for a signed-in user), a liveness health check (full detail needs a login), the theme list, the CA download when a CA is configured, and the static shell assets. Everything under a project and every WebSocket needs a session or a ticket.

## 5. Tool-permission boundary and the pre-auth surface

State at the time of writing.

- **Claude.** While the admin setting `autoApproveReadOnly` is on (the default), a Bash call is approved without a prompt only when every segment of it is a command on a read-only allowlist with a per-command option allowlist. Redirection, command substitution, a leading `sudo` and environment assignments send the call to the permission prompt. The permission mode of a session opened from outside the browser is the admin setting `openedSessionMode`, `acceptEdits` by default.
- **Codex.** The default approval policy is `on-request` and the default sandbox is `workspace-write`. A session set to the `allow-all` tool policy runs with approval `never`; the sandbox stays at its setting unless a user chooses `danger-full-access` for the session. Codex is not run in OS-level mode.
- **Pre-auth.** The unauthenticated POST routes read their bodies through a capped reader (1 MB). Sign-in attempts are rate limited by address, except setup and register (section 1). The external sign-in start route makes the daemon call the identity provider's discovery document; a failed lookup is cached for 10 seconds so the route cannot be used to make the daemon call the provider on every request.
- **Availability.** A fault on one client's WebSocket is logged and that socket is dropped; it does not reach the daemon's top-level handler.

## 6. Sign-on paths

**Shipped: external sign-in with OpenID Connect.** Off by default. An admin sets an issuer, a client id, a client secret and the identity allowed to sign in (the subject the provider assigns). While it is on:

- The console has exactly one user, bound to that identity. The binding is provider kind, issuer and subject; an email address is never used to match.
- Every path that adds a user or an invite is refused with a stated reason: invite links, emailed invites, registration (an invite issued earlier does not help), admin create user, and setup.
- Turning it on is refused when the console has more than one user. Nothing is removed or changed automatically.
- Sign-in is the authorization code flow with PKCE (S256), state bound to the browser by a short-lived cookie, a nonce, and provider metadata from discovery. The ID token is verified against the provider's published keys: signature, issuer, audience, expiry, issued-at, nonce. Asymmetric algorithms only.
- The result is the same session as a local sign-in, so the cookie, the phone app and the WebSocket ticket path are unchanged. Sign-out ends the console session only.
- The local PIN or emailed-code sign-in of the one user stays available as a fallback unless the admin switches it off. If the provider cannot be reached and the fallback is off, the login page says so and nobody can sign in until the provider is back or the settings file is changed on the host.
- The client secret is stored in its own owner-only file in the console config directory, outside `daemon.json`. It is never returned by the settings API, logged, or written to a session file.

The provider-neutral rules (the one-user rule, the refusals, the fallback, the identity on the user record) are separate from the OIDC step, so another provider needs only its own sign-in step and settings.

**Direction, not shipped.**

- **SAML** is not built into the console. A SAML-only organisation puts a broker that converts SAML to OpenID Connect in front, and the console speaks OpenID Connect to the broker.
- **A trusted proxy that asserts the user** is a possible second provider on the same seam, and only with a signed assertion that the console verifies. A bare username header is not acceptable.

## 7. Known limits

Each limit is stated as it is now.

| Limit | Tracked |
|---|---|
| OS-level mode: the Codex app-server would run as the daemon account with the full daemon environment, so Codex is refused in this mode. Spawns under another account also drop supplementary groups. | lr-8212d6 |
| OS-level mode: identity delivered to a session that runs as another account is not available, because the delivery directory is inside the owner-only config directory. | lr-fced5f |
| New sessions default to shared; any member of a project can type into a shared session, and in OS-level mode the turn runs as the owner's account and Claude login. | awaits the isolation design decision |
| Sessions with no owner run as the daemon account and are visible only to admins. | awaits the isolation design decision |
| One owner-only directory holds every user's sessions, direct messages, tokens, push subscriptions, logs and MCP configuration. | awaits the isolation design decision |
| Direct messages and the user list are open to every signed-in user. | awaits the isolation design decision |
| Shared environment variables reach every user's runtime. | awaits the isolation design decision |
| The Claude worker's socket in the temp directory is world-accessible by mode. | awaits the isolation design decision |
| The file browser's plan-file preview path check admits the daemon account's Claude directory in both modes; in shared-account mode the read is made by the daemon account. | awaits the isolation design decision |
| A username lockout has no timeout and no unlock route; it ends when the daemon restarts. Setup and register are not rate limited. | lr-7b658d |
| `mustChangePin` is advisory: it is shown to the client and not enforced by the server. | lr-f59a7c |
| Neither mode separates users from the daemon account or the host admin. | design limit |

## 8. Not covered yet

An isolated mode (sharing surfaces removed instead of defaulted) and one console instance per user behind a front that does sign-in are not described here. They get their own columns after the isolation design decision is made.
