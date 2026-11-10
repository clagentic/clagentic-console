// Regression rows for daemon readiness in the test harnesses.
//
// Defect: each private waitForServer counted ANY HTTP response as "the daemon is
// up", so a foreign server that took a probed port between findFreePort() and
// the daemon's bind was read as the daemon, and a restart wait was satisfied by
// the first boot's still-answering server. Readiness is now the spawned
// daemon's own "[daemon] Listening on" line, then HTTP.
//
// Helper rows use stand-in child processes that print the daemon's log lines;
// fixture rows drive the real daemon through test/fixtures/daemon-harness.js.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var { spawn } = require("child_process");
var {
  waitForServer,
  waitForDaemonListening,
  killAndWait,
  captureLog,
  startOnFreePort,
} = require("./helpers/daemon-readiness");
var { bootDaemon, pidAlive } = require("./fixtures/daemon-harness");

function listenForeign() {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) { res.writeHead(404); res.end("foreign"); });
    srv.listen(0, "127.0.0.1", function () { resolve(srv); });
  });
}

function closeServer(srv) {
  return new Promise(function (resolve) { srv.close(function () { resolve(); }); });
}

function get(port) {
  return new Promise(function (resolve, reject) {
    var req = http.get("http://127.0.0.1:" + port + "/", function (res) {
      var b = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { b += c; });
      res.on("end", function () { resolve(b); });
    });
    req.on("error", reject);
  });
}

// A child that prints `lines` to stdout, then stays alive until killed.
function standIn(lines) {
  var script = "var l = " + JSON.stringify(lines) + "; l.forEach(function (x) { console.log(x); }); setInterval(function () {}, 1000);";
  var proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  var log = [];
  proc.stdout.on("data", function (c) { log.push(c.toString()); });
  return { proc: proc, getLog: function () { return log.join(""); } };
}

test("a foreign server answering HTTP on the port is a collision, not readiness", async function () {
  var foreign = await listenForeign();
  var port = foreign.address().port;
  var d = standIn(["[daemon] Port " + port + " in use, retrying (1/10)..."]);
  try {
    // The premise of the defect: an HTTP-only probe is satisfied by the foreign server.
    await waitForServer(port, 2000);
    await assert.rejects(
      waitForDaemonListening(d.proc, d.getLog, 5000),
      function (err) { assert.equal(err.portInUse, true, err.message); return true; }
    );
  } finally {
    await killAndWait(d.proc);
    await closeServer(foreign);
  }
});

test("a listen line from before fromOffset does not satisfy readiness", async function () {
  var d = standIn(["[daemon] Listening on http://127.0.0.1:1"]);
  try {
    await waitForDaemonListening(d.proc, d.getLog, 5000);
    var offset = d.getLog().length;
    await assert.rejects(
      waitForDaemonListening(d.proc, d.getLog, 600, { fromOffset: offset }),
      function (err) { assert.match(err.message, /never bound/); return true; }
    );
  } finally {
    await killAndWait(d.proc);
  }
});

test("tolerateInUse waits out the daemon's own retry until its listen line", async function () {
  var proc = spawn(process.execPath, ["-e",
    "console.log('[daemon] Port 1 in use, retrying (1/10)...'); setTimeout(function () { console.log('[daemon] Listening on http://127.0.0.1:1'); }, 300); setInterval(function () {}, 1000);"],
  { stdio: ["ignore", "pipe", "pipe"] });
  var log = [];
  proc.stdout.on("data", function (c) { log.push(c.toString()); });
  try {
    await waitForDaemonListening(proc, function () { return log.join(""); }, 5000, { tolerateInUse: true });
  } finally {
    await killAndWait(proc);
  }
});

test("a timeout says the daemon never bound; an exit says it exited; both carry the log", async function () {
  var silent = standIn(["booting"]);
  try {
    await assert.rejects(
      waitForDaemonListening(silent.proc, silent.getLog, 500),
      function (err) {
        assert.match(err.message, /never bound/);
        assert.match(err.message, /booting/);
        return true;
      }
    );
  } finally {
    await killAndWait(silent.proc);
  }
  var proc = spawn(process.execPath, ["-e", "console.log('dying words'); process.exit(3);"], { stdio: ["ignore", "pipe", "pipe"] });
  var log = [];
  proc.stdout.on("data", function (c) { log.push(c.toString()); });
  await assert.rejects(
    waitForDaemonListening(proc, function () { return log.join(""); }, 5000),
    function (err) {
      assert.match(err.message, /exited with code 3/);
      return true;
    }
  );
});

test("fixture: a foreign server on the first probed port restarts the boot on a fresh port", { timeout: 60000 }, async function () {
  var foreign = await listenForeign();
  var foreignPort = foreign.address().port;
  var d = null;
  try {
    d = await bootDaemon({ findPort: function () { return Promise.resolve(foreignPort); } });
    assert.notEqual(d.port, foreignPort, "the daemon must not be reported on the foreign server's port");
    assert.notEqual(await get(d.port), "foreign", "the port the fixture reports must answer as the daemon");
    assert.match(d.journal(), /\[daemon\] Listening on /);
  } finally {
    if (d) await d.cleanup();
    await closeServer(foreign);
  }
});

test("fixture: the restart wait is not satisfied by the first boot's listen line or its still-answering server", { timeout: 60000 }, async function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-restart-wait-"));
  var silentScript = path.join(tmp, "silent-daemon.js");
  fs.writeFileSync(silentScript, "setInterval(function () {}, 1000);\n");
  var d = await bootDaemon();
  var first = d.proc;
  try {
    assert.match(d.journal(), /\[daemon\] Listening on /, "premise: the first boot's listen line is in the journal");
    await assert.rejects(
      d.respawn(silentScript, 1500),
      function (err) { assert.match(err.message, /never bound/); return true; }
    );
  } finally {
    if (first.exitCode === null) {
      first.kill("SIGKILL");
      await new Promise(function (r) { first.once("exit", r); });
    }
    await d.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a killed collided attempt's late 'in use' output does not fail or restart the retry", { timeout: 30000 }, async function () {
  var attempts = [];
  var procs = [];
  var collided = "console.log('[daemon] Port 1 in use, retrying (1/10)...'); setInterval(function () {}, 1000);";
  var bound = "setTimeout(function () { console.log('[daemon] Listening on http://127.0.0.1:1'); }, 400); setInterval(function () {}, 1000);";
  function startOn() {
    var proc = spawn(process.execPath, ["-e", attempts.length === 0 ? collided : bound], { stdio: ["ignore", "pipe", "pipe"] });
    procs.push(proc);
    var cap = captureLog(proc);
    attempts.push(cap);
    if (attempts.length === 2) {
      // What killAndWait cannot rule out: the first attempt's stdout delivers
      // another 'in use' chunk after its exit was observed and the retry began.
      procs[0].stdout.emit("data", Buffer.from("[daemon] Port 1 in use, retrying (2/10)...\n"));
    }
    return waitForDaemonListening(proc, cap.getLog, 5000);
  }
  try {
    await startOnFreePort(startOn, function () { return procs[procs.length - 1]; }, 3);
    assert.equal(attempts.length, 2, "exactly one restart: the late line must not trigger another");
    assert.doesNotMatch(attempts[1].getLog(), /in use/, "the retry's log holds only its own output");
  } finally {
    await Promise.all(procs.map(killAndWait));
  }
});

// A script that records its pid and the home it was given, then never listens
// (hang) or exits at once (exit).
function recorderScript(dir, behavior) {
  var script = path.join(dir, behavior + "-daemon.js");
  fs.writeFileSync(script,
    "require('fs').writeFileSync(process.env.RECORD_FILE, JSON.stringify({ pid: process.pid, home: process.env.CLAGENTIC_CONSOLE_HOME }));\n" +
    (behavior === "hang" ? "setInterval(function () {}, 1000);\n" : "process.exit(1);\n"));
  return script;
}

["hang", "exit"].forEach(function (behavior) {
  test("fixture: a boot that rejects (" + behavior + ") leaves no child and no temp home", { timeout: 30000 }, async function () {
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-failed-boot-"));
    var record = path.join(tmp, "record.json");
    var script = recorderScript(tmp, behavior);
    var rec = null;
    try {
      await assert.rejects(
        bootDaemon({ script: script, readyMs: 1000, env: { RECORD_FILE: record } }),
        behavior === "hang" ? /never bound/ : /exited with code 1/
      );
      rec = JSON.parse(fs.readFileSync(record, "utf8"));
      assert.equal(pidAlive(rec.pid), false, "the spawned child is dead");
      assert.equal(fs.existsSync(rec.home), false, "the temp home the boot created is removed");
    } finally {
      if (rec && pidAlive(rec.pid)) process.kill(rec.pid, "SIGKILL");
      if (rec) fs.rmSync(rec.home, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("fixture: a respawn that rejects leaves no child it spawned", { timeout: 60000 }, async function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-failed-respawn-"));
  var record = path.join(tmp, "record.json");
  var script = recorderScript(tmp, "hang");
  var d = await bootDaemon({ env: { RECORD_FILE: record } });
  var first = d.proc;
  try {
    await assert.rejects(d.respawn(script, 1000), /never bound/);
    var rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(pidAlive(rec.pid), false, "the restart's child is dead");
  } finally {
    if (first.exitCode === null) {
      first.kill("SIGKILL");
      await new Promise(function (r) { first.once("exit", r); });
    }
    await d.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
