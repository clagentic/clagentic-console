"use strict";

// Boots a real lib/daemon.js in a child process over a private home, port and
// HOME, so a test never reaches the operator's live daemon, socket or config.
// Only pids this harness spawned are ever signalled.

var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var { spawn } = require("child_process");
var WebSocket = require("ws");
var { TOKEN_ENV, newHarnessToken, verifyOwnedPid } = require("./process-ownership");
var { removeTempHome } = require("../helpers/remove-temp-home");
var {
  findFreePort,
  waitForServer,
  waitForDaemonListening,
  startOnFreePort,
} = require("../helpers/daemon-readiness");

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "lib", "daemon.js");
var SETUP_CODE = "HARNESSCODE";

var LISTEN_ATTEMPTS = 5;
var DEFAULT_READY_MS = 20000;
var HTTP_READY_MS = 10000; // after the listen line, HTTP must answer promptly

// Variables a supervisor sets; removed so a test run from inside a service
// does not make the daemon under test believe it is supervised.
var SUPERVISOR_ENV = ["INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM"];

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

function waitForExit(proc, ms) {
  return new Promise(function (resolve, reject) {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(proc.exitCode);
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

// The daemon records its own pid in daemon.json with an asynchronous write
// after it starts listening. Returning before that write lands lets it replace
// a pid a test has since put in the file.
async function waitForRecordedPid(file, pid, ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).pid === pid) return;
    } catch (e) {
      if (!(e instanceof SyntaxError) && e.code !== "ENOENT") throw e;
    }
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  throw new Error("the daemon did not record pid " + pid + " in " + file + " within " + ms + " ms");
}

/**
 * @param {object} [o]
 * @param {object} [o.config] merged over the daemon.json the daemon starts with
 * @param {object} [o.env] extra environment for the daemon; a null value removes the variable
 * @param {string} [o.script] daemon entry to run (default: this checkout's lib/daemon.js)
 * @param {function} [o.findPort] picks the port to try; a collision retries on a fresh findFreePort() port
 */
async function bootDaemon(o) {
  var opts = o || {};
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-harness-"));
  var consoleDir = path.join(home, "console");
  var projectDir = path.join(home, "project");
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  var port = null;
  function writeConfig() {
    fs.writeFileSync(path.join(consoleDir, "daemon.json"), JSON.stringify(Object.assign({
      port: port, host: "127.0.0.1", tls: false, debug: false,
      projects: [{ path: projectDir, slug: "entry-project", addedAt: Date.now(), visibility: "public" }],
    }, opts.config || {}), null, 2), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(consoleDir, "users.json"), JSON.stringify({
    multiUser: true, setupCode: SETUP_CODE, users: [], invites: [], smtp: null,
  }, null, 2), { mode: 0o600 });

  var token = newHarnessToken();
  var env = Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home, HOME: home, USERPROFILE: home });
  SUPERVISOR_ENV.forEach(function (k) { delete env[k]; });
  Object.keys(opts.env || {}).forEach(function (k) {
    if (opts.env[k] === null) delete env[k]; else env[k] = opts.env[k];
  });
  // Set last so a test's env cannot remove it; a self-spawned successor inherits it.
  env[TOKEN_ENV] = token;

  var log = [];
  var selfSpawnExpected = false;
  function start() {
    var child = spawn(process.execPath, [opts.script || DAEMON_SCRIPT], { env: env, stdio: ["ignore", "pipe", "pipe"] });
    // Bound to this attempt's array: a collided daemon's late output must not
    // leak into the retry's journal.
    var mine = log;
    child.stdout.on("data", function (c) { mine.push(c.toString()); });
    child.stderr.on("data", function (c) { mine.push(c.toString()); });
    return child;
  }
  var proc = null;
  // Readiness is the daemon's own listen line, then HTTP. A port taken between
  // the probe and the bind restarts the boot on a fresh port, so a foreign
  // server is never mistaken for the daemon.
  async function startOn(p) {
    port = p;
    log = [];
    writeConfig();
    proc = start();
    await waitForDaemonListening(proc, function () { return log.join(""); }, DEFAULT_READY_MS);
    await waitForServer(port, HTTP_READY_MS);
    await waitForRecordedPid(path.join(consoleDir, "daemon.json"), proc.pid, 10000);
  }
  var firstPort = true;
  await startOnFreePort(function (p) {
    var pick = firstPort && opts.findPort ? opts.findPort() : Promise.resolve(p);
    firstPort = false;
    return pick.then(startOn);
  }, function () { return proc; }, LISTEN_ATTEMPTS);

  var d = {
    token: token,
    home: home,
    consoleDir: consoleDir,
    port: port,
    proc: proc,
    sock: path.join(consoleDir, "daemon.sock"),
    journal: function () { return log.join(""); },
    // What a supervisor does after the daemon exits: start it again, same
    // home and port. The new process replaces d.proc; its output joins the journal.
    // readyMs bounds the wait for the new daemon's listen line (default 20000).
    respawn: async function (script, readyMs) {
      if (script) opts.script = script;
      log.push("\n--- supervisor starts the daemon again ---\n");
      // Only a listen line logged after this point counts: the first boot's line
      // is already in the journal. The port is fixed, so the daemon's own
      // EADDRINUSE retry is waited out, not treated as a collision.
      var from = log.join("").length;
      d.proc = start();
      proc = d.proc;
      await waitForDaemonListening(proc, function () { return log.join(""); }, readyMs || DEFAULT_READY_MS, { fromOffset: from, tolerateInUse: true });
      await waitForServer(port, HTTP_READY_MS);
      await waitForRecordedPid(path.join(consoleDir, "daemon.json"), proc.pid, 10000);
      return d.proc;
    },
    // The pid a self-spawning restart records for its successor. An unreadable
    // or partial daemon.json throws, naming the path: guessing "no successor"
    // there would leave a self-spawned daemon running after the test.
    successorPid: function () {
      var file = path.join(consoleDir, "daemon.json");
      var cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        throw new Error("cannot read the successor pid from " + file + ": " + e.message);
      }
      return cfg.pid && cfg.pid !== proc.pid ? cfg.pid : null;
    },
    // A test that drives an unsupervised restart calls this first; cleanup then
    // fails unless a successor pid was recorded that it can stop.
    expectSelfSpawn: function () { selfSpawnExpected = true; },
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
      var problems = [];
      var successor = null;
      try {
        successor = d.successorPid();
      } catch (e) {
        problems.push(e.message);
      }
      if (selfSpawnExpected && !successor && problems.length === 0) {
        problems.push("the restart recorded no successor pid in " + path.join(consoleDir, "daemon.json") +
          ", so a self-spawned daemon could not be stopped");
      }
      if (proc.exitCode === null) signalPid(proc.pid, "SIGKILL");
      if (successor && !pidAlive(successor)) {
        successor = null; // already gone; nothing to stop
      } else if (successor) {
        var verdict = verifyOwnedPid(successor, token);
        if (!verdict.ok) {
          problems.push("pid " + successor + " recorded in daemon.json was not signalled: " + verdict.reason);
          successor = null;
        }
      }
      var children = [proc];
      if (successor) {
        children.push(successor);
        signalPid(successor, "SIGTERM");
        await new Promise(function (r) { setTimeout(r, 1500); });
        signalPid(successor, "SIGKILL");
      }
      // A claude process the daemon started can outlive it and keep writing
      // under the home; the helper stops what carries the token and waits for
      // every child before removing.
      try {
        await removeTempHome(home, { children: children, token: token });
      } catch (e) {
        problems.push(e.message);
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
  };
  return d;
}

module.exports = { bootDaemon, waitForExit, signalPid, pidAlive, httpRequest, findFreePort, SETUP_CODE, SUPERVISOR_ENV, DAEMON_SCRIPT };
