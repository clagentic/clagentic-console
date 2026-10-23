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

var { removeTempHome, pidAlive, startTimeOf, stillOwned } = require("./helpers/remove-temp-home");
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

// --- writers that start their write from a timer ---

// The drain sees fs requests that exist; a timer that has not fired has none.
function timerWriter(home, delayMs) {
  var timer = setTimeout(function () {
    writeJsonAt(path.join(home, "console", "late.json"), { a: 1 }).catch(function () {});
  }, delayMs);
  return { cancel: function () { clearTimeout(timer); } };
}

test("removeTempHome cannot see a timer-scheduled write: the caller must quiesce it (the contract's limit)", async function () {
  var home = makeHome();
  var writer = timerWriter(home, 150);
  try {
    await removeTempHome(home);
    assert.equal(fs.existsSync(home), false, "gone when the helper returns");
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
    assert.equal(fs.existsSync(home), true, "the unquiesced timer wrote after the helper returned");
  } finally {
    writer.cancel();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("removeTempHome runs the caller's quiesce first, so a timer-scheduled write never recreates the home", async function () {
  var home = makeHome();
  var writer = timerWriter(home, 150);
  var order = [];
  await removeTempHome(home, {
    quiesce: function () { order.push("quiesce"); writer.cancel(); },
  });
  order.push("returned");
  await new Promise(function (resolve) { setTimeout(resolve, 400); });
  assert.deepEqual(order, ["quiesce", "returned"]);
  assert.equal(fs.existsSync(home), false, "nothing recreated the home");
});

test("removeTempHome awaits an async quiesce and reports one that throws", async function () {
  var home = makeHome();
  var done = false;
  await removeTempHome(home, {
    quiesce: async function () { await new Promise(function (resolve) { setTimeout(resolve, 50); }); done = true; },
  });
  assert.equal(done, true);
  var home2 = makeHome();
  await assert.rejects(removeTempHome(home2, { quiesce: function () { throw new Error("close failed"); } }), /quiesce failed: close failed/);
  assert.equal(fs.existsSync(home2), false, "the home is still removed");
});

// --- a recycled pid is never signalled ---

test("stillOwned accepts the process it found and refuses a pid whose start time differs", async function () {
  var token = newHarnessToken();
  var env = Object.assign({}, process.env);
  env[TOKEN_ENV] = token;
  var child = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], { env: env, stdio: "ignore" });
  try {
    var start = startTimeOf(child.pid);
    assert.ok(start, "the start time is readable from /proc");
    assert.equal(stillOwned({ pid: child.pid, start: start }, token), true);
    assert.equal(stillOwned({ pid: child.pid, start: String(Number(start) + 1) }, token), false, "a different start time is another process");
    assert.equal(stillOwned({ pid: child.pid, start: null }, token), false, "an unverified start time is not owned");
    assert.equal(stillOwned({ pid: child.pid, start: start }, newHarnessToken()), false, "another token is not owned");
  } finally {
    child.kill("SIGKILL");
    await new Promise(function (resolve) { child.once("exit", resolve); });
  }
});

// --- no /proc ---

test("without /proc the helper still waits for listed children, skips the token scan and says so once", async function () {
  var home = makeHome();
  var child = lateWriter(home);
  var realReaddir = fs.readdirSync;
  var notices = [];
  fs.readdirSync = function (dir) {
    if (dir === "/proc") { var e = new Error("ENOENT: no such file or directory, scandir '/proc'"); e.code = "ENOENT"; throw e; }
    return realReaddir.apply(this, arguments);
  };
  try {
    await removeTempHome(home, { children: [child], token: newHarnessToken(), log: function (m) { notices.push(m); } });
  } finally {
    fs.readdirSync = realReaddir;
  }
  assert.equal(child.exitCode, 0, "the listed child was still waited for");
  assert.equal(fs.existsSync(home), false);
  assert.equal(notices.length, 1, "one notice: " + JSON.stringify(notices));
  assert.match(notices[0], /token scan skipped/);
});
