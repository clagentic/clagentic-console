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

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var SETUP_CODE = "SHUTDOWNENTRY";
var SUMMARY = /\[session-reclaim\] Shutdown: 0 session\(s\) with background agents recorded as resumable, 0 could not be persisted/;
var SHUTDOWN_BUDGET_MS = 9000;
var EXIT_CLEAN = 0;
var EXIT_HANDOFF = 120;

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
async function bootDaemon(config) {
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

  var log = [];
  var proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
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
    successorPid: function () {
      var cfg = JSON.parse(fs.readFileSync(path.join(consoleDir, "daemon.json"), "utf8"));
      return cfg.pid && cfg.pid !== proc.pid ? cfg.pid : null;
    },
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
    cleanup: async function () {
      var successor = null;
      try { successor = d.successorPid(); } catch (e) { successor = null; }
      if (proc.exitCode === null) signalPid(proc.pid, "SIGKILL");
      if (successor) {
        signalPid(successor, "SIGTERM");
        await new Promise(function (r) { setTimeout(r, 1500); });
        signalPid(successor, "SIGKILL");
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return d;
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

entryCase("web-UI restart-to-apply-update reaches the announcer", EXIT_HANDOFF, null, async function (d) {
  var ws = await sendWs(d, await d.adminCookie(), { type: "restart_for_build_update" });
  d.proc.once("exit", function () { ws.terminate(); });
});
