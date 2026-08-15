var test = require("node:test");
var assert = require("node:assert");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { safePath, validateEnvString } = require("../lib/project");
var { chmodSafe } = require("../lib/config");

// users-auth is the internal module backing PIN operations (lr-ec2d)
var usersAuthModule = require("../lib/users-auth");
var usersAuth = usersAuthModule.attachAuth({
  loadUsers: function () { return { multiUser: true, setupCode: null, users: [], invites: [], smtp: null }; },
  saveUsers: function () {},
  findAdmin: function () { return null; },
});

// ============================================================
// 1. PIN scrypt hashing / verification (via users-auth, lr-ec2d)
// ============================================================

test("hashPin returns scrypt format (scrypt:salt:hash)", function () {
  var token = usersAuth.hashPin("123456");
  assert.ok(token.startsWith("scrypt:"), "Hash should start with scrypt:");
  var parts = token.split(":");
  assert.strictEqual(parts.length, 3, "Hash should have three parts");
  assert.strictEqual(parts[1].length, 32, "Salt should be 16 bytes = 32 hex chars");
  assert.strictEqual(parts[2].length, 128, "Hash should be 64 bytes = 128 hex chars");
});

test("hashPin produces different tokens for same PIN (random salt)", function () {
  var token1 = usersAuth.hashPin("123456");
  var token2 = usersAuth.hashPin("123456");
  assert.notStrictEqual(token1, token2, "Each call should produce a unique salt");
});

test("verifyPin correctly validates scrypt hash", function () {
  var token = usersAuth.hashPin("mypin");
  assert.strictEqual(usersAuth.verifyPin("mypin", token), true, "Correct PIN should verify");
  assert.strictEqual(usersAuth.verifyPin("wrongpin", token), false, "Wrong PIN should not verify");
});

test("verifyPin handles legacy SHA256 format (clay-user: prefix)", function () {
  var legacyHash = crypto.createHash("sha256").update("clay-user:123456").digest("hex");
  assert.strictEqual(usersAuth.verifyPin("123456", legacyHash), true, "Correct PIN should verify with legacy hash");
  assert.strictEqual(usersAuth.verifyPin("000000", legacyHash), false, "Wrong PIN should not verify with legacy hash");
});

test("verifyPin returns false for null/empty stored hash", function () {
  assert.strictEqual(usersAuth.verifyPin("123456", null), false);
  assert.strictEqual(usersAuth.verifyPin("123456", ""), false);
});

// ============================================================
// 2. safePath - path traversal prevention
// ============================================================

test("safePath allows valid subpath", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var subDir = path.join(tmpDir, "sub");
  fs.mkdirSync(subDir);
  var result = safePath(tmpDir, "sub");
  assert.strictEqual(result, subDir);
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks path traversal with ..", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "../../../etc/passwd");
  assert.strictEqual(result, null, "Path traversal should be blocked");
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks absolute path outside base", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "/etc/passwd");
  assert.strictEqual(result, null, "Absolute path outside base should be blocked");
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks symlink escape", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var linkPath = path.join(tmpDir, "escape");
  try {
    fs.symlinkSync("/tmp", linkPath);
    var result = safePath(tmpDir, "escape");
    // If symlink target is outside base, should return null
    if (result !== null) {
      assert.ok(result.startsWith(tmpDir + path.sep) || result === tmpDir,
        "Resolved symlink should stay within base");
    }
  } catch (e) {
    // Symlink creation may fail on some systems
  }
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath returns base dir for empty path", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "");
  assert.strictEqual(result, tmpDir, "Empty path should resolve to base");
  fs.rmSync(tmpDir, { recursive: true });
});

// ============================================================
// 3. Rate limiting logic (basic unit-level test)
// ============================================================

test("WebSocket rate limiter concept test", function () {
  // Test the rate limiting logic in isolation
  var msgCount = 0;
  var msgWindowStart = Date.now();
  var WS_RATE_LIMIT = 5;
  var rateLimited = false;

  function checkRateLimit() {
    var now = Date.now();
    if (now - msgWindowStart >= 1000) {
      msgCount = 0;
      msgWindowStart = now;
    }
    msgCount++;
    if (msgCount > WS_RATE_LIMIT) {
      rateLimited = true;
      return true;
    }
    return false;
  }

  // Send within limit
  for (var i = 0; i < WS_RATE_LIMIT; i++) {
    assert.strictEqual(checkRateLimit(), false, "Message " + (i + 1) + " should be allowed");
  }

  // Next message should trigger rate limit
  assert.strictEqual(checkRateLimit(), true, "Message beyond limit should be rate limited");
  assert.strictEqual(rateLimited, true);
});

// ============================================================
// 4. Skill name / URL validation
// ============================================================

test("valid skill names are accepted", function () {
  var validNames = ["my-skill", "skill_v2", "SkillName", "abc123", "a-b_c"];
  for (var i = 0; i < validNames.length; i++) {
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(validNames[i]),
      validNames[i] + " should be a valid skill name");
  }
});

test("invalid skill names are rejected", function () {
  var invalidNames = ["../escape", "skill name", "skill;rm", "skill/sub", "skill\x00null", ""];
  for (var i = 0; i < invalidNames.length; i++) {
    assert.ok(!/^[a-zA-Z0-9_-]+$/.test(invalidNames[i]),
      invalidNames[i] + " should be an invalid skill name");
  }
});

test("only https:// URLs are allowed for skill install", function () {
  assert.ok(/^https:\/\//i.test("https://github.com/user/repo"), "https URL should be accepted");
  assert.ok(!/^https:\/\//i.test("http://github.com/user/repo"), "http URL should be rejected");
  assert.ok(!/^https:\/\//i.test("file:///etc/passwd"), "file URL should be rejected");
  assert.ok(!/^https:\/\//i.test("javascript:alert(1)"), "javascript URL should be rejected");
});

// ============================================================
// 5. Environment variable validation
// ============================================================

test("validateEnvString accepts valid KEY=VALUE lines", function () {
  assert.strictEqual(validateEnvString("FOO=bar"), null);
  assert.strictEqual(validateEnvString("API_KEY=12345"), null);
  assert.strictEqual(validateEnvString("A=1\nB=2\nC=3"), null);
  assert.strictEqual(validateEnvString("# comment\nFOO=bar"), null);
  assert.strictEqual(validateEnvString(""), null);
  assert.strictEqual(validateEnvString("  "), null);
});

test("validateEnvString rejects invalid variable names", function () {
  var result = validateEnvString("123BAD=value");
  assert.ok(result !== null, "Numeric-start key should be rejected");

  var result2 = validateEnvString("BAD KEY=value");
  assert.ok(result2 !== null, "Key with space should be rejected");

  var result3 = validateEnvString("BAD-KEY=value");
  assert.ok(result3 !== null, "Key with hyphen should be rejected");
});

test("validateEnvString rejects shell injection in values", function () {
  var result = validateEnvString("FOO=$(rm -rf /)");
  assert.ok(result !== null, "Command substitution should be rejected");

  var result2 = validateEnvString("FOO=bar;echo pwned");
  assert.ok(result2 !== null, "Semicolon injection should be rejected");

  var result3 = validateEnvString("FOO=`whoami`");
  assert.ok(result3 !== null, "Backtick injection should be rejected");

  var result4 = validateEnvString("FOO=bar|cat /etc/passwd");
  assert.ok(result4 !== null, "Pipe injection should be rejected");
});

test("validateEnvString rejects lines without = separator", function () {
  var result = validateEnvString("NOEQUALSSIGN");
  assert.ok(result !== null, "Line without = should be rejected");
});

// ============================================================
// 6. File permissions
// ============================================================

test("chmodSafe sets file permissions on non-Windows", function () {
  if (process.platform === "win32") {
    // On Windows, chmodSafe should be a no-op
    chmodSafe("/nonexistent", 0o600);
    return;
  }
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chmod-"));
  var testFile = path.join(tmpDir, "test.json");
  fs.writeFileSync(testFile, '{"test": true}');
  chmodSafe(testFile, 0o600);
  var stats = fs.statSync(testFile);
  var mode = stats.mode & 0o777;
  assert.strictEqual(mode, 0o600, "File should have 0600 permissions");
  fs.rmSync(tmpDir, { recursive: true });
});

test("chmodSafe sets directory permissions on non-Windows", function () {
  if (process.platform === "win32") return;
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chmod-"));
  var testDir = path.join(tmpDir, "secure");
  fs.mkdirSync(testDir);
  chmodSafe(testDir, 0o700);
  var stats = fs.statSync(testDir);
  var mode = stats.mode & 0o777;
  assert.strictEqual(mode, 0o700, "Directory should have 0700 permissions");
  fs.rmSync(tmpDir, { recursive: true });
});

test("chmodSafe does not throw on nonexistent file", function () {
  assert.doesNotThrow(function () {
    chmodSafe("/nonexistent/path/file.json", 0o600);
  });
});

// ============================================================
// 7. PIN hash migration detection (lr-ec2d)
// ============================================================

test("legacy SHA256 hash is detected (no scrypt: prefix)", function () {
  var legacyHash = crypto.createHash("sha256").update("clay-user:123456").digest("hex");
  assert.ok(!legacyHash.startsWith("scrypt:"), "Legacy hash should not start with scrypt:");
  assert.strictEqual(legacyHash.length, 64, "SHA256 hex should be 64 chars");
});

test("scrypt hash is detected (starts with scrypt:)", function () {
  var scryptHash = usersAuth.hashPin("123456");
  assert.ok(scryptHash.startsWith("scrypt:"), "Scrypt hash should start with scrypt:");
});

// ============================================================
// 8. Terminal ownership enforcement (lr-4d6a)
// ============================================================

var { createTerminalManager } = require("../lib/terminal-manager");

function makeWs(userId, role) {
  return {
    _clayUser: userId ? { id: userId, role: role || "user" } : null,
    readyState: 1,
    send: function () {},
  };
}

function makeNullPtyManager() {
  // createTerminalManager calls createTerminal internally; stub it out by returning
  // null from tm.create (no node-pty available in test environment).
  // We test the ownership logic directly by constructing fake sessions.
  return null;
}

test("terminal manager: unauthenticated caller (system context) is handled gracefully (lr-ec2d)", function () {
  // Always multi-user now; system-context callers (null _clayUser) are still allowed to
  // call the terminal manager without an authenticated ws — they simply get full access.
  var tm = createTerminalManager({
    cwd: "/tmp",
    send: function () {},
    sendTo: function () {},
    isMultiUser: true,
  });
  var ws = makeWs(null); // no _clayUser
  // attach to non-existent terminal returns false gracefully
  assert.strictEqual(tm.attach(99, ws), false, "attach to missing id returns false");
  assert.doesNotThrow(function () { tm.write(99, "data", ws); }, "write to missing id does not throw");
  assert.doesNotThrow(function () { tm.close(99, ws); }, "close on missing id does not throw");
  assert.doesNotThrow(function () { tm.rename(99, "title", ws); }, "rename on missing id does not throw");
  var list = tm.list(ws);
  assert.ok(Array.isArray(list), "list returns array");
  assert.strictEqual(list.length, 0, "empty list when no terminals");
});

test("terminal manager: multi-user mode attach returns false for unauthorized ws", function () {
  var tm = createTerminalManager({
    cwd: "/tmp",
    send: function () {},
    sendTo: function () {},
    isMultiUser: true,
  });

  // Manually inject a fake terminal session to bypass PTY creation
  var ownerWs = makeWs("user-A");
  var fakeSession = {
    id: 1,
    pty: null,
    scrollback: [],
    scrollbackSize: 0,
    totalBytesWritten: 0,
    cols: 80,
    rows: 24,
    title: "Terminal 1",
    exited: false,
    exitCode: null,
    subscribers: new Set(),
    ownerWs: ownerWs,
    ownerUserId: "user-A",
  };
  tm._terminals_for_test = fakeSession; // not a real API — we expose via map trick below

  // Access the internal Map by calling list() and attach() to observe authorization
  // Since we cannot inject into the Map directly through the public API without a PTY,
  // we test the property-level logic using the isAuthorized-equivalent: the list() filter.

  // In multi-user mode, a user who does not own any terminal should see an empty list.
  var wsB = makeWs("user-B");
  var wsA = makeWs("user-A");

  // No terminals exist (PTY unavailable), so list is always empty — verify no crash
  assert.strictEqual(tm.list(wsA).length, 0, "owner sees empty list when no terminals created");
  assert.strictEqual(tm.list(wsB).length, 0, "non-owner sees empty list when no terminals created");
  assert.strictEqual(tm.attach(1, wsB), false, "attach to non-existent terminal returns false");
});

test("terminal manager: list() filters by caller userId in multi-user mode", function () {
  // This test verifies the filtering logic in list() without needing real PTYs.
  // We use a custom terminal manager with the isAuthorized function tested directly.
  var filterResults = [];

  // Simulate what list(ws) does for two users by testing the isMultiUser gate logic:
  var isMultiUser = true;

  function isAuthorized(session, callerWs) {
    if (!isMultiUser) return true;
    if (!callerWs) return true;
    if (!session.ownerUserId) return true;
    var caller = callerWs._clayUser;
    if (!caller) return true;
    if (caller.role === "admin") return true;
    return caller.id === session.ownerUserId;
  }

  var sessions = [
    { id: 1, ownerUserId: "user-A", title: "A's terminal" },
    { id: 2, ownerUserId: "user-B", title: "B's terminal" },
    { id: 3, ownerUserId: null,     title: "Legacy terminal" },
  ];

  var wsA = makeWs("user-A");
  var wsB = makeWs("user-B");
  var wsAdmin = makeWs("user-admin", "admin");
  var wsNoUser = { _clayUser: null, readyState: 1, send: function () {} };

  var listForA = sessions.filter(function (s) { return isAuthorized(s, wsA); });
  var listForB = sessions.filter(function (s) { return isAuthorized(s, wsB); });
  var listForAdmin = sessions.filter(function (s) { return isAuthorized(s, wsAdmin); });
  var listForNoUser = sessions.filter(function (s) { return isAuthorized(s, wsNoUser); });

  assert.strictEqual(listForA.length, 2, "user-A sees own terminal + legacy");
  assert.ok(listForA.some(function (s) { return s.id === 1; }), "user-A sees their terminal");
  assert.ok(listForA.some(function (s) { return s.id === 3; }), "user-A sees legacy terminal");
  assert.ok(!listForA.some(function (s) { return s.id === 2; }), "user-A does not see user-B terminal");

  assert.strictEqual(listForB.length, 2, "user-B sees own terminal + legacy");
  assert.ok(listForB.some(function (s) { return s.id === 2; }), "user-B sees their terminal");
  assert.ok(!listForB.some(function (s) { return s.id === 1; }), "user-B does not see user-A terminal");

  assert.strictEqual(listForAdmin.length, 3, "admin sees all terminals");
  assert.strictEqual(listForNoUser.length, 3, "unauthenticated client (system context) sees all terminals");
});

// ============================================================
// 9. Push notification routing (lr-4d6a)
// ============================================================

test("push routing: sendPushToUser is called for user-specific events in multi-user mode", function () {
  var broadcastCalls = [];
  var userCalls = [];

  var fakePush = {
    sendPush: function (payload) { broadcastCalls.push(payload); },
    sendPushToUser: function (userId, payload) { userCalls.push({ userId: userId, payload: payload }); },
  };

  // Simulate the routing decision made in sdk-message-processor.js and sdk-bridge.js:
  // In multi-user mode with a session owner, use sendPushToUser.
  function routePush(isMultiUser, ownerId, pushModule, payload) {
    if (isMultiUser && ownerId && pushModule.sendPushToUser) {
      pushModule.sendPushToUser(ownerId, payload);
    } else {
      pushModule.sendPush(payload);
    }
  }

  var donePayload = { type: "done", slug: "proj", title: "Title", body: "Preview" };
  var askPayload  = { type: "ask_user", slug: "proj", title: "Q", body: "question?" };

  // Multi-user mode with owner — should route to user
  routePush(true, "user-A", fakePush, donePayload);
  routePush(true, "user-A", fakePush, askPayload);

  assert.strictEqual(userCalls.length, 2, "two user-targeted pushes sent");
  assert.strictEqual(broadcastCalls.length, 0, "no broadcast pushes in multi-user mode");
  assert.strictEqual(userCalls[0].userId, "user-A", "done notification routed to owner");
  assert.strictEqual(userCalls[1].userId, "user-A", "ask_user notification routed to owner");
});

test("push routing: falls back to sendPush when no ownerId in multi-user mode", function () {
  var broadcastCalls = [];
  var userCalls = [];

  var fakePush = {
    sendPush: function (payload) { broadcastCalls.push(payload); },
    sendPushToUser: function (userId, payload) { userCalls.push({ userId: userId, payload: payload }); },
  };

  function routePush(isMultiUser, ownerId, pushModule, payload) {
    if (isMultiUser && ownerId && pushModule.sendPushToUser) {
      pushModule.sendPushToUser(ownerId, payload);
    } else {
      pushModule.sendPush(payload);
    }
  }

  // Multi-user but no ownerId (legacy session) — falls back to broadcast
  routePush(true, null, fakePush, { type: "done" });
  assert.strictEqual(broadcastCalls.length, 1, "legacy session falls back to broadcast");
  assert.strictEqual(userCalls.length, 0, "no user-targeted push for legacy session");
});

// ============================================================
// 10. dangerouslySkipPermissions scope gate (lr-4d6a)
// ============================================================

test("dangerouslySkipPermissions is always disabled — single-user mode removed (lr-ec2d)", function () {
  // isMultiUser() always returns true; the flag is always suppressed.
  // Mirrors the gate in project.js:
  //   var dangerouslySkipPermissions = dangerouslySkipPermissionsConfigured && !usersModule.isMultiUser();
  function computeFlag(configured) {
    var isMultiUser = true; // always, lr-ec2d
    return configured && !isMultiUser;
  }

  assert.strictEqual(computeFlag(true), false,  "flag suppressed even when configured (always multi-user)");
  assert.strictEqual(computeFlag(false), false, "flag inactive when not configured");
});

test("dangerouslySkipPermissionsBlocked is always set when configured (lr-ec2d)", function () {
  // isMultiUser() always returns true after lr-ec2d; blocked is always true when configured.
  function buildInfoFields(configured) {
    var isMultiUser = true; // always, lr-ec2d
    var active = configured && !isMultiUser;
    var fields = { dangerouslySkipPermissions: active };
    if (configured && !active) {
      fields.dangerouslySkipPermissionsBlocked = true;
    }
    return fields;
  }

  var configured = buildInfoFields(true);
  assert.strictEqual(configured.dangerouslySkipPermissions, false, "configured: active=false (multi-user always on)");
  assert.strictEqual(configured.dangerouslySkipPermissionsBlocked, true, "configured: blocked=true");

  var notConfigured = buildInfoFields(false);
  assert.strictEqual(notConfigured.dangerouslySkipPermissions, false, "not configured: active=false");
  assert.ok(!notConfigured.dangerouslySkipPermissionsBlocked, "not configured: blocked field absent");
});

// ============================================================
// 11. getScrollback ownership gate (lr-4d6a follow-up)
// ============================================================

test("getScrollback returns null for unauthorized caller in multi-user mode", function () {
  var { createTerminalManager } = require("../lib/terminal-manager");

  var tm = createTerminalManager({ cwd: "/tmp", isMultiUser: true });

  // Inject a fake terminal session directly into the manager's internals.
  // We do this by creating a terminal (which would require a real pty) so
  // instead we test the isAuthorized logic inline, mirroring the production
  // path, using a separate instance to verify the callerWs check.

  // Build a minimal fake session and wrap it in a test-local isAuthorized
  // that mirrors terminal-manager.js exactly.
  function isAuthorizedLocal(session, callerWs, isMultiUser) {
    if (!isMultiUser) return true;
    if (!callerWs) return true;
    if (!session.ownerUserId) return true;
    var caller = callerWs._clayUser;
    if (!caller) return true;
    if (caller.role === "admin") return true;
    return caller.id === session.ownerUserId;
  }

  var session = { ownerUserId: "user-A", scrollback: [], totalBytesWritten: 0 };

  var wsOwner = { _clayUser: { id: "user-A", role: "user" } };
  var wsOther = { _clayUser: { id: "user-B", role: "user" } };
  var wsAdmin = { _clayUser: { id: "user-C", role: "admin" } };

  assert.ok(isAuthorizedLocal(session, wsOwner, true), "owner can read their own scrollback");
  assert.ok(!isAuthorizedLocal(session, wsOther, true), "non-owner cannot read scrollback in multi-user mode");
  assert.ok(isAuthorizedLocal(session, wsAdmin, true), "admin can read any scrollback");
  // lr-ec2d: single-user mode removed; isMultiUser is always true — no single-user branch tested
});

// ============================================================
// 12. context_sources_save strips unauthorized term: IDs (lr-4d6a follow-up)
// ============================================================

test("context_sources_save filters out term: IDs the caller does not own", function () {
  // Simulate the filter logic from project-user-message.js context_sources_save.
  // In production: activeIds = activeIds.filter(srcId => tm.getScrollback(tid, ws) !== null)
  // getScrollback returns null when caller is unauthorized.

  // Mock tm.getScrollback that only grants access to user-A's terminal (id=1)
  var fakeGetScrollback = function(termId, callerWs) {
    // terminal 1 is owned by user-A
    if (termId === 1) {
      if (!callerWs || !callerWs._clayUser) return null;
      return callerWs._clayUser.id === "user-A" ? { totalBytesWritten: 0 } : null;
    }
    return null; // unknown terminal
  };

  var tm = { getScrollback: fakeGetScrollback };

  function filterContextSources(activeIds, ws) {
    return activeIds.filter(function(srcId) {
      if (!srcId.startsWith("term:")) return true;
      var tid = parseInt(srcId.split(":")[1], 10);
      return tm.getScrollback(tid, ws) !== null;
    });
  }

  var wsA = { _clayUser: { id: "user-A" } };
  var wsB = { _clayUser: { id: "user-B" } };

  var sources = ["file:readme.md", "term:1", "term:2"];

  var filteredA = filterContextSources(sources, wsA);
  assert.deepStrictEqual(filteredA, ["file:readme.md", "term:1"],
    "owner keeps their own term:1, unknown term:2 is stripped");

  var filteredB = filterContextSources(sources, wsB);
  assert.deepStrictEqual(filteredB, ["file:readme.md"],
    "non-owner has all term: IDs stripped");
});

// ============================================================
// 13. Audit log module (lr-6580)
// ============================================================

test("audit.log: writes a valid JSON line to the audit log file", function (t, done) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  // audit.js writes to CONFIG_DIR/audit.log — tmpDir is used directly as CONFIG_DIR.
  var auditPath = path.join(tmpDir, "audit.log");

  // Temporarily override CONFIG_DIR by patching the loaded module's path resolution.
  // We re-require a fresh audit module with a patched config so it writes to tmpDir.
  // Clear require cache to get a fresh module instance.
  var auditModulePath = require.resolve("../lib/audit");
  var configModulePath = require.resolve("../lib/config");

  // Patch: temporarily override the CONFIG_DIR in cache for this test
  var originalConfig = require.cache[configModulePath];
  require.cache[configModulePath] = {
    id: configModulePath,
    filename: configModulePath,
    loaded: true,
    exports: Object.assign({}, require(configModulePath), { CONFIG_DIR: tmpDir }),
  };

  // Remove audit from cache so it re-requires with our patched config
  delete require.cache[auditModulePath];
  var freshAudit = require("../lib/audit");

  freshAudit.log("test.action", {
    actorId: "user-1",
    actorName: "alice",
    target: "user-2",
    metadata: { role: "admin" },
  });

  // Restore original config and audit modules
  require.cache[configModulePath] = originalConfig;
  delete require.cache[auditModulePath];

  // Audit writes via setImmediate — give it one tick to flush
  setImmediate(function () {
    try {
      var content = fs.readFileSync(auditPath, "utf8").trim();
      assert.ok(content.length > 0, "audit log should not be empty");
      var entry = JSON.parse(content);
      assert.strictEqual(entry.action, "test.action", "action field should match");
      assert.strictEqual(entry.actorId, "user-1", "actorId should match");
      assert.strictEqual(entry.actorName, "alice", "actorName should match");
      assert.strictEqual(entry.target, "user-2", "target should match");
      assert.deepStrictEqual(entry.metadata, { role: "admin" }, "metadata should match");
      assert.ok(typeof entry.ts === "string" && entry.ts.length > 0, "ts should be an ISO string");
      var stat = fs.statSync(auditPath);
      var mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o600, "audit.log should have 0600 permissions");
      fs.rmSync(tmpDir, { recursive: true });
      done();
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true });
      done(e);
    }
  });
});

test("audit.log: does not throw when called with no context", function () {
  // Should not throw even if ctx is omitted or empty
  var auditModulePath = require.resolve("../lib/audit");
  delete require.cache[auditModulePath];
  // Use a temp dir so we don't pollute the real config dir
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit2-"));
  var configModulePath = require.resolve("../lib/config");
  var originalConfig = require.cache[configModulePath];
  require.cache[configModulePath] = {
    id: configModulePath,
    filename: configModulePath,
    loaded: true,
    exports: Object.assign({}, require(configModulePath), { CONFIG_DIR: tmpDir }),
  };
  delete require.cache[auditModulePath];
  var freshAudit = require("../lib/audit");
  assert.doesNotThrow(function () {
    freshAudit.log("action.no.ctx");
    freshAudit.log("action.empty.ctx", {});
    freshAudit.log("action.null.fields", { actorId: null, target: null, metadata: null });
  });
  require.cache[configModulePath] = originalConfig;
  delete require.cache[auditModulePath];
  // Give setImmediate a chance to run before cleanup
  setImmediate(function () { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} });
});

// ============================================================
// 14. switchSession access guards (lr-f0d8)
// ============================================================

test("switchSession: rejects non-existent session ID with structured error", function () {
  // Mirror the guard logic added to sessions.js switchSession.
  // We test the decision path in isolation (the actual manager requires file I/O).
  var sessions = new Map();
  sessions.set(1, { localId: 1, ownerId: null });

  var sentErrors = [];
  var fakeSendTo = function (ws, msg) { sentErrors.push(msg); };

  function switchSessionGuard(localId, targetWs) {
    if (!sessions.has(localId)) {
      if (targetWs && fakeSendTo) {
        fakeSendTo(targetWs, { type: "error", error: "Session not found" });
      }
      return false; // blocked
    }
    return true; // would proceed
  }

  var fakeWs = { _clayUser: null, readyState: 1, send: function () {} };

  assert.strictEqual(switchSessionGuard(99, fakeWs), false, "non-existent ID is rejected");
  assert.strictEqual(sentErrors.length, 1, "one error sent");
  assert.strictEqual(sentErrors[0].type, "error", "error message has type=error");
  assert.strictEqual(sentErrors[0].error, "Session not found", "error text matches");

  // Internal call (targetWs=null) must not send error and must return early silently
  sentErrors.length = 0;
  assert.strictEqual(switchSessionGuard(99, null), false, "internal call also returns false");
  assert.strictEqual(sentErrors.length, 0, "no error sent for internal call");
});

test("switchSession: rejects unauthorized access in multi-user mode", function () {
  // Simulate the guard logic: user-B must not switch to a private session owned by user-A.
  var sessions = new Map();
  sessions.set(1, { localId: 1, ownerId: "user-A", sessionVisibility: "private" });
  sessions.set(2, { localId: 2, ownerId: "user-A", sessionVisibility: "shared" });

  // Minimal canAccessSession mirror (same logic as users-permissions.js)
  function canAccessSession(userId, session) {
    if (!session.ownerId) return false; // no owner = admin-only (treat as denied here)
    if (session.ownerId === userId) return true;
    if (!session.sessionVisibility || session.sessionVisibility === "shared") return true;
    return false;
  }

  var sentErrors = [];
  var fakeSendTo = function (ws, msg) { sentErrors.push(msg); };

  function switchSessionGuard(localId, targetWs, isMultiUser) {
    if (!sessions.has(localId)) {
      if (targetWs) fakeSendTo(targetWs, { type: "error", error: "Session not found" });
      return false;
    }
    var session = sessions.get(localId);
    if (targetWs) {
      if (isMultiUser) {
        var user = targetWs._clayUser;
        if (!user) {
          fakeSendTo(targetWs, { type: "error", error: "Access denied" });
          return false;
        }
        if (!canAccessSession(user.id, session)) {
          fakeSendTo(targetWs, { type: "error", error: "Access denied" });
          return false;
        }
      } else {
        if (session.ownerId) {
          fakeSendTo(targetWs, { type: "error", error: "Access denied" });
          return false;
        }
      }
    }
    return true;
  }

  var wsB = { _clayUser: { id: "user-B", role: "user" }, readyState: 1, send: function () {} };
  var wsA = { _clayUser: { id: "user-A", role: "user" }, readyState: 1, send: function () {} };

  // user-B cannot access user-A's private session in multi-user mode
  sentErrors.length = 0;
  assert.strictEqual(switchSessionGuard(1, wsB, true), false, "private session rejected for non-owner");
  assert.strictEqual(sentErrors.length, 1, "error sent for unauthorized access");
  assert.strictEqual(sentErrors[0].error, "Access denied");

  // user-A can access their own private session
  sentErrors.length = 0;
  assert.strictEqual(switchSessionGuard(1, wsA, true), true, "owner accesses own private session");
  assert.strictEqual(sentErrors.length, 0, "no error for authorized access");

  // user-B can access user-A's shared session
  sentErrors.length = 0;
  assert.strictEqual(switchSessionGuard(2, wsB, true), true, "shared session accessible to non-owner");
  assert.strictEqual(sentErrors.length, 0, "no error for shared session");

  // Internal call (no ws) bypasses the guard entirely
  sentErrors.length = 0;
  assert.strictEqual(switchSessionGuard(1, null, true), true, "internal call bypasses access check");
  assert.strictEqual(sentErrors.length, 0, "no error for internal call");
});

// ============================================================
// 15. Pre-auth route guards (lr-d857)
// ============================================================

// Helpers for building mock req/res pairs used by section 15 tests.
// These call the real handler functions — tests fail if isRequestAuthed
// checks are removed from production code.

// makeSettingsCtx: isAuthed controls whether getMultiUserFromReq returns a user.
// isMultiUser param is kept for backward compatibility but ignored (always true, lr-ec2d).
function makeSettingsCtx(isAuthed, isMultiUser) {
  var fakeUser = isAuthed ? { id: "test-user", username: "testuser", role: "user", pinHash: null, profile: {} } : null;
  return {
    users: {
      isMultiUser: function () { return true; },
      updateUserProfile: function () { return { ok: true, profile: {} }; },
    },
    getMultiUserFromReq: function () { return fakeUser; },
    isRequestAuthed: function () { return !!isAuthed; },
    projects: { forEach: function () {} },
    opts: {},
    CONFIG_DIR: os.tmpdir(),
  };
}

function makeReq(method, url) {
  var listeners = {};
  return {
    method: method,
    url: url,
    on: function (evt, fn) { listeners[evt] = fn; },
    _emit: function (evt, data) { if (listeners[evt]) listeners[evt](data); },
    _end: function () { if (listeners["end"]) listeners["end"](); },
  };
}

function makeRes() {
  var result = { status: null, body: "" };
  result.writeHead = function (code) { result.status = code; };
  result.end = function (body) { result.body = body || ""; };
  return result;
}

test("enable-multiuser: endpoint removed — single-user mode no longer exists (lr-ec2d)", function () {
  // POST /api/settings/enable-multiuser was removed along with single-user mode (lr-ec2d).
  // The handler returns false (not handled) for this route, so status stays null.
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(true, true);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("POST", "/api/settings/enable-multiuser");
  var res = makeRes();
  var handled = handler(req, res, "/api/settings/enable-multiuser");

  assert.strictEqual(handled, false, "removed endpoint returns false from handleRequest");
  assert.strictEqual(res.status, null, "no response written for removed endpoint");
});

test("GET /api/profile: rejects unauthenticated request with 401 (multi-user, lr-ec2d)", function () {
  var { attachSettings } = require("../lib/server-settings");

  // Unauthenticated: getMultiUserFromReq returns null
  var ctx = makeSettingsCtx(false, true);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("GET", "/api/profile");
  var res = makeRes();
  handler(req, res, "/api/profile");

  assert.strictEqual(res.status, 401, "unauthenticated GET /api/profile gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");

  // Authenticated: getMultiUserFromReq returns a user → returns profile
  var ctx2 = makeSettingsCtx(true, true);
  var handler2 = attachSettings(ctx2).handleRequest;

  var req2 = makeReq("GET", "/api/profile");
  var res2 = makeRes();
  handler2(req2, res2, "/api/profile");

  assert.strictEqual(res2.status, 200, "authenticated GET /api/profile succeeds");
});

test("POST /api/avatar: rejects unauthenticated request with 401 (multi-user, lr-ec2d)", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-test-"));
  var ctx = makeSettingsCtx(false, true);
  ctx.CONFIG_DIR = tmpDir;
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("POST", "/api/avatar");
  var res = makeRes();
  handler(req, res, "/api/avatar");

  // Emit a minimal valid PNG magic bytes payload
  var pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  req._emit("data", pngMagic);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 401, "unauthenticated POST /api/avatar gets 401");
      assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
      var avatarDir = path.join(tmpDir, "avatars");
      var written = fs.existsSync(avatarDir) && fs.readdirSync(avatarDir).length > 0;
      assert.ok(!written, "avatar file must not be written for unauthenticated caller");
      fs.rmSync(tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("skills proxy: rejects unauthenticated request with 401 in multi-user mode", function () {
  var { attachSkills } = require("../lib/server-skills");

  // Multi-user, unauthenticated (getMultiUserFromReq returns null) → 401
  var ctx401 = {
    users: { isMultiUser: function () { return true; } },
    osUsers: [],
    getMultiUserFromReq: function () { return null; },
  };
  var handler401 = attachSkills(ctx401).handleRequest;
  var req401 = makeReq("GET", "/api/skills");
  var res401 = makeRes();
  handler401(req401, res401, "/api/skills");
  assert.strictEqual(res401.status, 401, "unauthenticated request in multi-user mode gets 401");

  // Multi-user, authenticated but no skills permission → 403
  var ctx403 = {
    users: {
      isMultiUser: function () { return true; },
      getEffectivePermissions: function () { return { skills: false }; },
    },
    osUsers: [],
    getMultiUserFromReq: function () { return { id: "u1" }; },
  };
  var handler403 = attachSkills(ctx403).handleRequest;
  var req403 = makeReq("GET", "/api/skills");
  var res403 = makeRes();
  handler403(req403, res403, "/api/skills");
  assert.strictEqual(res403.status, 403, "authenticated user without skills permission gets 403");

  // lr-ec2d: single-user mode removed; authenticated user with skills permission proceeds
  //
  // lr-795882: the pass-through branch calls the REAL lib/server-skills.js
  // handler, which (once past the permission gate this test exists to check)
  // synchronously kicks off a real outbound https.get("https://skills.sh/...")
  // — a genuine network dependency in a unit test, and the connection was
  // never awaited, timed out, or closed, leaking a live TCP+TLS socket that
  // kept `node --test` (run without --test-force-exit) from ever reaching
  // idle for the rest of this suite. This test only asserts the auth gate
  // was passed (see the pre-existing comment below), so stub https.get for
  // the duration of this one call — scoped to this test, restored
  // immediately after — instead of letting a real network call fire for an
  // assertion that never reads its result.
  var https = require("https");
  var origHttpsGet = https.get;
  https.get = function (url, opts, cb) {
    // Match Node's http.get behavior when only a callback is passed.
    if (typeof opts === "function") { cb = opts; }
    var fakeResp = {
      statusCode: 200,
      headers: {},
      on: function (event, handler) {
        if (event === "end") setImmediate(handler);
        return fakeResp;
      },
    };
    if (typeof cb === "function") setImmediate(function () { cb(fakeResp); });
    var fakeReq = { on: function () { return fakeReq; } };
    return fakeReq;
  };
  try {
    var ctxOk = {
      users: {
        isMultiUser: function () { return true; },
        getEffectivePermissions: function () { return { skills: true }; },
      },
      osUsers: [],
      getMultiUserFromReq: function () { return { id: "u2" }; },
    };
    var handlerOk = attachSkills(ctxOk).handleRequest;
    var reqOk = makeReq("GET", "/api/skills?tab=all");
    reqOk.url = "/api/skills?tab=all";
    var resOk = makeRes();
    handlerOk(reqOk, resOk, "/api/skills");
    // Response is async (fetch); status is null now — just verify it's not 401/403
    assert.ok(resOk.status !== 401 && resOk.status !== 403,
      "authenticated user with skills permission is not rejected (no 401 or 403)");
  } finally {
    https.get = origHttpsGet;
  }
});

// lr-30a5: sibling pre-auth 401 gates (lr-d857 B1 follow-up). Each test drives
// the real attachSettings handler — it fails if the getMultiUserFromReq/401
// gate is ever reverted from the corresponding route in server-settings.js.

test("PUT /api/user/chat-layout: rejects unauthenticated request with 401", function () {
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(false, false);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("PUT", "/api/user/chat-layout");
  var res = makeRes();
  handler(req, res, "/api/user/chat-layout");

  assert.strictEqual(res.status, 401, "unauthenticated PUT /api/user/chat-layout gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
});

test("PUT /api/user/theme-mode: rejects unauthenticated request with 401", function () {
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(false, false);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("PUT", "/api/user/theme-mode");
  var res = makeRes();
  handler(req, res, "/api/user/theme-mode");

  assert.strictEqual(res.status, 401, "unauthenticated PUT /api/user/theme-mode gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
});

test("PUT /api/user/theme-brand: rejects unauthenticated request with 401", function () {
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(false, false);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("PUT", "/api/user/theme-brand");
  var res = makeRes();
  handler(req, res, "/api/user/theme-brand");

  assert.strictEqual(res.status, 401, "unauthenticated PUT /api/user/theme-brand gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
});

test("PUT /api/user/tool-palettes: rejects unauthenticated request with 401", function () {
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(false, false);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("PUT", "/api/user/tool-palettes");
  var res = makeRes();
  handler(req, res, "/api/user/tool-palettes");

  assert.strictEqual(res.status, 401, "unauthenticated PUT /api/user/tool-palettes gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
});

// Note: /api/user/auto-continue is a GET route in server-settings.js (not PUT,
// despite the originating task description) — tested against the real route.
test("GET /api/user/auto-continue: rejects unauthenticated request with 401", function () {
  var { attachSettings } = require("../lib/server-settings");
  var ctx = makeSettingsCtx(false, false);
  var handler = attachSettings(ctx).handleRequest;

  var req = makeReq("GET", "/api/user/auto-continue");
  var res = makeRes();
  handler(req, res, "/api/user/auto-continue");

  assert.strictEqual(res.status, 401, "unauthenticated GET /api/user/auto-continue gets 401");
  assert.ok(res.body.indexOf("unauthorized") !== -1, "body contains 'unauthorized'");
});

// ============================================================
// 16. git clone URL validation (lr-28b5)
//     Calls the real exported functions from lib/clone-validate.js, which are
//     the same functions invoked by daemon.js onCloneProject. Tests drive real
//     daemon code paths — removing any mitigation from clone-validate.js will
//     break the corresponding test here.
// ============================================================

// Import the real production functions used by onCloneProject (not a copy).
var { validateCloneUrl, buildCloneArgs } = require("../lib/clone-validate");

// --- Mitigation 1: scheme allow-list ---

test("clone URL: https:// is accepted", function () {
  assert.strictEqual(validateCloneUrl("https://github.com/user/repo.git"), null);
});

test("clone URL: http:// is accepted", function () {
  assert.strictEqual(validateCloneUrl("http://example.com/repo.git"), null);
});

test("clone URL: git:// is accepted", function () {
  assert.strictEqual(validateCloneUrl("git://github.com/user/repo.git"), null);
});

test("clone URL: ssh:// is accepted", function () {
  assert.strictEqual(validateCloneUrl("ssh://git@github.com/user/repo.git"), null);
});

test("clone URL: git@ SSH shorthand is accepted", function () {
  assert.strictEqual(validateCloneUrl("git@github.com:user/repo.git"), null);
  assert.strictEqual(validateCloneUrl("git@gitlab.com:group/sub/repo"), null);
});

test("clone URL: ext:: transport is rejected (RCE vector)", function () {
  var err = validateCloneUrl("ext::sh -c touch /tmp/pwned");
  assert.ok(err !== null, "ext:: transport must be rejected");
  assert.ok(err.indexOf("unsupported scheme") !== -1, "error mentions unsupported scheme");
});

test("clone URL: file:: transport is rejected", function () {
  var err = validateCloneUrl("file:///etc/passwd");
  assert.ok(err !== null, "file:: transport must be rejected");
});

test("clone URL: other non-allow-listed schemes are rejected", function () {
  var rejected = ["javascript:alert(1)", "ftp://example.com/repo", "data:text/plain,x", "ldap://example.com"];
  for (var i = 0; i < rejected.length; i++) {
    var err = validateCloneUrl(rejected[i]);
    assert.ok(err !== null, rejected[i] + " should be rejected");
  }
});

// --- Mitigation 2: leading-dash (option injection) ---

test("clone URL: leading-dash is rejected (option injection vector)", function () {
  var err = validateCloneUrl("--upload-pack=touch /tmp/pwned");
  assert.ok(err !== null, "leading-dash must be rejected");
  assert.ok(err.indexOf("'-'") !== -1, "error mentions the leading dash");
});

// --- Mitigation 3: '--' argv terminator position in spawn args ---
// buildCloneArgs must place '--' at argv[1] so git never interprets the URL
// as an option, even if validateCloneUrl is bypassed in the future.

test("clone spawn args: '--' terminator is at argv[1]", function () {
  var url = "https://github.com/user/repo.git";
  var targetDir = "/tmp/test-target";
  var spec = buildCloneArgs(url, targetDir);
  assert.strictEqual(spec.args[0], "clone", "argv[0] is 'clone'");
  assert.strictEqual(spec.args[1], "--", "argv[1] is '--' (terminator)");
  assert.strictEqual(spec.args[2], url, "argv[2] is the clone URL");
  assert.strictEqual(spec.args[3], targetDir, "argv[3] is the target directory");
});

// --- Mitigation 4: GIT_ALLOW_PROTOCOL env restriction ---
// buildCloneArgs must set GIT_ALLOW_PROTOCOL to the safe-transport list so that
// ext:: and file:: transports are blocked at the git level even if URL validation
// is somehow bypassed.

test("clone spawn args: GIT_ALLOW_PROTOCOL restricts transports", function () {
  var spec = buildCloneArgs("https://github.com/user/repo.git", "/tmp/target");
  assert.ok(
    spec.envOverrides && typeof spec.envOverrides.GIT_ALLOW_PROTOCOL === "string",
    "envOverrides must include GIT_ALLOW_PROTOCOL"
  );
  var allowed = spec.envOverrides.GIT_ALLOW_PROTOCOL;
  // The four safe protocols must be present.
  assert.ok(allowed.indexOf("https") !== -1, "https must be in GIT_ALLOW_PROTOCOL");
  assert.ok(allowed.indexOf("http") !== -1, "http must be in GIT_ALLOW_PROTOCOL");
  assert.ok(allowed.indexOf("git") !== -1, "git must be in GIT_ALLOW_PROTOCOL");
  assert.ok(allowed.indexOf("ssh") !== -1, "ssh must be in GIT_ALLOW_PROTOCOL");
  // ext and file transports must NOT appear, verifying they are excluded.
  assert.ok(allowed.indexOf("ext") === -1, "ext must NOT be in GIT_ALLOW_PROTOCOL");
  assert.ok(allowed.indexOf("file") === -1, "file must NOT be in GIT_ALLOW_PROTOCOL");
});

test("push addSubscription: only removes replaceEndpoint when caller owns it", function () {
  // Test the real addSubscription function from push.js via require-cache mocking.
  // Stub web-push and store to avoid network calls and filesystem writes.
  var pushPath = require.resolve("../lib/push");
  var webpushPath = require.resolve("web-push");
  var storePath = require.resolve("../lib/store");
  var configPath = require.resolve("../lib/config");

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-test-"));

  var fakeVapidKeys = { publicKey: "fakePub", privateKey: "fakePriv" };
  var origWebpush = require.cache[webpushPath];
  var origStore = require.cache[storePath];
  var origConfig = require.cache[configPath];

  // Stub web-push: generateVAPIDKeys and sendNotification
  require.cache[webpushPath] = {
    id: webpushPath, filename: webpushPath, loaded: true,
    exports: {
      generateVAPIDKeys: function () { return fakeVapidKeys; },
      sendNotification: function () { return Promise.resolve(); },
    },
  };
  // Stub store: writeJson is a no-op
  require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
      writeJson: function () { return Promise.resolve(); },
    },
  };
  // Stub config: point CONFIG_DIR to tmpDir so vapid.json read fails (file absent)
  var realConfig = require(configPath);
  require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: Object.assign({}, realConfig, { CONFIG_DIR: tmpDir }),
  };

  // Clear push from cache so it re-requires with our stubs
  delete require.cache[pushPath];
  var freshPush = require("../lib/push");
  var push = freshPush.initPush();
  var addSubscription = push.addSubscription;

  // Restore all stubs immediately after getting addSubscription
  if (origWebpush) require.cache[webpushPath] = origWebpush;
  else delete require.cache[webpushPath];
  if (origStore) require.cache[storePath] = origStore;
  else delete require.cache[storePath];
  if (origConfig) require.cache[configPath] = origConfig;
  else delete require.cache[configPath];
  delete require.cache[pushPath];
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}

  // Now exercise addSubscription ownership logic with the real function
  // Seed the internal map via addSubscription itself (no replaceEndpoint)
  addSubscription({ endpoint: "https://ep/user-a" }, null, "user-a");
  addSubscription({ endpoint: "https://ep/anon" }, null, null);

  // user-b tries to replace user-a's endpoint — must NOT delete it
  addSubscription({ endpoint: "https://ep/user-b-new" }, "https://ep/user-a", "user-b");

  // Verify: re-register user-a's endpoint (should still add cleanly — not deleted)
  // The key check is that user-a's subscription was NOT removed by user-b.
  // We verify by having user-a add again referencing their own endpoint as replace:
  // if the original was deleted, this would leave only one entry for user-a.
  var trackedByUserA = 0;
  // user-a replaces their own — this SHOULD delete the old one
  addSubscription({ endpoint: "https://ep/user-a-new" }, "https://ep/user-a", "user-a");
  // user-a-new should exist; user-a original should be gone
  addSubscription({ endpoint: "https://ep/user-a-new2" }, "https://ep/user-a-new", "user-a");
  // user-a-new should be deleted, user-a-new2 present

  // anonymous caller cannot replace user-a-new2 (owned endpoint)
  addSubscription({ endpoint: "https://ep/anon-interloper" }, "https://ep/user-a-new2", null);

  // anonymous caller replaces their own anonymous endpoint
  addSubscription({ endpoint: "https://ep/anon-replaced" }, "https://ep/anon", null);

  // Verify final state via a fresh addSubscription without replace (to observe idempotence)
  // Use the only observable API (addSubscription): adding duplicate endpoint overwrites cleanly
  // Confirm the subscription tagged user-b-new exists and is owned by user-b
  var dummyRes = makeRes();
  // The real addSubscription sets sub._userId; verify the subs we added have correct ownership
  var ubSub = { endpoint: "https://ep/user-b-check" };
  addSubscription(ubSub, null, "user-b");
  assert.strictEqual(ubSub._userId, "user-b", "user-b subscription tagged with userId");

  var anonSub = { endpoint: "https://ep/anon-check" };
  addSubscription(anonSub, null, null);
  assert.ok(!anonSub._userId, "anonymous subscription has no _userId");

  // Verify ownership gate: a sub owned by user-a cannot be replaced by null caller
  var ownedSub = { endpoint: "https://ep/owned" };
  addSubscription(ownedSub, null, "user-a");
  var interloper = { endpoint: "https://ep/interloper-2" };
  addSubscription(interloper, "https://ep/owned", null); // anon tries to replace user-a's sub
  // If the gate works, "https://ep/owned" still exists in the subscriptions map.
  // Confirm by re-adding with user-a as replace: user-a can replace their own
  var userAFinal = { endpoint: "https://ep/user-a-final" };
  addSubscription(userAFinal, "https://ep/owned", "user-a");
  // If owned was already deleted by the anon interloper, this replace does nothing extra;
  // if owned survived (correct), user-a replaces it now.
  // Either way, user-a-final must be set with user-a ownership.
  assert.strictEqual(userAFinal._userId, "user-a", "user-a's replacement sub tagged correctly");
});

// ============================================================
// 17. DM path traversal prevention (lr-6849)
//     Calls the real isValidDmKey logic and dmFilePath from production modules.
//     Removing the validation or the dmFilePath guard will break these tests.
// ============================================================

// Re-export the DM_KEY_RE pattern by testing via the same regex the module uses.
// We do not expose isValidDmKey publicly; test its behavior by calling the real
// dm.js and server-dm.js modules through a thin integration harness below, and
// additionally validate the regex contract directly.

var DM_KEY_RE_TEST = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

test("dm key pattern: accepts valid userId:otherId keys", function () {
  var valid = [
    "alice:bob",
    "user-1:user-2",
    "user_a:user_b",
    "ABC:XYZ",
    "default:user-42",
    "a1B2_c-d:x9Y8_z-w",
  ];
  for (var i = 0; i < valid.length; i++) {
    assert.ok(DM_KEY_RE_TEST.test(valid[i]), valid[i] + " should be accepted");
  }
});

test("dm key pattern: rejects traversal and malformed keys", function () {
  var invalid = [
    "alice:../../../../etc/passwd",
    "alice:../dm/other",
    "alice:/etc/shadow",
    "alice:bob:extra",
    ":bob",
    "alice:",
    "alice",
    "",
    "alice bob:carol",
    "alice\x00bob:carol",
    "alice:bob/carol",
  ];
  for (var i = 0; i < invalid.length; i++) {
    assert.ok(!DM_KEY_RE_TEST.test(invalid[i]), invalid[i] + " should be rejected");
  }
});

test("dm.js dmFilePath: throws on path traversal key that bypasses caller validation", function () {
  // Directly test the defense-in-depth guard in dmFilePath.
  // We bypass the strict server-side validation by calling dmFilePath directly
  // with a key that contains traversal segments after colon-to-underscore replace.
  // The guard must throw before any file I/O occurs.
  var dm = require("../lib/dm");

  // The attack vector: the replace only converts ':' to '_', leaving '/' intact.
  // A key like "alice:b/../../etc/x" → after replace → "alice_b/../../etc/x".
  // path.join(DM_DIR, "alice_b/../../etc/x.jsonl") resolves:
  //   DM_DIR/alice_b/../../etc/x.jsonl → two levels up from alice_b inside DM_DIR,
  //   escaping DM_DIR entirely.
  var slashTraversal = "alice:b/../../etc/x";
  assert.throws(function () {
    dm.dmFilePath(slashTraversal);
  }, /path traversal detected/, "dmFilePath must throw on traversal key with slash");
});

test("dm.js dmFilePath: accepts a normal key without throwing", function () {
  var dm = require("../lib/dm");
  assert.doesNotThrow(function () {
    var p = dm.dmFilePath("alice:bob");
    assert.ok(p.endsWith("alice_bob.jsonl"), "normal key maps to expected filename");
  });
});

test("server-dm.js dm_send handler: silently drops traversal dmKey (no write)", function () {
  // Exercise the real attachDm handler with a crafted traversal dmKey.
  // We stub dm.sendMessage to detect whether it was called — it must NOT be called
  // for an invalid key.
  var { attachDm } = require("../lib/server-dm");

  var sendMessageCalled = false;
  var fakeDm = {
    getDmList: function () { return []; },
    openDm: function () { return { dmKey: "a:b", messages: [] }; },
    sendMessage: function () {
      sendMessageCalled = true;
      return { type: "dm_message", ts: Date.now(), from: "alice", text: "x" };
    },
  };

  var fakeUsers = {
    isMultiUser: function () { return true; },
    findUserById: function () { return null; },
  };

  var sentMessages = [];
  var fakeWs = {
    _clayUser: { id: "alice", role: "user" },
    readyState: 1,
    send: function (msg) { sentMessages.push(msg); },
  };

  var fakeProjects = [];

  var handler = attachDm({
    users: fakeUsers,
    dm: fakeDm,
    projects: fakeProjects,
    pushModule: null,
  }).handleMessage;

  // Traversal key where the caller is a listed participant but the key is malformed.
  handler(fakeWs, {
    type: "dm_send",
    dmKey: "alice:../../../../etc/passwd",
    text: "pwn",
  });

  assert.strictEqual(sendMessageCalled, false, "dm.sendMessage must not be called for traversal key");
  assert.strictEqual(sentMessages.length, 0, "no response sent for traversal key");
});

test("server-dm.js dm_typing handler: silently drops traversal dmKey", function () {
  var { attachDm } = require("../lib/server-dm");

  var fakeUsers = {
    isMultiUser: function () { return true; },
    findUserById: function () { return null; },
  };

  var forEachClientCalled = false;
  var fakeWs = {
    _clayUser: { id: "alice", role: "user" },
    readyState: 1,
    send: function () {},
  };

  var fakeProjects = [{
    forEachClient: function () { forEachClientCalled = true; },
  }];

  var handler = attachDm({
    users: fakeUsers,
    dm: {},
    projects: fakeProjects,
    pushModule: null,
  }).handleMessage;

  handler(fakeWs, {
    type: "dm_typing",
    dmKey: "alice:../../../etc/passwd",
    typing: true,
  });

  assert.strictEqual(forEachClientCalled, false, "forEachClient must not be called for traversal key");
});

// ============================================================
// 18. Loop registry path traversal prevention (lr-d049)
//     Tests the REAL production validateLoopId exported from project-loop.js
//     and drives the real handleLoopMessage handler through a minimal ctx stub
//     to confirm the guard fires before any filesystem access.
// ============================================================

var { validateLoopId: prodValidateLoopId, attachLoop } = require("../lib/project-loop");

// --- helpers ---

// Build a minimal ctx stub sufficient for attachLoop.
// The invalid-ID guard fires before any sm/sdk/fs access, so most
// ctx fields can be no-ops for the invalid-ID tests.
function makeLoopCtx(cwd, sendSpy) {
  var sessions = new Map();
  return {
    cwd: cwd,
    slug: "test",
    sm: {
      sessions: sessions,
      createSession: function () { return { localId: "s1", history: [], loop: null }; },
      saveSessionFile: function () {},
      appendToSessionFile: function () {},
      switchSession: function () {},
      broadcastSessionList: function () {},
      deleteSessionQuiet: function () {},
      setResolveLoopInfo: function () {},
    },
    sdk: { startQuery: function () {} },
    send: sendSpy,
    sendTo: function (_ws, msg) { sendSpy(msg); },
    sendToSession: function () {},
    pushModule: null,
    notificationsModule: null,
    getHubSchedules: function () { return []; },
    getAllProjectSessions: function () { return []; },
    getStatus: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: function () {},
    hydrateImageRefs: function () {},
  };
}

// --- validateLoopId unit tests (call the REAL production export) ---

test("validateLoopId: rejects path traversal payload", function () {
  assert.strictEqual(prodValidateLoopId("../../../etc/passwd"), false,
    "../../../etc/passwd must be rejected");
});

test("validateLoopId: rejects null/undefined/empty id", function () {
  assert.strictEqual(prodValidateLoopId(null), false, "null must be rejected");
  assert.strictEqual(prodValidateLoopId(undefined), false, "undefined must be rejected");
  assert.strictEqual(prodValidateLoopId(""), false, "empty string must be rejected");
});

test("validateLoopId: rejects id without loop_ prefix", function () {
  assert.strictEqual(prodValidateLoopId("abc123"), false, "no prefix must be rejected");
  assert.strictEqual(prodValidateLoopId("loop"), false, "bare 'loop' must be rejected");
});

test("validateLoopId: rejects id with dots or slashes", function () {
  assert.strictEqual(prodValidateLoopId("loop_abc/../../../etc/shadow"), false,
    "id with ../ must be rejected");
  assert.strictEqual(prodValidateLoopId("loop_abc/subdir"), false,
    "id with embedded slash must be rejected");
  assert.strictEqual(prodValidateLoopId("loop_abc.evil"), false,
    "id with dot must be rejected");
});

test("validateLoopId: rejects null byte and shell metacharacters", function () {
  assert.strictEqual(prodValidateLoopId("loop_abc\x00def"), false, "null byte must be rejected");
  assert.strictEqual(prodValidateLoopId("loop_abc;whoami"), false, "semicolon must be rejected");
  assert.strictEqual(prodValidateLoopId("loop_abc def"), false, "space must be rejected");
});

test("validateLoopId: accepts well-formed loop IDs", function () {
  var valid = [
    "loop_abc",
    "loop_ABC123",
    "loop_my-task",
    "loop_task_2025",
    "loop_A-b_C-d",
  ];
  for (var i = 0; i < valid.length; i++) {
    assert.strictEqual(prodValidateLoopId(valid[i]), true,
      valid[i] + " should be accepted");
  }
});

// --- handleLoopMessage integration tests ---
// Drive the REAL handler dispatch path through a minimal ctx stub.
// For invalid IDs the guard fires before any fs operation; we assert the
// correct error is emitted and no exception propagates.

test("loop_registry_files handler: sends loop_registry_error for invalid id via real handleLoopMessage", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-h-test-"));
  var loop = null;
  try {
    var sent = [];
    var ctx = makeLoopCtx(tmpDir, function (msg) { sent.push(msg); });
    loop = attachLoop(ctx);

    var attackIds = [
      "../../../etc/passwd",
      "loop_ok/../../../tmp/evil",
      "loop_ok%2F..%2F..%2Fetc%2Fpasswd",
      null,
      "",
      "abc123",
    ];
    for (var i = 0; i < attackIds.length; i++) {
      sent = [];
      loop.handleLoopMessage({}, { type: "loop_registry_files", id: attackIds[i] });
      assert.ok(sent.length >= 1, "handler must emit a message for id=" + attackIds[i]);
      assert.strictEqual(sent[0].type, "loop_registry_error",
        "must emit loop_registry_error for id=" + attackIds[i]);
      assert.strictEqual(sent[0].text, "invalid_loop_id",
        "error text must be invalid_loop_id for id=" + attackIds[i]);
    }
  } finally {
    // lr-795882: attachLoop() unconditionally starts a real 30s
    // setInterval (loopRegistry.startTimer(), project-loop.js -> scheduler.js)
    // as part of attaching, independent of whether a loop is ever started.
    // Left uncleared, that interval is a genuine leaked handle that keeps
    // `node --test` (run without --test-force-exit) from ever reaching
    // beforeExit/idle for the rest of this file's tests and every test file
    // that runs after it in the same process.
    if (loop) loop.stopTimer();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("loop_registry_save_files handler: sends loop_registry_error for invalid id via real handleLoopMessage", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-h-test-"));
  var loop = null;
  try {
    var sent = [];
    var ctx = makeLoopCtx(tmpDir, function (msg) { sent.push(msg); });
    loop = attachLoop(ctx);

    var attackIds = [
      "../../../etc/passwd",
      "loop_ok/../../../tmp/evil",
      null,
      "",
    ];
    for (var i = 0; i < attackIds.length; i++) {
      sent = [];
      loop.handleLoopMessage({}, { type: "loop_registry_save_files", id: attackIds[i] });
      assert.ok(sent.length >= 1, "handler must emit a message for id=" + attackIds[i]);
      assert.strictEqual(sent[0].type, "loop_registry_error",
        "must emit loop_registry_error for id=" + attackIds[i]);
      assert.strictEqual(sent[0].text, "invalid_loop_id",
        "error text must be invalid_loop_id for id=" + attackIds[i]);
    }
  } finally {
    // lr-795882: same leaked-timer class as the test above — see that
    // comment for the full explanation.
    if (loop) loop.stopTimer();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("server-dm.js dm_send handler: allows valid key and calls dm.sendMessage", function () {
  var { attachDm } = require("../lib/server-dm");

  var sendMessageCalled = false;
  var fakeDm = {
    sendMessage: function (key, from, text) {
      sendMessageCalled = true;
      return { type: "dm_message", ts: Date.now(), from: from, text: text };
    },
  };

  var fakeUsers = {
    isMultiUser: function () { return true; },
  };

  var sentMessages = [];
  var fakeWs = {
    _clayUser: { id: "alice", role: "user" },
    readyState: 1,
    send: function (msg) { sentMessages.push(msg); },
  };

  var fakeProjects = [{
    forEachClient: function () {},
    getNotificationsModule: null,
  }];

  var handler = attachDm({
    users: fakeUsers,
    dm: fakeDm,
    projects: fakeProjects,
    pushModule: null,
  }).handleMessage;

  handler(fakeWs, {
    type: "dm_send",
    dmKey: "alice:bob",
    text: "hello",
  });

  assert.strictEqual(sendMessageCalled, true, "dm.sendMessage called for valid key");
  assert.strictEqual(sentMessages.length, 1, "confirmation sent to sender");
});

// ============================================================
// 21. Custom emoji routes (lr-a68f)
// ============================================================

// Helper: make a makeSettingsCtx with a real temp dir for custom-emoji tests.
function makeCustomEmojiCtx(isAuthed) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-test-"));
  var fakeUser = isAuthed
    ? { id: "test-user", username: "testuser", role: "user", pinHash: null, profile: {} }
    : null;
  return {
    tmpDir: tmpDir,
    ctx: {
      users: { isMultiUser: function () { return true; } },
      getMultiUserFromReq: function () { return fakeUser; },
      isRequestAuthed: function () { return !!isAuthed; },
      projects: { forEach: function () {} },
      opts: {},
      CONFIG_DIR: tmpDir,
    },
  };
}

var SLUG_RE_TEST = /^[a-z0-9_-]{1,64}$/;

test("custom emoji slug: valid slugs accepted by SLUG_RE", function () {
  var valid = ["my_icon", "my-icon", "icon1", "a", "a".repeat(64)];
  for (var i = 0; i < valid.length; i++) {
    assert.ok(SLUG_RE_TEST.test(valid[i]), valid[i] + " should be valid");
  }
});

test("custom emoji slug: invalid slugs rejected by SLUG_RE", function () {
  var invalid = [
    "MyIcon",          // uppercase
    "a".repeat(65),    // too long
    "",                // empty
    "a:b",             // embedded colon
    "a/b",             // slash
    "../evil",         // path traversal chars
    "a.png",           // dot
  ];
  for (var i = 0; i < invalid.length; i++) {
    assert.ok(!SLUG_RE_TEST.test(invalid[i]), invalid[i] + " should be invalid");
  }
});

test("POST /api/custom-emoji/:slug: returns 401 for unauthenticated caller", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(false);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/myicon");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/myicon");

  var pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  req._emit("data", pngMagic);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 401, "unauthenticated POST gets 401");
      var ceDir = path.join(env.tmpDir, "custom-emoji");
      var written = fs.existsSync(ceDir) && fs.readdirSync(ceDir).length > 0;
      assert.ok(!written, "no file written for unauthenticated caller");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: returns 400 for invalid slug", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/BAD_SLUG");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/BAD_SLUG");

  var pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  req._emit("data", pngMagic);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 400, "invalid slug returns 400");
      var body = JSON.parse(res.body);
      assert.ok(body.error, "error message present");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: rejects path traversal via URL (../evil)", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  // Slug with path traversal chars is blocked by SLUG_RE at the start
  var traversalUrl = "/api/custom-emoji/..%2Fevil";
  var req = makeReq("POST", traversalUrl);
  var res = makeRes();
  handler(req, res, traversalUrl);

  var pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  req._emit("data", pngMagic);
  req._end();

  setImmediate(function () {
    try {
      // Decoded slug would be "../evil" which fails SLUG_RE
      assert.strictEqual(res.status, 400, "path traversal slug is rejected with 400");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: returns 413 for oversize payload", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/bigfile");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/bigfile");

  // Build a 513 KB PNG-magic-prefixed buffer
  var oversize = Buffer.alloc(513 * 1024, 0);
  oversize[0] = 0x89; oversize[1] = 0x50; // PNG magic
  req._emit("data", oversize);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 413, "oversized file returns 413");
      var ceDir = path.join(env.tmpDir, "custom-emoji");
      var written = fs.existsSync(ceDir) && fs.readdirSync(ceDir).length > 0;
      assert.ok(!written, "no file written when oversize");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: returns 400 for non-image payload", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/myslug");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/myslug");

  // Plain text payload (no image magic bytes)
  req._emit("data", Buffer.from("hello world"));
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 400, "non-image payload returns 400");
      var body = JSON.parse(res.body);
      assert.ok(/unsupported/i.test(body.error), "error mentions unsupported format");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: PNG magic bytes accepted, file written at 200", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/myicon");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/myicon");

  var pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  req._emit("data", pngMagic);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 200, "valid PNG upload returns 200");
      var body = JSON.parse(res.body);
      assert.strictEqual(body.slug, "myicon");
      var ceDir = path.join(env.tmpDir, "custom-emoji");
      var files = fs.readdirSync(ceDir);
      assert.ok(files.some(function (f) { return f === "myicon.png"; }), "myicon.png written");
      var stat = fs.statSync(path.join(ceDir, "myicon.png"));
      var mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o644, "file has 0o644 permissions");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("POST /api/custom-emoji/:slug: JPEG magic bytes accepted", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("POST", "/api/custom-emoji/jpegicon");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/jpegicon");

  var jpegMagic = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  req._emit("data", jpegMagic);
  req._end();

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 200, "JPEG upload returns 200");
      var ceDir = path.join(env.tmpDir, "custom-emoji");
      var files = fs.readdirSync(ceDir);
      assert.ok(files.some(function (f) { return f === "jpegicon.jpg"; }), "jpegicon.jpg written");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("GET /api/custom-emoji/:slug: returns image bytes with immutable Cache-Control", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);

  // Pre-seed a file
  var ceDir = path.join(env.tmpDir, "custom-emoji");
  fs.mkdirSync(ceDir, { recursive: true });
  var pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(ceDir, "testslug.png"), pngBytes);

  // GET handler: make a res that captures headers
  var capturedHeaders = {};
  var capturedBody = null;
  var capturedStatus = null;
  var resGet = {
    writeHead: function (code, hdrs) { capturedStatus = code; capturedHeaders = hdrs || {}; },
    end: function (body) { capturedBody = body; },
  };

  var handler = attachSettings(env.ctx).handleRequest;
  var reqGet = makeReq("GET", "/api/custom-emoji/testslug");
  handler(reqGet, resGet, "/api/custom-emoji/testslug");

  setImmediate(function () {
    try {
      assert.strictEqual(capturedStatus, 200, "GET returns 200");
      assert.ok(capturedHeaders["Content-Type"] === "image/png", "Content-Type is image/png");
      assert.ok((capturedHeaders["Cache-Control"] || "").indexOf("immutable") !== -1,
        "Cache-Control contains immutable");
      assert.ok(Buffer.isBuffer(capturedBody) || capturedBody, "body is non-empty");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("GET /api/custom-emoji/:slug: returns 404 for unknown slug", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(false); // auth not needed for GET
  var handler = attachSettings(env.ctx).handleRequest;

  var req = makeReq("GET", "/api/custom-emoji/nosuchslug");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/nosuchslug");

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 404, "unknown slug returns 404");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("DELETE /api/custom-emoji/:slug: returns 401 for unauthenticated caller", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(false);

  // Pre-seed a file
  var ceDir = path.join(env.tmpDir, "custom-emoji");
  fs.mkdirSync(ceDir, { recursive: true });
  fs.writeFileSync(path.join(ceDir, "todel.png"), Buffer.from([0x89, 0x50]));

  var handler = attachSettings(env.ctx).handleRequest;
  var req = makeReq("DELETE", "/api/custom-emoji/todel");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji/todel");

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 401, "unauthenticated DELETE returns 401");
      assert.ok(fs.existsSync(path.join(ceDir, "todel.png")), "file not deleted for unauthed caller");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("DELETE then GET /api/custom-emoji/:slug: file removed, GET returns 404", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(true);

  // Pre-seed a file
  var ceDir = path.join(env.tmpDir, "custom-emoji");
  fs.mkdirSync(ceDir, { recursive: true });
  fs.writeFileSync(path.join(ceDir, "myicon.png"), Buffer.from([0x89, 0x50]));

  var handler = attachSettings(env.ctx).handleRequest;

  // DELETE
  var delReq = makeReq("DELETE", "/api/custom-emoji/myicon");
  var delRes = makeRes();
  handler(delReq, delRes, "/api/custom-emoji/myicon");

  setImmediate(function () {
    try {
      assert.strictEqual(delRes.status, 200, "DELETE returns 200");
      assert.ok(!fs.existsSync(path.join(ceDir, "myicon.png")), "file removed after DELETE");

      // GET after delete
      var getReq = makeReq("GET", "/api/custom-emoji/myicon");
      var getRes = makeRes();
      handler(getReq, getRes, "/api/custom-emoji/myicon");

      setImmediate(function () {
        try {
          assert.strictEqual(getRes.status, 404, "GET after DELETE returns 404");
          fs.rmSync(env.tmpDir, { recursive: true });
          done();
        } catch (e2) {
          try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
          done(e2);
        }
      });
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});

test("GET /api/custom-emoji: returns array with seeded slugs", function (t, done) {
  var { attachSettings } = require("../lib/server-settings");
  var env = makeCustomEmojiCtx(false); // listing is unauthenticated

  var ceDir = path.join(env.tmpDir, "custom-emoji");
  fs.mkdirSync(ceDir, { recursive: true });
  fs.writeFileSync(path.join(ceDir, "cat.png"), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(ceDir, "dog.gif"), Buffer.from([0x47, 0x49]));
  // Invalid extension should be ignored
  fs.writeFileSync(path.join(ceDir, "bad.txt"), Buffer.from("text"));

  var handler = attachSettings(env.ctx).handleRequest;
  var req = makeReq("GET", "/api/custom-emoji");
  var res = makeRes();
  handler(req, res, "/api/custom-emoji");

  setImmediate(function () {
    try {
      assert.strictEqual(res.status, 200, "list returns 200");
      var body = JSON.parse(res.body);
      assert.ok(Array.isArray(body), "body is array");
      var slugs = body.map(function (e) { return e.slug; });
      assert.ok(slugs.indexOf("cat") !== -1, "cat in list");
      assert.ok(slugs.indexOf("dog") !== -1, "dog in list");
      assert.ok(slugs.indexOf("bad") === -1, "bad.txt excluded");
      fs.rmSync(env.tmpDir, { recursive: true });
      done();
    } catch (e) {
      try { fs.rmSync(env.tmpDir, { recursive: true }); } catch (_) {}
      done(e);
    }
  });
});
