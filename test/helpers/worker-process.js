"use strict";

// A real claude-worker.js process behind a real unix socket, shared by the
// tests that drive the worker directly. The one rule it enforces: when the
// worker does not become ready (exits at boot, or stays silent), the child is
// killed, the listening socket is closed and the temp dir is removed before
// the failure is rethrown, with the worker's stderr in the message. A listening
// socket left open keeps the test file's process alive forever, and a
// discarded stderr hides a boot failure such as MODULE_NOT_FOUND.

var fs = require("fs");
var os = require("os");
var net = require("net");
var path = require("path");
var { spawn } = require("child_process");
var { pathToFileURL } = require("url");

var WORKER = path.join(__dirname, "..", "..", "lib", "yoke", "adapters", "claude-worker.js");
var REGISTER = pathToFileURL(path.join(__dirname, "..", "fixtures", "fake-agent-sdk", "register.mjs")).href;
var STDERR_CAP = 8192;

// options: prefix (temp dir name), env (extra worker env), waitMs (per wait),
// workerPath (override, for the boot-failure test).
async function startWorkerProcess(options) {
  options = options || {};
  var waitMs = options.waitMs || 20000;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "clagentic-worker-test-"));
  var socketPath = path.join(dir, "w.sock");
  var received = [];
  var waiters = [];
  var connection = null;
  var buffer = "";
  var stderr = "";
  var exitNote = null;

  function describeExit() {
    return exitNote + (stderr ? "; worker stderr:\n" + stderr : "; worker stderr was empty");
  }

  function deliver() {
    waiters = waiters.filter(function (w) {
      var index = received.findIndex(w.predicate);
      if (index === -1) return true;
      w.resolve(received.splice(index, 1)[0]);
      return false;
    });
    if (exitNote) {
      waiters.forEach(function (w) { w.reject(new Error("worker exited before " + w.label + ": " + describeExit())); });
      waiters = [];
    }
  }

  var server = net.createServer(function (conn) {
    connection = conn;
    conn.on("data", function (chunk) {
      buffer += chunk.toString();
      var lines = buffer.split("\n");
      buffer = lines.pop();
      lines.filter(Boolean).forEach(function (line) { received.push(JSON.parse(line)); });
      deliver();
    });
    conn.on("error", function () {});
  });
  await new Promise(function (resolve) { server.listen(socketPath, resolve); });

  var child = spawn(process.execPath, ["--import", REGISTER, options.workerPath || WORKER, socketPath], {
    env: Object.assign({ PATH: process.env.PATH, HOME: dir }, options.env),
    cwd: dir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", function (chunk) {
    if (stderr.length < STDERR_CAP) stderr += chunk.toString().slice(0, STDERR_CAP - stderr.length);
  });
  var closed = new Promise(function (resolve) {
    child.on("close", function (code, signal) {
      exitNote = "exit code " + code + (signal ? " signal " + signal : "");
      deliver();
      resolve();
    });
  });
  child.on("error", function (err) {
    exitNote = "spawn error " + err.message;
    deliver();
  });

  var worker = {
    dir: dir,
    next: function (predicate, label) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error("timed out waiting for " + label + (stderr ? "; worker stderr:\n" + stderr : ""))); }, waitMs);
        waiters.push({
          label: label,
          predicate: predicate,
          resolve: function (m) { clearTimeout(timer); resolve(m); },
          reject: function (err) { clearTimeout(timer); reject(err); },
        });
        deliver();
      });
    },
    probe: function (call, label) {
      return worker.next(function (m) { return m.type === "sdk_event" && m.event.type === "fake_probe" && m.event.call === call; }, label || call);
    },
    send: function (msg) { connection.write(JSON.stringify(msg) + "\n"); },
    stop: async function () {
      try {
        child.kill("SIGKILL");
      } catch (e) {
        // Only a child that has already exited is expected here.
        if (e.code !== "ESRCH") throw e;
      }
      await new Promise(function (resolve) { server.close(resolve); if (connection) connection.destroy(); });
      await closed;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  try {
    await worker.next(function (m) { return m.type === "ready"; }, "ready");
  } catch (err) {
    await worker.stop();
    throw err;
  }
  return worker;
}

module.exports = { startWorkerProcess: startWorkerProcess, WORKER: WORKER };
