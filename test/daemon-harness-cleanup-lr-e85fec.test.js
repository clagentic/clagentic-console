"use strict";

// The harness must not hide a daemon it cannot account for: an unreadable
// daemon.json, or a restart case with no recorded successor, fails the test.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var { spawn } = require("child_process");

var { bootDaemon, waitForExit, pidAlive } = require("./fixtures/daemon-harness");
var { TOKEN_ENV, newHarnessToken, verifyOwnedPid } = require("./fixtures/process-ownership");

test("a partial daemon.json fails cleanup, naming the path", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  var file = path.join(d.consoleDir, "daemon.json");
  fs.writeFileSync(file, '{"pid": 12');
  await assert.rejects(d.cleanup(), function (e) {
    assert.ok(e.message.indexOf(file) !== -1, e.message);
    return true;
  });
  assert.equal(fs.existsSync(d.home), false, "its home is removed");
  await waitForExit(d.proc, 5000);
  assert.equal(pidAlive(d.proc.pid), false, "the daemon process is gone");
});

var HOLD = "setTimeout(function () {}, 60000)";

test("ownership is the exact token: a near-miss or absent token is not owned", { timeout: 30000 }, async function () {
  var token = newHarnessToken();
  var near = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore", env: Object.assign({}, process.env, { [TOKEN_ENV]: token + "0" }) });
  var prefix = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore", env: Object.assign({}, process.env, { [TOKEN_ENV]: token.slice(0, -1) }) });
  var owned = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore", env: Object.assign({}, process.env, { [TOKEN_ENV]: token }) });
  try {
    assert.equal(verifyOwnedPid(owned.pid, token).ok, true);
    assert.equal(verifyOwnedPid(near.pid, token).ok, false, "a longer token is not the token");
    assert.equal(verifyOwnedPid(prefix.pid, token).ok, false, "a shorter token is not the token");
    assert.equal(verifyOwnedPid(process.pid, token).ok, false, "this process does not carry the token");
    assert.equal(verifyOwnedPid(owned.pid, "").ok, false, "no token verifies nothing");
    assert.equal(verifyOwnedPid(2147483646, token).ok, false, "an unreadable /proc entry is unverified");
  } finally {
    near.kill("SIGKILL");
    prefix.kill("SIGKILL");
    owned.kill("SIGKILL");
  }
});

test("a pid in daemon.json that is not the test daemon is reported and never signalled", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  // Same command line and a near-miss token: only exact equality may pass.
  var bystander = spawn(process.execPath, ["-e", HOLD], {
    stdio: "ignore",
    env: Object.assign({}, process.env, { [TOKEN_ENV]: d.token + "0" }),
  });
  try {
    var file = path.join(d.consoleDir, "daemon.json");
    var cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.pid = bystander.pid;
    fs.writeFileSync(file, JSON.stringify(cfg));
    await assert.rejects(d.cleanup(), function (e) {
      assert.ok(e.message.indexOf("pid " + bystander.pid) !== -1, e.message);
      assert.match(e.message, /not signalled/);
      return true;
    });
    await new Promise(function (r) { setTimeout(r, 300); });
    assert.equal(bystander.exitCode, null, "the unrelated process was left running");
    assert.equal(pidAlive(bystander.pid), true);
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("a restart case that recorded no successor pid fails cleanup", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  d.expectSelfSpawn();
  await assert.rejects(d.cleanup(), /no successor pid/);
});

test("a case that expects no self-spawn cleans up quietly", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  await d.cleanup();
});
