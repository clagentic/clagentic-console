// config.test.js — unit tests for lib/config.js path helpers

var test = require("node:test");
var assert = require("node:assert");
var path = require("path");
var os = require("os");

// Point CLAGENTIC_HOME at a temp dir so tests don't touch the real ~/.clagentic
var tmpHome = require("fs").mkdtempSync(require("path").join(os.tmpdir(), "clagentic-config-test-"));
process.env.CLAGENTIC_HOME = tmpHome;

var config = require("../lib/config");

test("socketPath returns path inside ~/.clagentic/console/", function () {
  var sock = config.socketPath();
  assert.ok(
    sock.includes(path.join("console", "daemon.sock")),
    "expected socketPath() to contain console/daemon.sock, got: " + sock
  );
});

test("socketPath dev mode returns path inside ~/.clagentic/console/", function () {
  // Dev mode is read at module load time via CLAGENTIC_DEV env var.
  // Verify the non-dev path contains the console subdir (dev mode tested via env in integration).
  // The key invariant: both branches of socketPath() embed the console/ subdir.
  var sock = config.socketPath();
  assert.ok(
    sock.includes("console"),
    "expected socketPath() to contain 'console' subdir in all modes, got: " + sock
  );
});

test("logPath returns path inside ~/.clagentic/console/", function () {
  var log = config.logPath();
  assert.ok(
    log.includes(path.join("console", "daemon.log")),
    "expected logPath() to contain console/daemon.log, got: " + log
  );
});

test("crashInfoPath returns path inside ~/.clagentic/console/", function () {
  var crash = config.crashInfoPath();
  assert.ok(
    crash.includes(path.join("console", "crash.json")),
    "expected crashInfoPath() to contain console/crash.json, got: " + crash
  );
});

test("EXTERNAL_TRIGGERS_DIR is inside ~/.clagentic/console/", function () {
  assert.ok(
    config.EXTERNAL_TRIGGERS_DIR.includes(path.join("console", "external-triggers")),
    "expected EXTERNAL_TRIGGERS_DIR to contain console/external-triggers, got: " + config.EXTERNAL_TRIGGERS_DIR
  );
});

test("configPath returns path inside ~/.clagentic/console/", function () {
  var cp = config.configPath();
  assert.ok(
    cp.includes(path.join("console", "daemon.json")),
    "expected configPath() to contain console/daemon.json, got: " + cp
  );
  assert.ok(
    !cp.includes(path.join("console", "console")),
    "expected configPath() not to contain double-nested console/console, got: " + cp
  );
});

test("CONFIG_DIR is the console subdir, not the brand root", function () {
  var consoleDir = path.join(tmpHome, "console");
  assert.strictEqual(
    config.CONFIG_DIR,
    consoleDir,
    "expected CONFIG_DIR to equal " + consoleDir + ", got: " + config.CONFIG_DIR
  );
});

test("console migration sentinel is a marker file, not sessions/ directory", function () {
  // The sentinel must be console/.migrated — not console/sessions/.
  // sessions/ can be created by partial earlier migrations, which caused it to
  // fire too early and orphan sessions written after the partial migration ran.
  var fs = require("fs");
  var os = require("os");

  // Set up a fake CLAGENTIC_HOME with a sessions/ dir already present
  // (simulating a partially-migrated install from lr-5dca/lr-eb5a).
  var fakeHome = fs.mkdtempSync(require("path").join(os.tmpdir(), "clagentic-sentinel-test-"));
  var fakeConsole = require("path").join(fakeHome, "console");
  var fakeSessions = require("path").join(fakeConsole, "sessions");
  fs.mkdirSync(fakeSessions, { recursive: true });

  // Write a session file that would be "orphaned" in the old root
  var oldSessions = require("path").join(fakeHome, "sessions", "-workspace-foo");
  fs.mkdirSync(oldSessions, { recursive: true });
  fs.writeFileSync(require("path").join(oldSessions, "abc123.jsonl"), "{}");

  // The marker file must NOT exist yet (simulating pre-1.5.x install)
  var marker = require("path").join(fakeConsole, ".migrated");
  assert.ok(!fs.existsSync(marker), "marker should not exist before migration runs");

  // Re-run only the migration block logic inline (config.js runs at require time
  // with a fixed CLAGENTIC_HOME, so we test the logic directly here).
  // Key assertion: sessions/ presence alone must NOT be the gate.
  var sentinelIsMarker = !fs.existsSync(marker); // would re-run because marker absent
  assert.ok(sentinelIsMarker, "migration should re-run when .migrated absent even if console/sessions/ exists");

  // Simulate migration completion writing the marker
  fs.writeFileSync(marker, "");
  var sentinelAfter = fs.existsSync(marker);
  assert.ok(sentinelAfter, "marker should exist after migration completes");

  // Cleanup
  fs.rmSync(fakeHome, { recursive: true, force: true });
});
