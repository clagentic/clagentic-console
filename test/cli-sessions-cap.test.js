// Tests for listCliSessions() recency cap and count cap.
// Uses a real temp directory with real .jsonl files so no fs mocking is needed.
// parseSessionFile reads the first ~20 lines; we write minimal valid content.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// Patch config before requiring cli-sessions so REAL_HOME points to our
// temp tree. Same technique used in store.test.js.
// ---------------------------------------------------------------------------

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-sessions-cap-test-"));

var configModPath = require.resolve("../lib/config");
var originalConfigMod = require.cache[configModPath];

require.cache[configModPath] = {
  id: configModPath,
  filename: configModPath,
  loaded: true,
  exports: Object.assign({}, require(configModPath), { REAL_HOME: tmpRoot }),
};

// Clear cli-sessions from cache so it picks up the patched config.
var cliSessionsModPath = require.resolve("../lib/cli-sessions");
delete require.cache[cliSessionsModPath];
var cliSessions = require("../lib/cli-sessions");

// Restore original config cache entry.
if (originalConfigMod) {
  require.cache[configModPath] = originalConfigMod;
} else {
  delete require.cache[configModPath];
}

// Pull the constants out of the module so the tests are not hardcoded to magic numbers.
// cli-sessions.js does not export them, so we read the source to get the values.
// Instead, use known values (200 / 90 days / 20) matching the module constants.
var MAX_CLI_SESSIONS = 200;
var CLI_SESSION_MAX_AGE_DAYS = 90;
var CLI_SESSION_MAX_AGE_MS = CLI_SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// encodeCwd is exported from cli-sessions (re-exported from utils).
var encodeCwd = cliSessions.encodeCwd;

// A minimal valid JSONL session line (one user message so parseSessionFile
// considers this file non-empty and returns a result).
function minimalSessionLine(sessionId) {
  return JSON.stringify({
    type: "user",
    sessionId: sessionId,
    timestamp: new Date().toISOString(),
    gitBranch: null,
    message: { role: "user", content: "hello" },
  });
}

// Create a project directory under our patched REAL_HOME.
function makeProjectDir(cwd) {
  var encoded = encodeCwd(cwd);
  var dir = path.join(tmpRoot, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write a .jsonl file at `filePath` and then touch its mtime to `date`.
function writeSession(filePath, date) {
  var sessionId = path.basename(filePath, ".jsonl");
  fs.writeFileSync(filePath, minimalSessionLine(sessionId) + "\n");
  // Adjust mtime so the recency filter sees the right age.
  fs.utimesSync(filePath, date, date);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
}

process.on("exit", cleanup);

// ---------------------------------------------------------------------------
// Test 1 — Cap enforced: 300 files all within 90 days → at most 200 parsed
// ---------------------------------------------------------------------------

test("listCliSessions: cap at MAX_CLI_SESSIONS (200) when 300 recent files exist", function (t, done) {
  var cwd = "/fake/project/cap-test";
  var dir = makeProjectDir(cwd);
  var now = new Date();

  for (var i = 0; i < 300; i++) {
    var sessionId = "session-cap-" + String(i).padStart(4, "0");
    // Spread mtimes across the last 80 days so all pass the recency filter.
    var ageDays = i % 80;
    var mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    writeSession(path.join(dir, sessionId + ".jsonl"), mtime);
  }

  cliSessions.listCliSessions(cwd).then(function (sessions) {
    assert.ok(
      sessions.length <= MAX_CLI_SESSIONS,
      "should return at most " + MAX_CLI_SESSIONS + " sessions, got " + sessions.length
    );
    assert.ok(
      sessions.length > 0,
      "should return at least one session"
    );
    done();
  }).catch(done);
});

// ---------------------------------------------------------------------------
// Test 2 — Age filter: files older than 90 days are excluded
// ---------------------------------------------------------------------------

test("listCliSessions: excludes files older than CLI_SESSION_MAX_AGE_MS", function (t, done) {
  var cwd = "/fake/project/age-test";
  var dir = makeProjectDir(cwd);

  // 50 files within 90 days
  for (var i = 0; i < 50; i++) {
    var sessionId = "session-recent-" + String(i).padStart(3, "0");
    var ageDays = i % 89; // 0 – 88 days old, all within limit
    var mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    writeSession(path.join(dir, sessionId + ".jsonl"), mtime);
  }

  // 50 files older than 90 days
  for (var j = 0; j < 50; j++) {
    var staleId = "session-stale-" + String(j).padStart(3, "0");
    // 91 to 140 days old — all beyond the cutoff
    var staleDays = 91 + j;
    var staleMtime = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    writeSession(path.join(dir, staleId + ".jsonl"), staleMtime);
  }

  cliSessions.listCliSessions(cwd).then(function (sessions) {
    // Only the 50 recent files should survive the age filter.
    assert.ok(
      sessions.length <= 50,
      "should return at most 50 sessions (the recent ones), got " + sessions.length
    );
    assert.ok(
      sessions.length > 0,
      "should return at least one session"
    );

    // Confirm no stale sessions leaked through.
    sessions.forEach(function (s) {
      assert.ok(
        !s.sessionId.startsWith("session-stale-"),
        "stale session should not appear in results: " + s.sessionId
      );
    });

    done();
  }).catch(done);
});

// ---------------------------------------------------------------------------
// Test 3 — Empty dir: returns []
// ---------------------------------------------------------------------------

test("listCliSessions: empty directory returns empty array", function (t, done) {
  var cwd = "/fake/project/empty-test";
  makeProjectDir(cwd);

  cliSessions.listCliSessions(cwd).then(function (sessions) {
    assert.deepStrictEqual(sessions, [], "empty dir should return []");
    done();
  }).catch(done);
});

// ---------------------------------------------------------------------------
// Test 4 — Missing dir: returns [] without throwing
// ---------------------------------------------------------------------------

test("listCliSessions: non-existent project dir returns empty array", function (t, done) {
  var cwd = "/fake/project/does-not-exist";

  cliSessions.listCliSessions(cwd).then(function (sessions) {
    assert.deepStrictEqual(sessions, [], "missing dir should return []");
    done();
  }).catch(done);
});
