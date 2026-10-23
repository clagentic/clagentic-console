"use strict";
// The shared temp-home removal: a writer that is still running when a test
// thinks it is done must be waited for, never raced with, and a writer that
// does not stop must fail the test naming its pid.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawn } = require("child_process");

var { removeTempHome, pidAlive } = require("./helpers/remove-temp-home");
var { TOKEN_ENV, newHarnessToken } = require("./fixtures/process-ownership");

// lib/store loads lib/config, which reads and may migrate files under the
// console home; keep that off the operator's real one.
var STORE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "console-remove-home-cfg-"));
process.env.CLAGENTIC_CONSOLE_HOME = STORE_HOME;
delete process.env.CLAGENTIC_HOME;
var { writeJsonAt } = require("../lib/store");

test.after(function () { fs.rmSync(STORE_HOME, { recursive: true, force: true }); });

var LATE_WRITER = [
  "var fs = require('fs'); var home = process.argv[1];",
  "setTimeout(function () {",
  "  fs.mkdirSync(home + '/console/late', { recursive: true });",
  "  fs.writeFileSync(home + '/console/late/state.json', '{}');",
  "}, 300);",
].join("\n");

function makeHome() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-remove-home-"));
  fs.mkdirSync(path.join(home, "console"), { recursive: true });
  return home;
}

function lateWriter(home) {
  return spawn(process.execPath, ["-e", LATE_WRITER, home], { stdio: "ignore" });
}

test("a bare removal races a writer that finishes after it: the home comes back", async function () {
  var home = makeHome();
  var child = lateWriter(home);
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    assert.equal(fs.existsSync(home), false, "the bare removal itself succeeded");
    await new Promise(function (resolve) { child.once("exit", resolve); });
    assert.equal(fs.existsSync(home), true, "the late write recreated the removed home");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("removeTempHome waits for a child that writes late, then leaves the home gone", async function () {
  var home = makeHome();
  var child = lateWriter(home);
  await removeTempHome(home, { children: [child] });
  assert.equal(child.exitCode, 0, "the child finished its write before the removal");
  assert.equal(fs.existsSync(home), false);
});

test("removeTempHome waits for a bare pid to exit", async function () {
  var home = makeHome();
  var child = lateWriter(home);
  await removeTempHome(home, { children: [child.pid] });
  assert.equal(fs.existsSync(home), false);
});

test("removeTempHome fails naming the pid of a child that outlives the bound", async function () {
  var home = makeHome();
  var child = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], { stdio: "ignore" });
  try {
    await assert.rejects(removeTempHome(home, { children: [child], waitMs: 200 }), function (err) {
      assert.ok(err.message.indexOf("pid " + child.pid) !== -1, "names the pid: " + err.message);
      return true;
    });
  } finally {
    child.kill("SIGKILL");
    await new Promise(function (resolve) { child.once("exit", resolve); });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A launcher that starts a detached writer and exits at once: the writer is
// re-parented, as the claude process a daemon started is when the daemon exits
// first, so the test has no handle to it. Only its environment ties it back.
var ORPHAN_LAUNCHER = [
  "var cp = require('child_process');",
  "var writer = [",
  "  \"var fs = require('fs'); var home = process.argv[1];\",",
  "  \"setInterval(function () {\",",
  "  \"  fs.mkdirSync(home + '/console', { recursive: true });\",",
  "  \"  fs.writeFileSync(home + '/console/state.json', String(Date.now()));\",",
  "  \"}, 10);\",",
  "].join('\\n');",
  "var w = cp.spawn(process.execPath, ['-e', writer, process.argv[1]], { detached: true, stdio: 'ignore' });",
  "w.unref();",
  "process.stdout.write(String(w.pid));",
].join("\n");

test("removeTempHome stops an orphaned writer that carries the harness token", async function () {
  var home = makeHome();
  var token = newHarnessToken();
  var env = Object.assign({}, process.env);
  env[TOKEN_ENV] = token;
  var launcher = spawn(process.execPath, ["-e", ORPHAN_LAUNCHER, home], { env: env, stdio: ["ignore", "pipe", "ignore"] });
  var out = "";
  launcher.stdout.on("data", function (c) { out += c; });
  await new Promise(function (resolve) { launcher.once("exit", resolve); });
  var orphan = Number(out);
  assert.ok(orphan > 1, "the launcher reported the writer's pid: " + out);
  try {
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    assert.equal(e.code, "ENOTEMPTY");
  }
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  assert.equal(fs.existsSync(home), true, "a bare removal loses to the live writer");

  await removeTempHome(home, { token: token });
  assert.equal(pidAlive(orphan), false, "the orphaned writer was stopped");
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  assert.equal(fs.existsSync(home), false, "and nothing recreated the home");
});

test("removeTempHome lets an in-flight store write finish instead of racing it", async function () {
  var home = makeHome();
  var write = writeJsonAt(path.join(home, "console", "loops", "state.json"), { a: 1 });
  await removeTempHome(home);
  await write;
  // Give any chain step that escaped the wait a turn to recreate the home.
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  assert.equal(fs.existsSync(home), false);
});
