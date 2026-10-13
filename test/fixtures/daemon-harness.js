"use strict";

// Boots a real lib/daemon.js in a child process over a private home, port and
// HOME, so a test never reaches the operator's live daemon, socket or config.
// Only pids this harness spawned are ever signalled.

var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var net = require("net");
var http = require("http");
var { spawn } = require("child_process");
var WebSocket = require("ws");

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "lib", "daemon.js");
var SETUP_CODE = "HARNESSCODE";

// Variables a supervisor sets; removed so a test run from inside a service
// does not make the daemon under test believe it is supervised.
var SUPERVISOR_ENV = ["INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM"];

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

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * @param {object} [o]
 * @param {object} [o.config] merged over the daemon.json the daemon starts with
 * @param {object} [o.env] extra environment for the daemon; a null value removes the variable
 * @param {string} [o.script] daemon entry to run (default: this checkout's lib/daemon.js)
 */
async function bootDaemon(o) {
  var opts = o || {};
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-harness-"));
  var consoleDir = path.join(home, "console");
  var projectDir = path.join(home, "project");
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  var port = await findFreePort();
  fs.writeFileSync(path.join(consoleDir, "daemon.json"), JSON.stringify(Object.assign({
    port: port, host: "127.0.0.1", tls: false, debug: false,
    projects: [{ path: projectDir, slug: "entry-project", addedAt: Date.now(), visibility: "public" }],
  }, opts.config || {}), null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(consoleDir, "users.json"), JSON.stringify({
    multiUser: true, setupCode: SETUP_CODE, users: [], invites: [], smtp: null,
  }, null, 2), { mode: 0o600 });

  var env = Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home, HOME: home, USERPROFILE: home });
  SUPERVISOR_ENV.forEach(function (k) { delete env[k]; });
  Object.keys(opts.env || {}).forEach(function (k) {
    if (opts.env[k] === null) delete env[k]; else env[k] = opts.env[k];
  });

  var log = [];
  function start() {
    var child = spawn(process.execPath, [opts.script || DAEMON_SCRIPT], { env: env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", function (c) { log.push(c.toString()); });
    child.stderr.on("data", function (c) { log.push(c.toString()); });
    return child;
  }
  var proc = start();
  await waitForServer(port, 20000);

  var d = {
    home: home,
    consoleDir: consoleDir,
    port: port,
    proc: proc,
    sock: path.join(consoleDir, "daemon.sock"),
    journal: function () { return log.join(""); },
    // What a supervisor does after the daemon exits: start it again, same
    // home and port. The new process replaces d.proc; its output joins the journal.
    respawn: async function (script) {
      if (script) opts.script = script;
      log.push("\n--- supervisor starts the daemon again ---\n");
      d.proc = start();
      proc = d.proc;
      await waitForServer(port, 20000);
      return d.proc;
    },
    // The pid a self-spawning restart records for its successor.
    successorPid: function () {
      var cfg = JSON.parse(fs.readFileSync(path.join(consoleDir, "daemon.json"), "utf8"));
      return cfg.pid && cfg.pid !== proc.pid ? cfg.pid : null;
    },
    adminCookie: async function () {
      var body = JSON.stringify({ setupCode: SETUP_CODE, username: "harnessadmin", pin: "123456" });
      var res = await httpRequest({
        hostname: "127.0.0.1", port: port, path: "/auth/setup", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, body);
      assert.equal(res.status, 200, "admin setup: " + res.body.slice(0, 200));
      await new Promise(function (r) { setTimeout(r, 200); });
      return res.headers["set-cookie"][0].split(";")[0];
    },
    // Opens the project socket as the admin; resolves { ws, messages }.
    openAdminSocket: async function () {
      var cookie = await d.adminCookie();
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket("ws://127.0.0.1:" + port + "/p/entry-project/ws", { headers: { Cookie: cookie } });
        var messages = [];
        ws.on("message", function (raw) { try { messages.push(JSON.parse(raw.toString())); } catch (e) { /* non-JSON frame */ } });
        var timer = setTimeout(function () { ws.terminate(); reject(new Error("websocket did not open")); }, 10000);
        ws.once("open", function () { clearTimeout(timer); resolve({ ws: ws, messages: messages }); });
        ws.once("error", function (e) { clearTimeout(timer); reject(e); });
      });
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

module.exports = { bootDaemon, waitForExit, signalPid, pidAlive, httpRequest, findFreePort, SETUP_CODE, SUPERVISOR_ENV, DAEMON_SCRIPT };
