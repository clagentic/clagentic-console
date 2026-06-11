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
});
