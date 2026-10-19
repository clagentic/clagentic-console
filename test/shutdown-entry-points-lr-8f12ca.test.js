/**
 * Every way a Clagentic: Console daemon can be shut down or restarted ends in
 * the same place: shutdownProjects() -> relay.destroyAll() -> project destroy().
 * Each case here boots a real daemon.js in a child process and drives one real
 * entry (OS signal, IPC command, or the admin WebSocket message the web UI
 * sends), then asserts the shutdown reached the session-reclaim announcer
 * (its one summary line is in the journal) and finished inside the 10 s
 * force-exit backstop.
 *
 * Not driven here, and why:
 *  - A live background agent needs a running claude child, which a test cannot
 *    start. The announcer's effect on such a session (marker, agent names,
 *    synchronous persist) is asserted in shutdown-reclaim-lr-8f12ca.test.js
 *    through the same relay.destroyAll() these entries call.
 *  - SIGHUP is registered on win32 only; uncaughtException cannot be injected
 *    into a child from outside. Both call the same gracefulShutdown() as the
 *    SIGTERM case below.
 *  - The IPC "update" command installs from npm. Its debug-mode branch (same
 *    gracefulShutdown call, no install) is driven instead.
 */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var net = require("net");
var http = require("http");
var { spawn } = require("child_process");
var WebSocket = require("ws");
var { sendIPCCommand } = require("../lib/ipc");
var { unsupervisedEnv } = require("../lib/supervisor");
var { bootDaemon: bootHarness } = require("./fixtures/daemon-harness");
var { TOKEN_ENV, newHarnessToken, verifyOwnedPid } = require("./fixtures/process-ownership");
var { makeInstall } = require("./fixtures/install-fixture");

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var SETUP_CODE = "SHUTDOWNENTRY";
var SUMMARY = /\[session-reclaim\] Shutdown: 0 session\(s\) with background agents recorded as resumable, 0 could not be persisted/;
var SHUTDOWN_BUDGET_MS = 9000;
var EXIT_CLEAN = 0;
var EXIT_HANDOFF = 120;
var NO_RESTART_GRACE_MS = 3000;

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

function httpRequest(opts, body) {
  return new Promise(function (resolve, reject) {
    var req = http.request(opts, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }); });
    });
    req.on("error", reject);
    req.setTimeout(2000, function () { req.destroy(new Error("request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(port, ms) {
  var start = Date.now();
  while (Date.now() - start < ms) {
    try {
      await httpRequest({ hostname: "127.0.0.1", port: port, path: "/", method: "GET" });
      return;
    } catch (e) {
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }
  throw new Error("daemon did not respond within " + ms + " ms");
}

function waitForExit(proc, ms) {
  return new Promise(function (resolve, reject) {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    var timer = setTimeout(function () { reject(new Error("daemon did not exit within " + ms + " ms")); }, ms);
    proc.once("exit", function (code) { clearTimeout(timer); resolve(code); });
  });
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}

// Starts a daemon over a private home. Returns what a case needs to drive it
// and to clean up after it, including the detached successor a restart spawns.
async function bootDaemon(config, extraEnv) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-shutdown-"));
  var consoleDir = path.join(home, "console");
  var projectDir = path.join(home, "project");
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  var port = await findFreePort();
  fs.writeFileSync(path.join(consoleDir, "daemon.json"), JSON.stringify(Object.assign({
    port: port, host: "127.0.0.1", tls: false, debug: false,
    projects: [{ path: projectDir, slug: "entry-project", addedAt: Date.now(), visibility: "public" }],
  }, config || {}), null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(consoleDir, "users.json"), JSON.stringify({
    multiUser: true, setupCode: SETUP_CODE, users: [], invites: [], smtp: null,
  }, null, 2), { mode: 0o600 });

  var configPath = path.join(consoleDir, "daemon.json");
  var log = [];
  var token = newHarnessToken();
  var env = Object.assign(unsupervisedEnv(), { CLAGENTIC_CONSOLE_HOME: home, HOME: home, USERPROFILE: home }, extraEnv || {});
  env[TOKEN_ENV] = token; // the detached successor inherits it; the reaper trusts nothing else
  var proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    // HOME too: legacy-path reads (~/.clagentic, ~/.clagentic-rc, ~/clagentic-projects)
    // must not reach the operator's real home.
    // The test runner may itself run under a service unit; an inherited
    // supervisor variable would turn every restart case into a supervised one.
    env: env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", function (d) { log.push(d.toString()); });
  proc.stderr.on("data", function (d) { log.push(d.toString()); });
  await waitForServer(port, 20000);

  var d = {
    home: home,
    port: port,
    proc: proc,
    sock: path.join(consoleDir, "daemon.sock"),
    journal: function () { return log.join(""); },
    // The pid a restart records for its successor, written before the parent exits.
    successorPid: function () { return readSuccessorPid(configPath, proc.pid); },
    // Admin session cookie, as the web UI holds it.
    adminCookie: async function () {
      var body = JSON.stringify({ setupCode: SETUP_CODE, username: "entryadmin", pin: "123456" });
      var res = await httpRequest({
        hostname: "127.0.0.1", port: port, path: "/auth/setup", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, body);
      assert.equal(res.status, 200, "admin setup: " + res.body.slice(0, 200));
      // users.json is written asynchronously; the next request reads it from disk.
      await new Promise(function (r) { setTimeout(r, 200); });
      return res.headers["set-cookie"][0].split(";")[0];
    },
    cleanup: function () { return reapDaemon(proc, home, configPath, token); },
  };
  return d;
}

// The pid a restart records for its successor, or null when the file names the
// daemon itself. Throws when the file cannot be read or parsed: a successor
// cannot be ruled out from a file that cannot be read.
function readSuccessorPid(configPath, ownPid) {
  var cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return cfg.pid && cfg.pid !== ownPid ? cfg.pid : null;
}

// Kills the spawned daemon and its detached successor and removes the temp
// home. When the successor cannot be established the daemon and the home are
// still cleaned up, then this rejects naming the daemon.json path, so a
// possibly-live successor fails the test instead of leaking silently.
async function reapDaemon(proc, home, configPath, token) {
  var successor = null;
  var unreadable = null;
  try {
    successor = readSuccessorPid(configPath, proc.pid);
  } catch (e) {
    unreadable = e;
  }
  if (proc.exitCode === null) signalPid(proc.pid, "SIGKILL");
  // daemon.json is data the test does not control: signal only a pid that is
  // verifiably this test's daemon.
  var unverified = null;
  if (successor) {
    var verdict = verifyOwnedPid(successor, token);
    if (verdict.ok) {
      signalPid(successor, "SIGTERM");
      await new Promise(function (r) { setTimeout(r, 1500); });
      signalPid(successor, "SIGKILL");
    } else if (fs.existsSync("/proc/" + successor)) {
      unverified = "pid " + successor + " recorded in " + configPath + " was not signalled: " + verdict.reason;
    }
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (unverified) throw new Error(unverified);
  if (unreadable) {
    throw new Error("could not establish the restart successor from " + configPath
      + " (a detached daemon may still be running): " + unreadable.message);
  }
}

function sendWs(d, cookie, message) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket("ws://127.0.0.1:" + d.port + "/p/entry-project/ws", { headers: { Cookie: cookie } });
    var timer = setTimeout(function () { ws.terminate(); reject(new Error("websocket did not open")); }, 10000);
    ws.once("open", function () {
      clearTimeout(timer);
      ws.send(JSON.stringify(message));
      resolve(ws);
    });
    ws.once("error", function (e) { clearTimeout(timer); reject(e); });
  });
}

// One case: boot, run `drive`, then expect the daemon to exit with `expected`
// inside the backstop, the announcer's summary in the journal, and no forced exit.
function entryCase(name, expected, config, drive) {
  test(name, { timeout: 60000 }, async function () {
    var d = await bootDaemon(config);
    try {
      var started = Date.now();
      await drive(d);
      var code = await waitForExit(d.proc, 15000);
      var elapsed = Date.now() - started;
      assert.equal(code, expected, "exit code; journal:\n" + d.journal().slice(-1500));
      // Debug mode leaves the respawn to the dev watcher; every other handoff
      // spawns a detached successor that cleanup() can only reap if its pid is known.
      if (expected === EXIT_HANDOFF && !(config && config.debug)) {
        assert.ok(d.successorPid(), "a restart must record its successor pid; journal:\n" + d.journal().slice(-1500));
      }
      assert.match(d.journal(), SUMMARY, "the shutdown reached the announcer; journal:\n" + d.journal().slice(-1500));
      assert.doesNotMatch(d.journal(), /Forced exit/, "the announcer must not push the shutdown to the backstop");
      assert.ok(elapsed < SHUTDOWN_BUDGET_MS, "shutdown took " + elapsed + " ms");
    } finally {
      await d.cleanup();
    }
  });
}

entryCase("SIGTERM (systemd stop) reaches the announcer", EXIT_CLEAN, null, async function (d) {
  d.proc.kill("SIGTERM");
});

entryCase("SIGINT reaches the announcer", EXIT_CLEAN, null, async function (d) {
  d.proc.kill("SIGINT");
});

entryCase("IPC shutdown reaches the announcer", EXIT_CLEAN, null, async function (d) {
  var resp = await sendIPCCommand(d.sock, { cmd: "shutdown" });
  assert.equal(resp.ok, true);
});

entryCase("IPC restart reaches the announcer", EXIT_HANDOFF, null, async function (d) {
  var resp = await sendIPCCommand(d.sock, { cmd: "restart" });
  assert.equal(resp.ok, true);
});

entryCase("IPC update handoff (debug-mode branch) reaches the announcer", EXIT_HANDOFF, { debug: true }, async function (d) {
  var resp = await sendIPCCommand(d.sock, { cmd: "update" });
  assert.equal(resp.ok, true);
});

entryCase("web-UI shutdown_server reaches the announcer", EXIT_CLEAN, null, async function (d) {
  var ws = await sendWs(d, await d.adminCookie(), { type: "shutdown_server" });
  d.proc.once("exit", function () { ws.terminate(); });
});

entryCase("web-UI restart_server reaches the announcer", EXIT_HANDOFF, null, async function (d) {
  var ws = await sendWs(d, await d.adminCookie(), { type: "restart_server" });
  d.proc.once("exit", function () { ws.terminate(); });
});

// "Restart to apply update" is a two-step, confirm-gated offer: a request
// without a token never restarts, and with no newer build installed there is
// nothing to offer.
test("web-UI restart-to-apply-update with nothing to apply restarts nothing", { timeout: 60000 }, async function () {
  var d = await bootDaemon(null);
  try {
    var ws = await sendWs(d, await d.adminCookie(), { type: "restart_for_build_update", requestId: "bu-echo-1" });
    var result = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("no restart_for_build_update_result")); }, 10000);
      ws.on("message", function (raw) {
        var m = JSON.parse(raw.toString());
        if (m.type === "restart_for_build_update_result") { clearTimeout(timer); resolve(m); }
      });
    });
    ws.terminate();
    assert.equal(result.ok, false);
    assert.equal(result.requestId, "bu-echo-1", "the result echoes the request id so the client can correlate it");
    // A restart would reply and then exit; give it a bounded grace period to
    // do so, so a reply-then-schedule-restart defect cannot pass by being early.
    await new Promise(function (r) { setTimeout(r, NO_RESTART_GRACE_MS); });
    assert.equal(d.proc.exitCode, null, "an unconfirmed request must not restart the daemon");
  } finally {
    await d.cleanup();
  }
});

// The confirmed entry point: a stale install, the operator's first click (the
// offer) and second click (its token) end in the handoff exit. Run as a
// supervised daemon so the exit is observable with no self-spawned successor.
test("web-UI restart-to-apply-update with a stale install, confirmed, exits with the handoff code", { timeout: 120000 }, async function () {
  var inst = makeInstall("a".repeat(40));
  var h = await bootHarness({
    script: inst.daemonScript,
    env: { CLAGENTIC_CONSOLE_BUILD_CHECK_MS: "300", INVOCATION_ID: "test-unit" },
  });
  try {
    var sock = await h.openAdminSocket();
    inst.installBuild("b".repeat(40), "marker-new");
    await pollFor(async function () {
      var s = await sendIPCCommand(h.sock, { cmd: "get_build_status" });
      return s.state === "stale";
    }, 15000, "the installed build to be seen as stale");
    sock.ws.send(JSON.stringify({ type: "restart_for_build_update" }));
    var offer = await pollFor(function () {
      return sock.messages.find(function (m) {
        return m.type === "diagnostic" && m.source === "build-update" && m.buildUpdate && m.buildUpdate.token;
      });
    }, 15000, "the confirmation offer");
    assert.equal(h.proc.exitCode, null, "asking for the offer restarts nothing");
    sock.ws.send(JSON.stringify({ type: "restart_for_build_update", confirmToken: offer.buildUpdate.token }));
    var code = await waitForExit(h.proc, 30000);
    assert.equal(code, EXIT_HANDOFF, "exit code; journal:\n" + h.journal().slice(-1500));
    assert.equal(h.successorPid(), null, "a supervised restart spawns no replacement");
    sock.ws.terminate();
  } finally {
    await h.cleanup();
    inst.cleanup();
  }
});

async function pollFor(attempt, ms, what) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    var v = await attempt();
    if (v) return v;
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  throw new Error("timed out waiting for " + what);
}

// Under a supervisor a restart is an exit with the restart code and no
// self-spawned successor, and it still passes through the announcer first.
test("supervised IPC restart reaches the announcer and spawns no successor", { timeout: 60000 }, async function () {
  var d = await bootDaemon(null, { INVOCATION_ID: "test-unit-invocation" });
  try {
    var resp = await sendIPCCommand(d.sock, { cmd: "restart" });
    assert.equal(resp.ok, true);
    var code = await waitForExit(d.proc, 15000);
    assert.equal(code, EXIT_HANDOFF, "exit code; journal:\n" + d.journal().slice(-1500));
    assert.equal(d.successorPid(), null, "no self-spawned successor");
    assert.match(d.journal(), SUMMARY, "the shutdown reached the announcer; journal:\n" + d.journal().slice(-1500));
    assert.doesNotMatch(d.journal(), /Forced exit/);
  } finally {
    await d.cleanup();
  }
});

// Cleanup must fail, not skip, when the successor pid cannot be established.
// The stand-in process plays the spawned daemon; the config shapes are the
// two ways daemon.json can be unusable mid-restart.
function cleanupCase(name, writeConfig) {
  test(name, async function () {
    var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-cleanup-"));
    var configPath = path.join(home, "console", "daemon.json");
    fs.mkdirSync(path.join(home, "console"), { recursive: true });
    writeConfig(configPath);
    var proc = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], { stdio: "ignore" });
    try {
      await assert.rejects(reapDaemon(proc, home, configPath), function (err) {
        assert.ok(err.message.indexOf(configPath) !== -1, "names the daemon.json path: " + err.message);
        return true;
      });
      await waitForExit(proc, 5000);
      assert.equal(fs.existsSync(home), false, "the temp home is still removed");
    } finally {
      if (proc.exitCode === null) signalPid(proc.pid, "SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

cleanupCase("cleanup fails naming the path when daemon.json is unreadable", function (configPath) {
  // A directory at the path makes the read fail for any uid, root included.
  fs.mkdirSync(configPath);
});

cleanupCase("cleanup fails naming the path when daemon.json is partial", function (configPath) {
  fs.writeFileSync(configPath, '{"port": 1234, "pid": 99');
});
