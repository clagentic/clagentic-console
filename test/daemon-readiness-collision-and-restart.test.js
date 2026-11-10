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
} = require("./helpers/daemon-readiness");
var { bootDaemon } = require("./fixtures/daemon-harness");

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
