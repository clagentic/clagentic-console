"use strict";
// A real claude-worker.js process, over a real unix socket, with the Claude
// Agent SDK swapped for a stand-in (test/fixtures/fake-agent-sdk) whose Query
// has applyFlagSettings and setPermissionMode and no setEffort, as the real
// 0.3.x Query. What the worker puts on the socket is what the daemon-side
// relay (lib/yoke/adapters/claude.js) receives in OS-isolated multi-user mode.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var net = require("net");
var path = require("path");
var { spawn } = require("child_process");
var { pathToFileURL } = require("url");

var WORKER = path.join(__dirname, "..", "lib", "yoke", "adapters", "claude-worker.js");
var REGISTER = pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "register.mjs")).href;
var WAIT_MS = 20000;

// Starts the worker against a fresh socket; returns helpers to talk to it.
async function startWorker() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-worker-test-"));
  var socketPath = path.join(dir, "w.sock");
  var received = [];
  var waiters = [];
  var connection = null;
  var buffer = "";

  function deliver() {
    waiters = waiters.filter(function (w) {
      var index = received.findIndex(w.predicate);
      if (index === -1) return true;
      w.resolve(received.splice(index, 1)[0]);
      return false;
    });
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

  var child = spawn(process.execPath, ["--import", REGISTER, WORKER, socketPath], {
    env: { PATH: process.env.PATH, HOME: dir },
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });

  var worker = {
    next: function (predicate, label) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error("timed out waiting for " + label)); }, WAIT_MS);
        waiters.push({ predicate: predicate, resolve: function (m) { clearTimeout(timer); resolve(m); } });
        deliver();
      });
    },
    probe: function (call, label) {
      return worker.next(function (m) { return m.type === "sdk_event" && m.event.type === "fake_probe" && m.event.call === call; }, label || call);
    },
    send: function (msg) { connection.write(JSON.stringify(msg) + "\n"); },
    stop: async function () {
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
      await new Promise(function (resolve) { server.close(resolve); if (connection) connection.destroy(); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  await worker.next(function (m) { return m.type === "ready"; }, "ready");
  return worker;
}

async function withQuery(fn) {
  var worker = await startWorker();
  try {
    worker.send({ type: "query_start", prompt: null, options: { cwd: os.tmpdir() }, singleTurn: false });
    await worker.next(function (m) { return m.type === "sdk_event" && m.event.subtype === "init"; }, "the query's first event");
    await fn(worker);
  } finally {
    await worker.stop();
  }
}

test("a tool-permission ask in the worker reaches the daemon with its presentation hints, and the answer comes back", async function () {
  await withQuery(async function (worker) {
    worker.send({ type: "push_message", content: { type: "user", message: { role: "user", content: [{ type: "text", text: "ask" }] } } });
    var request = await worker.next(function (m) { return m.type === "permission_request"; }, "permission_request");

    assert.equal(request.toolName, "Bash");
    assert.deepEqual(request.input, { command: "make" });
    assert.equal(request.toolUseId, "tu-fake");
    assert.equal(request.decisionReason, "a rule asks");
    assert.equal(request.suppressAlwaysAllowRule, true, "no persistent choice");
    assert.equal(request.defaultToNo, true, "opens on No");
    assert.deepEqual(request.matchedAskRule, { source: "projectSettings", toolName: "Bash", ruleContent: "make:*" });

    worker.send({ type: "permission_response", requestId: request.requestId, result: { behavior: "deny", message: "no" } });
    var answered = await worker.probe("canUseTool");
    assert.deepEqual(answered.event.result, { behavior: "deny", message: "no" });
  });
});

test("an effort change reaches the running query through applyFlagSettings and is confirmed with its requestId", async function () {
  await withQuery(async function (worker) {
    worker.send({ type: "set_effort", requestId: "e-1", effort: "high" });
    var confirmed = await worker.next(function (m) { return m.type === "effort_changed"; }, "effort_changed");
    assert.equal(confirmed.requestId, "e-1");
    assert.equal(confirmed.effort, "high");
    var probe = await worker.probe("applyFlagSettings");
    assert.deepEqual(probe.event.args, { effortLevel: "high" });
  });
});

test("an effort change the SDK refuses, or the console does not know, is reported as a failure with its requestId", async function () {
  await withQuery(async function (worker) {
    worker.send({ type: "set_effort", requestId: "e-2", effort: "max" });
    var refused = await worker.next(function (m) { return m.type === "worker_error" && m.requestId === "e-2"; }, "worker_error for e-2");
    assert.match(refused.error, /organization effort limit/);

    worker.send({ type: "set_effort", requestId: "e-3", effort: "minimal" });
    var unknown = await worker.next(function (m) { return m.type === "worker_error" && m.requestId === "e-3"; }, "worker_error for e-3");
    assert.match(unknown.error, /Unknown effort level/);
  });
});

test("an effort change with no running query is a failure, not silence", async function () {
  var worker = await startWorker();
  try {
    worker.send({ type: "set_effort", requestId: "e-4", effort: "low" });
    var failure = await worker.next(function (m) { return m.type === "worker_error" && m.requestId === "e-4"; }, "worker_error for e-4");
    assert.match(failure.error, /no running query/);
  } finally {
    await worker.stop();
  }
});

test("the new permission modes are passed to the running query as the SDK names them", async function () {
  await withQuery(async function (worker) {
    var modes = ["auto", "dontAsk"];
    for (var i = 0; i < modes.length; i++) {
      worker.send({ type: "set_permission_mode", mode: modes[i] });
      var probe = await worker.probe("setPermissionMode");
      assert.equal(probe.event.args, modes[i]);
      var confirmed = await worker.next(function (m) { return m.type === "permission_mode_changed"; }, "permission_mode_changed");
      assert.equal(confirmed.mode, modes[i]);
    }
  });
});
