// daemon-ipc-memory-setter-parity-lr-553d27.test.js
//
// Regression tests for lr-553d27: the raw IPC socket cases for
// set_mem_available_threshold / set_tokens_per_mb_headroom used to silently
// CLAMP an out-of-range value to the default and report ok:true -- the same
// defect lr-93e3c8 already fixed on the WS/web path. The raw socket path is
// the documented operator escape hatch used when the UI can't save, so a
// lying ok:true there is worse than no escape hatch at all.
//
// TEST DISCIPLINE: "reports success while nothing happened" is this repo's
// dominant failure mode, so these tests do not stand in a copy of the case
// bodies. They spawn the REAL lib/daemon.js (same harness as
// project-asset-auth-fallback-lr-e33776.test.js) with an isolated
// CLAGENTIC_HOME and talk to its real daemon.sock, so the assertions cover
// the actual switch cases: the response shape, that a rejected value leaves
// the in-memory config untouched (the rejection response echoes the live
// value), and that a rejected value never reaches the persisted daemon.json.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var { spawn } = require("child_process");

var { sendIPCCommand } = require("../lib/ipc");

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var DAEMON_READY_MS = 20000;
var SETTLE_MS = 400;

var tmpHome = null;
var daemonProc = null;
var daemonLog = [];
var sockPath = null;
var configFile = null;

function findFreePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(0, "127.0.0.1", function () {
      var p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function waitForIpc(timeoutMs) {
  var start = Date.now();
  function attempt() {
    if (Date.now() - start > timeoutMs) {
      return Promise.reject(new Error("daemon IPC did not answer within " + timeoutMs + " ms\n" + daemonLog.slice(-30).join("")));
    }
    if (!fs.existsSync(sockPath)) return sleep(100).then(attempt);
    return sendIPCCommand(sockPath, { cmd: "get_status" }, 1000).then(function (resp) {
      return resp && resp.ok ? resp : sleep(100).then(attempt);
    });
  }
  return attempt();
}

function killAndWait(proc) {
  return new Promise(function (resolve) {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", resolve);
    try { proc.kill("SIGTERM"); } catch (_) {}
    setTimeout(function () {
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve();
    }, 4000);
  });
}

function readPersisted() {
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}

// saveConfig is an async queued write, so a positive persistence assertion
// must poll; the negative ("never persisted") assertions compare the file
// after a settle window.
function waitForPersisted(predicate, timeoutMs) {
  var start = Date.now();
  function attempt() {
    var cfg = readPersisted();
    if (predicate(cfg)) return Promise.resolve(cfg);
    if (Date.now() - start > timeoutMs) {
      return Promise.reject(new Error("persisted config never satisfied predicate: " + JSON.stringify(cfg)));
    }
    return sleep(50).then(attempt);
  }
  return attempt();
}

function send(msg) {
  return sendIPCCommand(sockPath, msg, 3000);
}

test.before(function () {
  return findFreePort().then(function (port) {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-553d27-"));
    var consoleDir = path.join(tmpHome, "console");
    fs.mkdirSync(consoleDir, { recursive: true });
    configFile = path.join(consoleDir, "daemon.json");
    sockPath = path.join(consoleDir, "daemon.sock");
    fs.writeFileSync(configFile, JSON.stringify({
      port: port,
      host: "127.0.0.1",
      tls: false,
      debug: false,
      projects: [],
      memAvailableMinMB: 256,
      tokensPerMbHeadroom: 240,
    }, null, 2), { mode: 0o600 });

    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, {
        CLAGENTIC_HOME: tmpHome,
        CLAGENTIC_CONFIG: configFile,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemonProc.stdout.on("data", function (d) { daemonLog.push(d.toString()); });
    daemonProc.stderr.on("data", function (d) { daemonLog.push("[err] " + d.toString()); });
    return waitForIpc(DAEMON_READY_MS);
  });
});

test.after(function () {
  var stop = daemonProc ? killAndWait(daemonProc) : Promise.resolve();
  return stop.then(function () {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});

// Asserts a rejected write: ok:false, error names the band, the response
// echoes the UNCHANGED live value (proves the in-memory config was not
// mutated), and the persisted file is byte-identical after a settle window
// (proves no save happened).
function assertRejected(cmd, value, valueKey, liveValue, bandPattern) {
  var before = fs.readFileSync(configFile, "utf8");
  return send({ cmd: cmd, value: value }).then(function (resp) {
    assert.equal(resp.ok, false, "an invalid value must be rejected, not silently clamped and reported as success");
    assert.match(resp.error, bandPattern, "the error must name the valid band");
    assert.equal(resp[valueKey], liveValue, "the response must echo the unchanged live value");
    return sleep(SETTLE_MS);
  }).then(function () {
    assert.equal(fs.readFileSync(configFile, "utf8"), before, "a rejected value must never be persisted");
  });
}

// ---------------------------------------------------------------------------
// set_mem_available_threshold
// ---------------------------------------------------------------------------

test("lr-553d27: set_mem_available_threshold rejects a negative value, live and persisted value unchanged", function () {
  return assertRejected("set_mem_available_threshold", -5, "memAvailableMinMB", 256, />=\s*0/);
});

test("lr-553d27: set_mem_available_threshold rejects a non-numeric value", function () {
  return assertRejected("set_mem_available_threshold", "not-a-number", "memAvailableMinMB", 256, /./);
});

test("lr-553d27: set_mem_available_threshold rejects a garbage-suffixed numeric string instead of truncate-parsing it", function () {
  return assertRejected("set_mem_available_threshold", "128xyz", "memAvailableMinMB", 256, /./);
});

test("lr-553d27: set_mem_available_threshold rejects a 400-digit string (parseInt Infinity would serialize as null)", function () {
  return assertRejected("set_mem_available_threshold", "9".repeat(400), "memAvailableMinMB", 256, /./);
});

test("lr-553d27: set_tokens_per_mb_headroom rejects a 400-digit string", function () {
  return assertRejected("set_tokens_per_mb_headroom", "9".repeat(400), "tokensPerMbHeadroom", 240, /10-500/);
});

test("lr-553d27: set_mem_available_threshold accepts an in-range value and persists it; 0 (disable) is also accepted", function () {
  return send({ cmd: "set_mem_available_threshold", value: 512 }).then(function (resp) {
    assert.equal(resp.ok, true);
    assert.equal(resp.memAvailableMinMB, 512);
    return waitForPersisted(function (c) { return c.memAvailableMinMB === 512; }, 3000);
  }).then(function () {
    return send({ cmd: "set_mem_available_threshold", value: 0 });
  }).then(function (resp) {
    assert.equal(resp.ok, true, "0 is a legitimate 'disable this gate' value");
    assert.equal(resp.memAvailableMinMB, 0);
    return waitForPersisted(function (c) { return c.memAvailableMinMB === 0; }, 3000);
  });
});

// ---------------------------------------------------------------------------
// set_tokens_per_mb_headroom
// ---------------------------------------------------------------------------

test("lr-553d27: set_tokens_per_mb_headroom rejects 1000 (the plausible operator value) naming the 10-500 band, live and persisted value unchanged", function () {
  return assertRejected("set_tokens_per_mb_headroom", 1000, "tokensPerMbHeadroom", 240, /10-500/);
});

test("lr-553d27: set_tokens_per_mb_headroom rejects a value below the band", function () {
  return assertRejected("set_tokens_per_mb_headroom", 5, "tokensPerMbHeadroom", 240, /10-500/);
});

test("lr-553d27: set_tokens_per_mb_headroom rejects a garbage-suffixed numeric string instead of truncate-parsing it to 300", function () {
  return assertRejected("set_tokens_per_mb_headroom", "300abc", "tokensPerMbHeadroom", 240, /10-500/);
});

test("lr-553d27: set_tokens_per_mb_headroom accepts in-range numbers and clean numeric strings and persists them", function () {
  return send({ cmd: "set_tokens_per_mb_headroom", value: 300 }).then(function (resp) {
    assert.equal(resp.ok, true);
    assert.equal(resp.tokensPerMbHeadroom, 300);
    return waitForPersisted(function (c) { return c.tokensPerMbHeadroom === 300; }, 3000);
  }).then(function () {
    return send({ cmd: "set_tokens_per_mb_headroom", value: "310" });
  }).then(function (resp) {
    assert.equal(resp.ok, true, "a clean numeric string must still be accepted");
    assert.equal(resp.tokensPerMbHeadroom, 310);
    return waitForPersisted(function (c) { return c.tokensPerMbHeadroom === 310; }, 3000);
  });
});

// ---------------------------------------------------------------------------
// Source-parity check, supplementary to the behavioral tests above: both the
// raw IPC cases and the WS/web handlers must call the SAME shared validators
// so the two contracts cannot silently diverge again.
// ---------------------------------------------------------------------------

test("lib/daemon.js: raw IPC cases and WS/web handlers all call the shared memory-setting-validate.js functions", function () {
  var daemonSrc = fs.readFileSync(DAEMON_SCRIPT, "utf8");
  assert.match(daemonSrc, /require\(["']\.\/memory-setting-validate["']\)/);

  function body(marker, endMarker) {
    var start = daemonSrc.indexOf(marker);
    assert.ok(start !== -1, "expected " + marker + " in lib/daemon.js");
    return daemonSrc.slice(start, daemonSrc.indexOf(endMarker, start + 1));
  }

  assert.match(body('case "set_mem_available_threshold"', "case "), /validateMemAvailableThresholdMB\(/);
  assert.match(body('case "set_tokens_per_mb_headroom"', "case "), /validateTokensPerMbHeadroom\(/);
  assert.match(body("onSetMemAvailableThreshold: function", "\n  },"), /validateMemAvailableThresholdMB\(/);
  assert.match(body("onSetTokensPerMbHeadroom: function", "\n  },"), /validateTokensPerMbHeadroom\(/);
});
