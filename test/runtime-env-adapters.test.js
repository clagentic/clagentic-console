"use strict";
// The agent-runtime starts that take the Settings environment, one per caller
// shape: a Claude query in process, its warmup and title generation; a Claude
// query in the OS user's worker (the daemon's message and the worker process
// itself); and the Codex app-server. The Claude Agent SDK and the Codex
// app-server are stand-ins that report the environment they were given.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");
var nodeModule = require("node:module");
var { spawn } = require("child_process");
var { pathToFileURL } = require("url");

var FIXTURE_DIR = path.join(__dirname, "fixtures", "fake-agent-sdk");
nodeModule.register(pathToFileURL(path.join(FIXTURE_DIR, "resolve-hook.mjs")).href);

// The Codex adapter takes its app-server class when it is loaded: swap in a
// recording one first.
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var appServers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.started = false;
  this.proc = null;
  this.stopped = false;
  this.queriesServed = 0;
  appServers.push(this);
}
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; this.stopped = true; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.send = function (method) {
  if (method === "model/list") return Promise.resolve({ data: [{ model: "gpt-test", displayName: "GPT Test", isDefault: true }] });
  if (method === "skills/list") return Promise.resolve({ data: [] });
  return Promise.resolve({});
};
// A query handle registers its event handler on the server it was given.
FakeAppServer.prototype.addEventHandler = function () { this.queriesServed++; return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var claudeModule = require("../lib/yoke/adapters/claude");
var codexModule = require("../lib/yoke/adapters/codex");

var SETTINGS = { OPENAI_BASE_URL: "https://settings.example.invalid/v1", FROM_SETTINGS: "yes" };

function fakeQueries() { return globalThis.__fakeAgentSdkQueries || []; }
function lastFakeQuery() { return fakeQueries()[fakeQueries().length - 1]; }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// --- Claude, in process ---

test("a Claude query in process gets the complete environment with the Settings variables laid over it", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var before = fakeQueries().length;
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), runtimeEnv: SETTINGS });
  assert.equal(fakeQueries().length, before + 1);
  var query = lastFakeQuery();
  assert.equal(query.hasEnvOption, true, "the SDK is handed an environment");
  assert.equal(query.env.OPENAI_BASE_URL, SETTINGS.OPENAI_BASE_URL);
  assert.equal(query.env.FROM_SETTINGS, "yes");
  assert.equal(query.env.PATH, process.env.PATH, "options.env replaces the environment, so PATH is carried over");
  assert.equal(query.env.HOME, process.env.HOME, "and so is HOME");
  assert.equal(process.env.FROM_SETTINGS, undefined, "the daemon's own environment is not changed");
  handle.close();
});

test("a Claude query handed a protected variable in the overlay does not get it", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({
    cwd: os.tmpdir(),
    runtimeEnv: { FROM_SETTINGS: "yes", PATH: "/tmp/evil", NODE_OPTIONS: "--require=/tmp/evil.js", BASH_ENV: "/tmp/evil.sh" },
  });
  var query = lastFakeQuery();
  assert.equal(query.env.FROM_SETTINGS, "yes");
  assert.equal(query.env.PATH, process.env.PATH);
  assert.notEqual(query.env.NODE_OPTIONS, "--require=/tmp/evil.js");
  assert.equal(query.env.BASH_ENV, process.env.BASH_ENV);
  handle.close();
});

test("a Claude query with no Settings variables is left to inherit the daemon's environment as before", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handleNone = await adapter.createQuery({ cwd: os.tmpdir() });
  assert.equal(lastFakeQuery().hasEnvOption, false);
  handleNone.close();
  var handleEmpty = await adapter.createQuery({ cwd: os.tmpdir(), runtimeEnv: {} });
  assert.equal(lastFakeQuery().hasEnvOption, false);
  handleEmpty.close();
});

test("a Claude warmup starts the CLI with the Settings variables too", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  await adapter.init({ cwd: os.tmpdir(), runtimeEnv: SETTINGS });
  var query = lastFakeQuery();
  assert.equal(query.hasEnvOption, true);
  assert.equal(query.env.FROM_SETTINGS, "yes");
  assert.equal(query.env.PATH, process.env.PATH);
});

test("Claude title generation starts its query with the Settings variables", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  await adapter.generateTitle(["fix the build"], { cwd: os.tmpdir(), runtimeEnv: SETTINGS });
  var query = lastFakeQuery();
  assert.equal(query.model, "haiku", "this is the title query");
  assert.equal(query.env.FROM_SETTINGS, "yes");
  assert.equal(query.env.PATH, process.env.PATH);
});

// --- Claude, in the OS user's worker: what the daemon sends ---

function fakeWorker() {
  var sent = [];
  return {
    sent: sent,
    ready: true,
    process: { killed: false, pid: 4242 },
    messageHandlers: [],
    exitPromise: Promise.resolve(),
    send: function (msg) { sent.push(msg); },
    onMessage: function (handler) { this.messageHandlers.push(handler); },
  };
}

test("a Claude query for an OS user sends the Settings variables to the worker, not a replacement environment", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  await adapter.createQuery({
    cwd: os.tmpdir(),
    runtimeEnv: SETTINGS,
    adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker } } },
  });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.ok(start, "the worker is started on a query");
  assert.deepEqual(start.options.runtimeEnv, SETTINGS);
  assert.equal(start.options.env, undefined, "the daemon's environment is not what the worker's CLI gets");
});

test("a Claude query for an OS user with no Settings variables sends none", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  await adapter.createQuery({
    cwd: os.tmpdir(),
    adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker } } },
  });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.equal("runtimeEnv" in start.options, false);
});

// --- Claude, in the OS user's worker: the worker process ---

async function startWorker() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-worker-env-"));
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

  // The worker's own environment, as buildUserEnv gives an OS user's.
  var child = spawn(process.execPath, ["--import", pathToFileURL(path.join(FIXTURE_DIR, "register.mjs")).href,
    path.join(__dirname, "..", "lib", "yoke", "adapters", "claude-worker.js"), socketPath], {
    env: { PATH: process.env.PATH, HOME: dir, USER: "alice", LANG: "C.UTF-8" },
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });

  var worker = {
    dir: dir,
    next: function (predicate, label) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error("timed out waiting for " + label)); }, 20000);
        waiters.push({ predicate: predicate, resolve: function (m) { clearTimeout(timer); resolve(m); } });
        deliver();
      });
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

async function envReportedByWorker(options) {
  var worker = await startWorker();
  try {
    worker.send({ type: "query_start", prompt: null, options: Object.assign({ cwd: os.tmpdir() }, options), singleTurn: false });
    var probe = await worker.next(function (m) {
      return m.type === "sdk_event" && m.event.type === "fake_probe" && m.event.call === "env";
    }, "the environment probe");
    return { env: probe.event.env, optionKeys: probe.event.optionKeys, dir: worker.dir };
  } finally {
    await worker.stop();
  }
}

test("the worker lays the Settings variables over the OS user's own environment and hands the SDK all of it", async function () {
  var seen = await envReportedByWorker({ runtimeEnv: Object.assign({ BASH_ENV: "/tmp/evil.sh", PATH: "/tmp/evil" }, SETTINGS) });
  assert.equal(seen.env.FROM_SETTINGS, "yes");
  assert.equal(seen.env.OPENAI_BASE_URL, SETTINGS.OPENAI_BASE_URL);
  assert.equal(seen.env.PATH, process.env.PATH, "the OS user's PATH survives, and settings cannot replace it");
  assert.equal(seen.env.HOME, seen.dir, "so does the OS user's HOME");
  assert.equal(seen.env.USER, "alice");
  assert.equal(seen.env.BASH_ENV, undefined, "a protected variable is dropped in the worker as well");
  assert.equal(seen.optionKeys.indexOf("runtimeEnv"), -1, "the overlay does not go on to the SDK as an option");
});

test("a worker query with no Settings variables leaves the SDK to inherit the worker's environment", async function () {
  var worker = await startWorker();
  try {
    worker.send({ type: "query_start", prompt: null, options: { cwd: os.tmpdir() }, singleTurn: false });
    var probe = await worker.next(function (m) {
      return m.type === "sdk_event" && m.event.type === "fake_probe" && m.event.call === "env";
    }, "the environment probe");
    assert.equal(probe.event.optionKeys.indexOf("env"), -1);
    assert.equal(probe.event.env.HOME, worker.dir);
  } finally {
    await worker.stop();
  }
});

// --- Codex ---

function codexAdapter() {
  return codexModule.createCodexAdapter({ cwd: os.tmpdir(), slug: "alpha" });
}

test("the Codex app-server is started with the complete environment and the Settings variables laid over it", async function () {
  var adapter = codexAdapter();
  var before = appServers.length;
  await adapter.init({ runtimeEnv: SETTINGS });
  assert.equal(appServers.length, before + 1);
  var env = appServers[appServers.length - 1].opts.env;
  assert.equal(env.OPENAI_BASE_URL, SETTINGS.OPENAI_BASE_URL);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  await adapter.shutdown();
});

test("a Codex app-server started with no Settings variables is given no environment of its own", async function () {
  var adapter = codexAdapter();
  await adapter.init({});
  assert.equal(appServers[appServers.length - 1].opts.env, undefined);
  await adapter.shutdown();
});

// A query handle takes its server's event handler when it starts running, which
// a first message does: that is what shows which server a query runs on.
async function openQuery(adapter, env) {
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: env });
  handle.pushMessage("go");
  return handle;
}

test("a Codex query whose environment differs runs on its own app-server, and the query already running is unaffected", async function () {
  var adapter = codexAdapter();
  var a = await openQuery(adapter, { ENDPOINT: "https://a.example.invalid" });
  var serverA = appServers[appServers.length - 1];
  assert.equal(serverA.opts.env.ENDPOINT, "https://a.example.invalid");

  // Query A is open. Query B asks for another environment.
  var count = appServers.length;
  var b = await openQuery(adapter, { ENDPOINT: "https://b.example.invalid" });
  assert.equal(appServers.length, count + 1, "B gets a server of its own");
  var serverB = appServers[appServers.length - 1];
  assert.notEqual(serverB, serverA);
  assert.equal(serverB.opts.env.ENDPOINT, "https://b.example.invalid", "B runs with env B");
  assert.equal(serverA.opts.env.ENDPOINT, "https://a.example.invalid", "A's server keeps env A");
  assert.equal(serverA.queriesServed, 1, "A's server served A only");
  assert.equal(serverB.queriesServed, 1, "B's server served B only");
  assert.equal(serverA.stopped, false, "A is not disturbed");

  a.close();
  b.close();
  await adapter.shutdown();
  assert.equal(serverA.stopped, true);
  assert.equal(serverB.stopped, true);
});

test("Codex queries with the same environment share one app-server", async function () {
  var adapter = codexAdapter();
  var first = await openQuery(adapter, { ONE: "1" });
  var count = appServers.length;
  var second = await openQuery(adapter, { ONE: "1" });
  assert.equal(appServers.length, count, "no second server for the same variables");
  assert.equal(appServers[appServers.length - 1].queriesServed, 2);
  first.close();
  second.close();
  await adapter.shutdown();
});

test("a Codex query that names no Settings variables is not served by a server that has some", async function () {
  var adapter = codexAdapter();
  var withVariables = await openQuery(adapter, { ONE: "1" });
  var serverWith = appServers[appServers.length - 1];
  var count = appServers.length;
  var without = await openQuery(adapter, undefined);
  assert.equal(appServers.length, count + 1);
  var serverWithout = appServers[appServers.length - 1];
  assert.equal(serverWithout.opts.env, undefined, "it inherits the daemon's environment, nothing added");
  assert.equal(serverWith.queriesServed, 1);
  assert.equal(serverWithout.queriesServed, 1);
  withVariables.close();
  without.close();
  await adapter.shutdown();
});

test("an app-server nothing is using is reclaimed when idle, one in use is not", async function () {
  var adapter = codexAdapter();
  var busy = await adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: { ONE: "1" } });
  var busyServer = appServers[appServers.length - 1];
  var done = await adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: { ONE: "2" } });
  var doneServer = appServers[appServers.length - 1];
  done.close();
  await sleep(20);

  assert.equal(await adapter.shutdownIfIdle(0), true);
  assert.equal(doneServer.stopped, true, "the idle server is ended");
  assert.equal(busyServer.stopped, false, "the server a query is using is not");

  // The environment that was reclaimed gets a fresh server on its next query.
  var count = appServers.length;
  var again = await adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: { ONE: "2" } });
  assert.equal(appServers.length, count + 1);
  assert.equal(appServers[appServers.length - 1].opts.env.ONE, "2");
  busy.close();
  again.close();
  await adapter.shutdown();
});

test("a Codex app-server that fails to start leaves nothing behind, so the next query starts again", async function () {
  var adapter = codexAdapter();
  var realStart = FakeAppServer.prototype.start;
  FakeAppServer.prototype.start = function () { return Promise.reject(new Error("no binary")); };
  try {
    await assert.rejects(adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: { ONE: "1" } }), /no binary/);
  } finally {
    FakeAppServer.prototype.start = realStart;
  }
  var recovered = await adapter.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: { ONE: "1" } });
  assert.equal(appServers[appServers.length - 1].started, true);
  recovered.close();
  await adapter.shutdown();
});
