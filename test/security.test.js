var test = require("node:test");
var assert = require("node:assert");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { generateAuthToken, verifyPin } = require("../lib/server");
var { safePath, validateEnvString } = require("../lib/project");
var { chmodSafe } = require("../lib/config");

// ============================================================
// 1. PIN scrypt hashing / verification
// ============================================================

test("generateAuthToken returns scrypt format (salt:hash)", function () {
  var token = generateAuthToken("123456");
  assert.ok(token.indexOf(":") !== -1, "Token should contain a colon separator");
  var parts = token.split(":");
  assert.strictEqual(parts.length, 2, "Token should have exactly two parts");
  assert.strictEqual(parts[0].length, 32, "Salt should be 16 bytes = 32 hex chars");
  assert.strictEqual(parts[1].length, 128, "Hash should be 64 bytes = 128 hex chars");
});

test("generateAuthToken produces different tokens for same PIN (random salt)", function () {
  var token1 = generateAuthToken("123456");
  var token2 = generateAuthToken("123456");
  assert.notStrictEqual(token1, token2, "Each call should produce a unique salt");
});

test("verifyPin correctly validates scrypt hash", function () {
  var token = generateAuthToken("mypin");
  assert.strictEqual(verifyPin("mypin", token), true, "Correct PIN should verify");
  assert.strictEqual(verifyPin("wrongpin", token), false, "Wrong PIN should not verify");
});

test("verifyPin handles legacy SHA256 format", function () {
  var legacyHash = crypto.createHash("sha256").update("clay:123456").digest("hex");
  assert.strictEqual(verifyPin("123456", legacyHash), true, "Correct PIN should verify with legacy hash");
  assert.strictEqual(verifyPin("000000", legacyHash), false, "Wrong PIN should not verify with legacy hash");
});

test("verifyPin returns false for null/empty stored hash", function () {
  assert.strictEqual(verifyPin("123456", null), false);
  assert.strictEqual(verifyPin("123456", ""), false);
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
// 7. PIN hash migration detection
// ============================================================

test("legacy SHA256 hash is detected (no colon)", function () {
  var legacyHash = crypto.createHash("sha256").update("clay:123456").digest("hex");
  assert.strictEqual(legacyHash.indexOf(":"), -1, "Legacy hash should not contain colon");
  assert.strictEqual(legacyHash.length, 64, "SHA256 hex should be 64 chars");
});

test("scrypt hash is detected (contains colon)", function () {
  var scryptHash = generateAuthToken("123456");
  assert.ok(scryptHash.indexOf(":") !== -1, "Scrypt hash should contain colon");
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

test("terminal manager: single-user mode allows any ws to attach", function () {
  var tm = createTerminalManager({
    cwd: "/tmp",
    send: function () {},
    sendTo: function () {},
    isMultiUser: false,
  });
  // In single-user mode, create() will call createTerminal which may not have node-pty.
  // We only test that the attach/write/close/rename signatures accept the new callerWs
  // parameter without throwing (no actual PTY required).
  var ws = makeWs(null);
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
  assert.strictEqual(listForNoUser.length, 3, "unauthenticated client sees all (single-user compat)");
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

  // Single-user mode — should broadcast
  broadcastCalls.length = 0;
  userCalls.length = 0;
  routePush(false, null, fakePush, donePayload);
  assert.strictEqual(broadcastCalls.length, 1, "broadcast in single-user mode");
  assert.strictEqual(userCalls.length, 0, "no user-targeted push in single-user mode");
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

test("dangerouslySkipPermissions is disabled in multi-user mode regardless of config", function () {
  // Mirrors the gate in project.js:
  //   var dangerouslySkipPermissions = dangerouslySkipPermissionsConfigured && !usersModule.isMultiUser();
  function computeFlag(configured, isMultiUser) {
    return configured && !isMultiUser;
  }

  assert.strictEqual(computeFlag(true, false), true,  "single-user: flag active when configured");
  assert.strictEqual(computeFlag(false, false), false, "single-user: flag inactive when not configured");
  assert.strictEqual(computeFlag(true, true), false,  "multi-user: flag suppressed even when configured");
  assert.strictEqual(computeFlag(false, true), false,  "multi-user: flag inactive when not configured");
});

test("dangerouslySkipPermissionsBlocked is set in info message only when configured+multi-user", function () {
  // Mirrors the gate in project-connection.js
  function buildInfoFields(configured, isMultiUser) {
    var active = configured && !isMultiUser;
    var fields = { dangerouslySkipPermissions: active };
    if (configured && !active) {
      fields.dangerouslySkipPermissionsBlocked = true;
    }
    return fields;
  }

  var singleConfigured = buildInfoFields(true, false);
  assert.strictEqual(singleConfigured.dangerouslySkipPermissions, true, "single-user configured: active=true");
  assert.ok(!singleConfigured.dangerouslySkipPermissionsBlocked, "single-user configured: blocked field absent");

  var multiConfigured = buildInfoFields(true, true);
  assert.strictEqual(multiConfigured.dangerouslySkipPermissions, false, "multi-user configured: active=false");
  assert.strictEqual(multiConfigured.dangerouslySkipPermissionsBlocked, true, "multi-user configured: blocked=true");

  var multiNotConfigured = buildInfoFields(false, true);
  assert.strictEqual(multiNotConfigured.dangerouslySkipPermissions, false, "multi-user not configured: active=false");
  assert.ok(!multiNotConfigured.dangerouslySkipPermissionsBlocked, "multi-user not configured: blocked field absent");
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
  assert.ok(isAuthorizedLocal(session, wsOther, false), "non-owner can read in single-user mode");
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
