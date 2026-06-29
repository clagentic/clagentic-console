// lite-detect.test.js — unit tests for lib/lite-detect.js
//
// Uses temp directories to simulate presence/absence of the Lite home dir
// and the per-project enrollment marker without touching the real filesystem.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---- helpers ----

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Reload the module with a fresh CLAGENTIC_HOME to avoid cross-test pollution.
// Node's require cache means we must delete the cached module and config after
// each scenario that changes env vars.
function requireFresh(mod) {
  // Clear the module from the require cache so it re-evaluates with the current env.
  var resolved = require.resolve(mod);
  delete require.cache[resolved];
  // Also clear config.js which caches REAL_HOME at load time.
  var configResolved = require.resolve("../lib/config");
  delete require.cache[configResolved];
  return require(mod);
}

// ---- detectLite ----

test("detectLite returns installed=false when CLAGENTIC_HOME points to an empty tmp dir (no lite subdir)", function () {
  var tmpDir = mktemp("clagentic-detect-no-lite-");
  process.env.CLAGENTIC_HOME = tmpDir;
  var ld = requireFresh("../lib/lite-detect");
  var result = ld.detectLite();
  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.liteHome, null);
});

test("detectLite returns installed=false when lite dir exists but binary does not", function () {
  var tmpDir = mktemp("clagentic-detect-dir-no-bin-");
  // Lite home is now a sibling of console/ under CLAGENTIC_HOME (lr-6204, lr-dc6c).
  // Create ~/.clagentic/lite/ (= CLAGENTIC_HOME/lite) — NOT under console/.
  fs.mkdirSync(path.join(tmpDir, "lite"), { recursive: true });
  process.env.CLAGENTIC_HOME = tmpDir;
  // Override PATH so `which clagentic-lite` cannot find anything
  var savedPath = process.env.PATH;
  process.env.PATH = tmpDir; // empty dir, no binary there
  var ld = requireFresh("../lib/lite-detect");
  // liteHomeDirExists() returns true but binaryExists() returns false
  var homeExists = ld.liteHomeDirExists();
  var binExists = ld.binaryExists();
  assert.strictEqual(homeExists, true, "lite home dir should exist");
  assert.strictEqual(binExists, false, "binary should not be found");
  var result = ld.detectLite();
  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.liteHome, null);
  process.env.PATH = savedPath;
});

test("detectLite returns installed=true when both lite dir and binary candidate exist", function () {
  var tmpDir = mktemp("clagentic-detect-full-");
  // Lite home is at CLAGENTIC_HOME/lite (sibling of console/, not nested under it).
  var liteDir = path.join(tmpDir, "lite");
  fs.mkdirSync(liteDir, { recursive: true });
  // Create a fake clagentic-lite binary in a candidate path (~/.local/bin or ~/bin).
  // We can't patch REAL_HOME easily (it comes from process.env.HOME or os.homedir()),
  // so instead we plant the binary in a temp bin dir and put it on PATH.
  var binDir = mktemp("clagentic-fake-bin-");
  var binaryPath = path.join(binDir, "clagentic-lite");
  fs.writeFileSync(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
  process.env.CLAGENTIC_HOME = tmpDir;
  var savedPath = process.env.PATH;
  process.env.PATH = binDir + path.delimiter + savedPath;
  var ld = requireFresh("../lib/lite-detect");
  var result = ld.detectLite();
  assert.strictEqual(result.installed, true);
  assert.strictEqual(result.liteHome, liteDir);
  process.env.PATH = savedPath;
});

test("getLiteHome respects CLAGENTIC_HOME (returns lite/ sibling, NOT console/lite)", function () {
  var tmpDir = mktemp("clagentic-home-test-");
  process.env.CLAGENTIC_HOME = tmpDir;
  var ld = requireFresh("../lib/lite-detect");
  var home = ld.getLiteHome();
  // Lite is a sibling of console/ under CLAGENTIC_HOME (lr-6204, lr-dc6c).
  // getLiteHome() returns CLAGENTIC_HOME/lite (NOT CLAGENTIC_HOME/console/lite).
  assert.strictEqual(home, path.join(tmpDir, "lite"));
});

test("getLiteHome respects CLAGENTIC_LITE_HOME env override", function () {
  var tmpDir = mktemp("clagentic-lite-home-override-");
  var savedLiteHome = process.env.CLAGENTIC_LITE_HOME;
  process.env.CLAGENTIC_LITE_HOME = tmpDir;
  var ld = requireFresh("../lib/lite-detect");
  var home = ld.getLiteHome();
  assert.strictEqual(home, tmpDir);
  if (savedLiteHome !== undefined) {
    process.env.CLAGENTIC_LITE_HOME = savedLiteHome;
  } else {
    delete process.env.CLAGENTIC_LITE_HOME;
  }
});

// ---- isProjectEnrolled ----

test("isProjectEnrolled returns false when projectDir is null", function () {
  var ld = requireFresh("../lib/lite-detect");
  assert.strictEqual(ld.isProjectEnrolled(null), false);
});

test("isProjectEnrolled returns false when projectDir does not contain audit.db", function () {
  var tmpDir = mktemp("clagentic-enroll-no-db-");
  var ld = requireFresh("../lib/lite-detect");
  assert.strictEqual(ld.isProjectEnrolled(tmpDir), false);
});

test("isProjectEnrolled returns false when .clagentic/lite/ exists but audit.db is absent", function () {
  var tmpDir = mktemp("clagentic-enroll-dir-no-db-");
  fs.mkdirSync(path.join(tmpDir, ".clagentic", "lite"), { recursive: true });
  var ld = requireFresh("../lib/lite-detect");
  assert.strictEqual(ld.isProjectEnrolled(tmpDir), false);
});

test("isProjectEnrolled returns true when .clagentic/lite/audit.db exists", function () {
  var tmpDir = mktemp("clagentic-enroll-with-db-");
  var liteDir = path.join(tmpDir, ".clagentic", "lite");
  fs.mkdirSync(liteDir, { recursive: true });
  fs.writeFileSync(path.join(liteDir, "audit.db"), "");
  var ld = requireFresh("../lib/lite-detect");
  assert.strictEqual(ld.isProjectEnrolled(tmpDir), true);
});

test("isProjectEnrolled does not throw on non-existent projectDir", function () {
  var ld = requireFresh("../lib/lite-detect");
  var result;
  assert.doesNotThrow(function () {
    result = ld.isProjectEnrolled("/tmp/definitely-does-not-exist-clagentic-test-xyz");
  });
  assert.strictEqual(result, false);
});
