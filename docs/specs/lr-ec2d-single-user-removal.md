# lr-ec2d: Remove Single-User Mode — Implementation Spec

Remove single-user mode entirely from clagentic-console. The system always runs in
multi-user mode after this change. Existing single-user installs migrate automatically
at daemon startup.

**Total branch count:** 198 occurrences of `isMultiUser`/`multiUser`/`single.user`
across: `users-auth.js`, `users.js`, `server-auth.js`, `server-settings.js`,
`server-admin.js`, `server.js`, `server-palette.js`, `server-dm.js`,
`server-skills.js`, `sessions.js`, `project.js`, `project-connection.js`,
`project-sessions.js`, `project-user-message.js`, `project-loop.js`,
`project-notifications.js`, `sdk-bridge.js`, `sdk-message-processor.js`,
`terminal-manager.js`, `push.js`, `daemon.js`, and frontend modules.

---

## Section 1: Migration Algorithm (Daemon Startup)

**When to run:** Early in `lib/daemon.js`, immediately after config is loaded and before
`createServer()` — roughly where the existing single-user migration hint comment sits
at line 112.

**Detection:**

```
data = loadUsers()
if data.multiUser === false:
    runMigration(data, config)
```

### Case A — PIN exists, no user records (`data.users.length === 0`)

The PIN belongs to the implicit single admin. Create an admin user but do NOT transfer
the pinHash — the two hash formats are incompatible (see Section 7, risk 1).

```
1. data.multiUser = true
2. adminUser = {
     id: generateUserId(),
     username: "admin",
     email: null,
     displayName: "Admin",
     pinHash: null,
     role: "admin",
     createdAt: Date.now(),
     mustChangePin: false,
     linuxUser: null,
     profile: { name: "Admin", lang: "en-US", avatarColor: "#7c3aed",
                avatarStyle: "thumbs", avatarSeed: <random 4-byte hex> }
   }
3. data.users = [adminUser]   (pinHash: null — set via /auth/setup)
4. data.setupCode = generateSetupCode()
5. saveUsers(data) synchronously via fs.writeFileSync + atomic rename
6. Log to console (prominent banner — not a single line):
     "┌─────────────────────────────────────────────────────────┐"
     "│  Clagentic: Console — one-time upgrade step required    │"
     "│                                                         │"
     "│  Your install has been migrated to multi-user mode.     │"
     "│  Open this URL to set your admin PIN:                   │"
     "│                                                         │"
     "│  http://localhost:<port>/auth/setup?setupCode=<code>    │"
     "│                                                         │"
     "│  Setup code also stored in ~/.clagentic/users.json      │"
     "└─────────────────────────────────────────────────────────┘"
```

### Case B — PIN exists AND users array has entries but `multiUser: false`

```
1. data.multiUser = true
2. if findAdmin(data) exists: flip flag and save (done)
3. if no admin exists: generate setupCode, save, log (same as Case A but
   do not overwrite existing users)
```

### Case C — No PIN, no users (fresh install)

```
1. data.multiUser = true
2. data.setupCode = generateSetupCode()
3. data.users = []
4. saveUsers(data) synchronously
5. Log setup code to console as above
```

### Idempotency

- If `data.multiUser === true`: skip migration entirely. No file write, no log.
- Running migration twice on the same data is safe — the second run is a no-op.

### Synchronous write requirement

Use `fs.writeFileSync` with atomic rename (`users.json.tmp.{pid}` → `users.json`,
chmod 0o600). No connections accepted until `createServer()` returns, which happens
after migration completes.

### Implementation location

Add `function migrateSingleUserToMultiUser(config, usersData)` in `lib/daemon.js`.
This is a startup concern, not a user-management concern — keep it out of `users.js`.

---

## Section 2: Code Removals — File by File

### 2.1 `lib/users-auth.js`

- **`isMultiUser()`** (lines 10–13): Delete function and export.
- **`enableMultiUser()`** (lines 15–34): Delete. Migration in daemon.js replaces it.
- **`disableMultiUser()`** (lines 36–41): Delete.
- **`getSetupCode()` / `clearSetupCode()` / `validateSetupCode()`** (lines 55–78): Retain — still used in admin setup flow.
- **Exports** (lines 155–168): Remove `isMultiUser`, `enableMultiUser`, `disableMultiUser`.

### 2.2 `lib/users.js`

- **`defaultData()`** (line 17): Change `multiUser: false` → `multiUser: true`.
- **`loadUsers()` normalization** (line 38): Change `data.multiUser = false` fallback → `data.multiUser = true`.
- **Aliases** (lines 375–377): Remove `isMultiUser`, `enableMultiUser`, `disableMultiUser`.
- **`module.exports`** (lines 417–419): Remove those three from exports.

### 2.3 `lib/server-auth.js`

- **`POST /auth` handler** (lines 427–467): Delete entirely. This is the single-user PIN endpoint. Also delete dead code it relied on: `authToken` variable, `generateAuthToken()`, `verifyPin()` (lines 15–35).
- **`getAuthPage()`** (lines 343–348): Collapse to:
  ```js
  function getAuthPage() {
    if (!users.hasAdmin()) return adminSetupPage;
    if (smtp.isEmailLoginEnabled()) return smtpLoginPage;
    return loginPage;
  }
  ```
  Delete `pinPage` variable (line 338), `isAuthed()` (lines 49–53), `setAuthToken()` (lines 355–357).
- **`isRequestAuthed()`** (lines 350–353): Collapse to `return isMultiUserAuthed(req);`.
- **`/auth/setup` handler**: Remove the `!users.isMultiUser()` guard returning 400.
- **`/auth/login` handler**: Remove the `!users.isMultiUser()` guard.
- **`/auth/request-otp`**: Remove `!users.isMultiUser()` from condition.
- **`/auth/verify-otp`**: Same.
- **`/auth/register`**: Remove `!users.isMultiUser()` guard.
- **`/auth/logout`**: Remove single-user else branch. Always use cookie-clear path.
- **`/invite/` handler**: Remove `!users.isMultiUser()` 404 guard.
- **`attachAuth(ctx)`**: Remove `var authToken = ctx.pinHash || null;`, `onUpgradePin` from destructuring and return object.
- **Return object**: Remove `setAuthToken` from exports.

### 2.4 `lib/server-settings.js`

- **`GET /api/profile`** (lines 17–70): Multi-user branch (lines 18–36) becomes unconditional. Delete else block (lines 37–69) reading from `profile.json` and `opts.onGetDaemonConfig`.
- **`PUT /api/profile`** (lines 72–120): Remove else block (lines 101–115) writing to `profile.json`.
- **`POST /api/avatar`** (lines 122–186): Remove else block (lines 162–168) using `isRequestAuthed`.
- **`PUT /api/user/pin`** (lines 218–272): Remove single-user 404 guard at lines 220–224.
- **`PUT /api/user/auto-continue`** (lines 274–326): Remove `!isMultiUser` branch (lines 278–301). Remove `isMultiUser` variable.
- **`PUT /api/user/chat-layout`** (lines 328–381): Same — remove `!isMultiUser` branch.
- **`PUT /api/user/theme-mode`** (lines 383–425): Remove `!isMultiUser` auth check and handler branch.
- **`PUT /api/user/theme-brand`**: Same pattern.
- **All remaining `isMultiUser` branches** (lines 473–558): Remove `!isMultiUser` short-circuit paths; retain multi-user paths as unconditional.
- **`POST /api/settings/enable-multiuser`** (lines 562–593): Delete entire endpoint.

### 2.5 `lib/server-admin.js`

All `if (!users.isMultiUser()) { return 404 }` guards at lines 29, 57, 102, 169,
217, 253, 289, 311, 329, 359, 401, 425, 491, 546, 599, 651, 704, 737: delete each.
Endpoints are now unconditionally active.

### 2.6 `lib/server.js`

- **`/api/me`** (lines 501–519): Remove single-user branch (lines 502–507). Remove `singleUserMigrationAvailable` field from response.
- **Root redirect** (lines 525–574): `var reqUser = users.isMultiUser() ? getMultiUserFromReq(req) : null;` → `var reqUser = getMultiUserFromReq(req);`. Remove `isMultiUser()` check before `noProjectsPageHtml`.
- **Project HTTP handler** (lines 657–677): Remove `users.isMultiUser() &&` from access-check conditions.
- **WebSocket upgrade** (lines 810–827): Remove `if (users.isMultiUser())` wrapper — `wsUser` always fetched.
- **`broadcastPresenceChange()`** (lines 1246–1254): Remove `!users.isMultiUser()` branch. Always use per-user filtered send.
- **`createServer` opts**: Remove `isMultiUser: function () { return users.isMultiUser(); }` and `pinHash` parameter. Remove dead callbacks `onGetDaemonConfig`, `onSetAutoContinue`, `onSetChatLayout`, `onSetThemeMode`, `onSetThemeBrand` (consumed only in single-user settings paths, now deleted).

### 2.7 `lib/project.js`

- Line 163: `var dangerouslySkipPermissions = dangerouslySkipPermissionsConfigured && !usersModule.isMultiUser();` → `var dangerouslySkipPermissions = false;`
- Line 651: `isMultiUser: usersModule.isMultiUser()` → `isMultiUser: true`
- Line 652: `broadcastTermList: usersModule.isMultiUser() ? broadcastTermListToAll : null` → `broadcastTermList: broadcastTermListToAll`
- Line 876: Delete `if (!usersModule.isMultiUser()) return;` guard.
- Lines 345, 425, 587, 1282: Remove each `usersModule.isMultiUser()` condition wrapper.

### 2.8 `lib/project-connection.js`

- Lines 76–80: Remove the `else if (!usersModule.isMultiUser() && active.ownerId) active = null;` arm. Keep multi-user access check as unconditional.
- Lines 124–129: Remove `else if (!usersModule.isMultiUser())` arm filtering sessions with `ownerId`.
- Line 179: Remove `if (wsUser && usersModule.isMultiUser())` wrapper — always assign `ownerId`.
- Line 187: Remove `if (!active.ownerId && wsUser && usersModule.isMultiUser())` wrapper.

### 2.9 `lib/sessions.js`

- **`singleUserUnread`** (line 28): Delete the variable.
- **`mapSessionForClient()`** (line 343): `var unreadMap = wsUnread || singleUserUnread;` → `var unreadMap = wsUnread || {};`
- **`getVisibleSessions()`** (lines 362–371): Remove `!multiUser` branch. Delete `multiUser` variable and `users.isMultiUser()` call.
- **`switchSession()`** (lines 554–580): Remove else branch (lines 573–580) blocking access to sessions with `ownerId` in single-user mode.
- Lines 594–595, 657, 704: Delete all `singleUserUnread` tracking.
- Line 814–817: Delete else-if branch using `singleUserUnread`.
- Line 1104: `var unreadMap = ws && ws._clayUnread ? ws._clayUnread : singleUserUnread;` → `var unreadMap = (ws && ws._clayUnread) ? ws._clayUnread : {};`

### 2.10 `lib/project-sessions.js`

All `usersModule.isMultiUser()` conditions (lines 135, 160, 267, 286, 298, 311, 328,
483, 583, 647, 1099, 1599): collapse — remove the guard, guarded block always executes.

- Line 1099: `if (!usersModule.isMultiUser() || !ws._clayUser) return true;` → `if (!ws._clayUser) return true;`
- Line 583: `if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;` → `if (!ws._clayUser || ws._clayUser.role !== "admin") return true;`
- Line 647: Same as 583.

### 2.11 `lib/project-user-message.js`

- Line 78: Remove `if (usersModule.isMultiUser())` wrapper in `broadcastTermList()` — always use per-client filtered send.
- Line 317: Remove `&& usersModule.isMultiUser()` from ownerId assignment condition.

### 2.12 `lib/project-loop.js`

- Line 728: Remove `usersModule.isMultiUser() &&` — always use user-targeted push when owner is set.

### 2.13 `lib/sdk-bridge.js` and `lib/sdk-message-processor.js`

- Lines 456, 712, 336, 564: Remove `usersModule.isMultiUser() &&` from push conditions.
- Lines 918, 1216, 517: `var canAutoLogin = !usersModule.isMultiUser() || !!authLinuxUser || (authUser && authUser.role === "admin");` → `var canAutoLogin = !!authLinuxUser || (authUser && authUser.role === "admin");`

### 2.14 `lib/terminal-manager.js`

- `isMultiUser` passed as option from `project.js` (handled in 2.7 as `isMultiUser: true`).
- Line 36: Delete `if (!isMultiUser) return true;`
- Line 40: Update comment from "single-user compat" to "system context, allow".

### 2.15 `lib/project-notifications.js`

- Caller in `project.js` passes `ctx.isMultiUser` — update to pass `function () { return true; }`.
- Line 214: `if (isMultiUser()) return;` → delete entire reminder timer init block (lines 209–224). In multi-user mode the reminder never fires.

### 2.16 `lib/server-palette.js`

- Lines 13, 37, 73: Remove `if (users.isMultiUser())` conditions — always use multi-user filtering.

### 2.17 `lib/server-dm.js` and `lib/server-skills.js`

- `server-dm.js` line 19: Remove `if (users.isMultiUser())` guard.
- `server-skills.js` line 165: Remove guard.

### 2.18 `lib/daemon.js`

- Lines 112–118: Delete existing single-user migration hint block.
- Add `migrateSingleUserToMultiUser(config, usersData)` call after `usersModule` loads, before `createServer()`.
- Remove `pinHash: config.pinHash || null` from `createServer` call.

### 2.19 `lib/pages.js`

- Delete `pinPageHtml()` function (single-user PIN login page).
- Verify `setupPageHtml()` callers — if only single-user paths, delete.
- Remove deleted functions from exports.

---

## Section 3: Frontend Changes

### 3.1 `lib/public/app.js`

- Line 272: `isMultiUserMode: false` → `isMultiUserMode: true` (removes flash of single-user UI on load).
- Lines 748–762 (`/api/me` callback): Remove `if (d.multiUser)` branch — always set `isMultiUserMode: true` and add `is-multi-user` class. Delete single-user `!isMultiUserMode` block (lines 755–761).
- Line 793: `if (store.get('isMultiUserMode') && !isAdmin)` → `if (!isAdmin)`.

### 3.2 `lib/public/modules/admin.js`

- Lines 106–137: Delete `enableMultiUserMode()` function.
- Lines 152–158: Delete migration callout block in `renderUsersTab()` (`singleUserMigrationAvailable` check and `<div class="migration-callout">`).
- Lines 200–201: Delete `#migrate-to-multiuser-btn` click handler.
- Line 88: `return data.multiUser && data.user && data.user.role === "admin";` → `return data.user && data.user.role === "admin";`

### 3.3 `lib/public/modules/user-settings.js`

- Lines 383–385: Remove `accountNav.style.display = data.username ? '' : 'none'` single-user guard. Account section always visible.

### 3.4 Other frontend modules (lower-priority cleanup)

The following `isMultiUserMode` guards are already correct once the server always
returns `multiUser: true` from `/api/me`. Clean up as follow-on:

- `app-messages.js` lines 230, 243: Remove `isMultiUserMode` check.
- `sidebar-projects.js` line 477: Same.
- `sidebar-sessions.js` lines 652, 1144: Same.
- `app-rendering.js` lines 487–488: Always take multi-user branch.
- `project-settings.js` lines 434–435: Same.
- `sidebar-mobile.js` lines 451–452: Same.
- `app-cursors.js` lines 203, 221, 446: Remove `isMultiUserMode` guard.

---

## Section 4: Test Coverage

### 4.1 Existing tests to update

In `test/security.test.js`:

- `"terminal manager: single-user mode allows any ws to attach"` → Rewrite as `"terminal manager: unauthenticated caller is allowed (system context)"`. Pass `isMultiUser: true`, test that caller with no `_clayUser` is authorized.
- Lines 402–427: `routePush` test asserting single-user uses broadcast → Rewrite to test multi-user user-targeted path only.
- Lines 439–465: `dangerouslySkipPermissions` test asserting `!isMultiUser` enables the flag → Assert `computeFlag(true, true) === false` (always disabled). Remove single-user cases.
- Lines 345–384: Terminal list filtering test asserting unauthenticated client sees all sessions → Rewrite to reflect unauthenticated callers get no sessions in multi-user mode.

### 4.2 New test file: `test/single-user-migration.test.js`

1. **Case A — PIN set, no users:**
   - Input: `{ multiUser: false, users: [] }`, config with `pinHash` set
   - Assert: `multiUser === true`, one admin user with `role: "admin"`, `pinHash: null`, `setupCode` non-null

2. **Case B — PIN set, users present, no admin:**
   - Input: `{ multiUser: false, users: [{role: "user", ...}] }`, config with `pinHash`
   - Assert: `multiUser === true`, existing user preserved, `setupCode` non-null, no new user added

3. **Case C — No PIN, no users:**
   - Input: `{ multiUser: false, users: [] }`, no `pinHash`
   - Assert: `multiUser === true`, `setupCode` non-null, `users === []`

4. **Idempotency — already migrated:**
   - Input: `{ multiUser: true, users: [{role: "admin", ...}] }`
   - Assert: no changes, `setupCode` not regenerated, no file write

5. **Idempotency — migration run twice:**
   - Run Case A migration, then run again
   - Assert: `setupCode` unchanged, admin user unchanged

6. **Atomic write:**
   - After migration, a subsequent `loadUsers()` call returns `multiUser: true`
   - No async flush needed

---

## Section 5: Data Safety Constraints

1. **No PIN data is lost — but it cannot be transferred.** `config.pinHash` uses
   `scryptSync("clay:" + pin, ...)`. `users.hashPin()` uses `scryptSync(pin, ...)`.
   These are incompatible. The migration creates admin with `pinHash: null` and
   generates a `setupCode`. Admin sets a new PIN at `/auth/setup`. Document clearly
   in migration log output.

2. **Synchronous write before connections.** Atomic write with `fs.writeFileSync` +
   rename. No connections accepted until after migration completes.

3. **`setupCode` is temporary.** Cleared by `users.clearSetupCode()` when admin
   completes `/auth/setup` (existing behavior unchanged).

4. **In-app messaging at `/auth/setup`.** When a `setupCode` is present AND the
   migration flag is detectable (e.g. admin user has `pinHash: null`), the setup
   page must show a clear explanation — not just a blank PIN form. Suggested copy:

   > **One-time upgrade required**
   > Clagentic: Console now uses account-based login. Enter the setup code shown
   > in your terminal to create your admin account and set a new PIN.

   This prevents the user from landing on the setup page confused about why their
   old PIN doesn't work. The setup page already accepts a `setupCode` query param
   from the URL — the daemon log message should include the direct URL with the
   code pre-filled: `http(s)://host:port/auth/setup?setupCode=<code>`

4. **Existing multi-user installs unaffected.** Migration skipped when `data.multiUser === true`.

5. **`config.pinHash` is not deleted.** Leave it in `daemon.json` — harmless and
   safer than deleting. Optional follow-on cleanup.

6. **Partial failure safety.** Only one write during migration (atomic). If process
   crashes before write: state unchanged, migration re-runs on next boot. If crash
   after write: `multiUser: true` + `setupCode` set — user completes setup on next
   visit. No partial state leaves system broken.

---

## Section 6: Rollout — Three PRs

### PR 1 — Backend: always multi-user, keep `isMultiUser()` as stub returning `true`

Scope: `users-auth.js`, `users.js` (defaultData + loadUsers normalization),
`server-auth.js` (remove PIN endpoint, collapse getAuthPage/isRequestAuthed),
`server-settings.js` (remove enable-multiuser endpoint + single-user branches),
`daemon.js` (add migration, remove hint), `server.js` (collapse isMultiUser calls),
`server-admin.js` (remove 404 guards).

**Important:** Do NOT delete `isMultiUser()` from exports yet — leave as stub
`function isMultiUser() { return true; }`. Lets the rest of the codebase compile
and run unchanged while PRs 2 and 3 land.

Tests: Add `test/single-user-migration.test.js`. Update security test single-user cases.

### PR 2 — Cleanup: remove `isMultiUser()` stubs and simplify all callers

Scope: `sessions.js`, `project.js`, `project-connection.js`, `project-sessions.js`,
`project-user-message.js`, `project-loop.js`, `sdk-bridge.js`,
`sdk-message-processor.js`, `terminal-manager.js`, `project-notifications.js`,
`server-palette.js`, `server-dm.js`, `server-skills.js`, `push.js`.

Remove `isMultiUser` from `users-auth.js` and `users.js` exports entirely. Delete the stub.

Tests: Update `test/security.test.js` terminal and push routing tests.

### PR 3 — Frontend: remove single-user UI paths

Scope: `lib/public/app.js`, `lib/public/modules/admin.js`,
`lib/public/modules/user-settings.js`, and optional cleanup of `isMultiUserMode`
guards in `sidebar-sessions.js`, `app-cursors.js`, `app-messages.js`,
`project-settings.js`, `sidebar-mobile.js`, `app-rendering.js`.

---

## Section 7: Edge Cases and Risks

1. **PIN format mismatch (biggest footgun).** `config.pinHash` and `user.pinHash`
   use different scrypt key derivation. Never copy one to the other. Admin MUST
   set a new PIN via setup flow. Log this prominently.

2. **Existing sessions with `ownerId: null`.** Sessions created in single-user mode
   have no owner. After migration they are visible to all users (shared). This is
   the correct default — old sessions become shared.

3. **`dangerouslySkipPermissions` flag always false.** Log a warning if
   `config.dangerouslySkipPermissions: true` is set after migration:
   `"[daemon] WARNING: dangerouslySkipPermissions is set but has no effect in multi-user mode"`

4. **`canAutoLogin` change in sdk-bridge.** Removing `!usersModule.isMultiUser()`
   means auto-login only for users with `linuxUser` set OR admins
   (`authUser.role === "admin"`). Verify this is intended — admins should still
   auto-login via the admin clause.

5. **`profile.json` orphaned.** The `~/.clagentic/profile.json` single-user profile
   file is left in place after migration — harmless, just no longer read.

6. **Dead daemon callbacks.** `onGetDaemonConfig`, `onSetAutoContinue`,
   `onSetChatLayout`, `onSetThemeMode`, `onSetThemeBrand` in `createServer` opts
   were single-user settings paths. Remove from both `daemon.js` (setup) and
   `server-settings.js` (consumption).

7. **`singleUserMigrationAvailable` API field.** Removing it from `/api/me` response
   causes the admin migration callout to silently not render (field is `undefined`,
   which is falsy). Correct outcome — no action needed beyond the API change.
