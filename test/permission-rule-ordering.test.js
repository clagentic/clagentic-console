"use strict";
// Claude Code evaluates the user's own deny, allow and ask rules and the
// permission mode itself, and calls the console's canUseTool only for a call
// that still needs an answer. So an allow-rule match never reaches the console,
// and a deny-rule match never does either. This file pins the console's side of
// that contract:
//   (a) every Claude launch path loads the user's settings: settingSources is
//       ["user", "project", "local"] on the session query, the rewind query,
//       the in-process and worker queries, and both warmups;
//   (b) no launch path carries allowedTools, disallowedTools or
//       permissionPromptToolName, which would let the console pre-empt or
//       replace the user's rules;
//   (c) a canUseTool ask that carries matchedAskRule (the user's own ask rule
//       forced it) is never auto-approved by the console, even for a call its
//       read-only allowlist would otherwise wave through. It opens a prompt.
// The Claude Agent SDK is the repo's stand-in, which records the options it
// was started with.

var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("child_process");
var EventEmitter = require("events");
var fs = require("fs");
var net = require("net");
var nodeModule = require("node:module");
var os = require("os");
var path = require("path");
var { spawn } = require("child_process");
var { pathToFileURL } = require("url");

var FIXTURE_DIR = path.join(__dirname, "fixtures", "fake-agent-sdk");
nodeModule.register(pathToFileURL(path.join(FIXTURE_DIR, "resolve-hook.mjs")).href);

var world = require("./prompt-harness-world");
var { promptsFor } = require("../lib/prompt-registry");
var claudeModule = require("../lib/yoke/adapters/claude");

var USER_SOURCES = ["user", "project", "local"];
var CONSOLE_MUST_NOT_SET = ["allowedTools", "disallowedTools", "permissionPromptToolName"];
var CLAUDE_ADAPTER_PATH = require.resolve("../lib/yoke/adapters/claude");
var WORKER_PATH = path.join(__dirname, "..", "lib", "yoke", "adapters", "claude-worker.js");

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function lastFakeQuery() {
  var all = globalThis.__fakeAgentSdkQueries || [];
  return all[all.length - 1];
}

// The rule check for one option object, wherever the launch path keeps it.
function assertUserRulesApply(options, where) {
  assert.ok(options, where + ": options were captured");
  assert.deepEqual(options.settingSources, USER_SOURCES, where + ": the user's settings are loaded");
  CONSOLE_MUST_NOT_SET.forEach(function (key) {
    assert.equal(key in options, false, where + ": " + key + " is not set by the console");
  });
}

// What a launch path hands the bridge-to-adapter seam: the adapter options
// and the top-level query options.
function assertQueryOpts(queryOpts, where) {
  CONSOLE_MUST_NOT_SET.forEach(function (key) {
    assert.equal(key in queryOpts, false, where + ": query option " + key + " is not set by the console");
  });
  assertUserRulesApply(queryOpts.adapterOptions && queryOpts.adapterOptions.CLAUDE, where + " (adapter options)");
}

// --- (a) and (b): the bridge's own launches, over the real adapter and the stand-in SDK ---

function makeBridge() {
  var realAdapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var adapter = {
    vendor: "claude",
    createQuery: realAdapter.createQuery,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null, currentBetas: [],
    modelsByVendor: {}, availableVendors: [], installedVendors: [], defaultVendor: "claude",
    saveSessionFile: function () {}, broadcastSessionList: function () {}, getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function () {}, sendToSession: function () {},
  };
  var bridge = createSDKBridge({
    cwd: os.tmpdir(), slug: "permission-rule-ordering", sessionManager: sm,
    send: function () {},
    adapter: adapter, adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
  return { bridge: bridge, sm: sm };
}

function makeSession() {
  return {
    localId: 9101, queryInstance: null, messageQueue: null, abortController: null, isProcessing: false,
    cliSessionId: "cli-9101", history: [], blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingAskUser: {},
    pendingElicitations: {}, activeTaskToolIds: {}, singleTurn: false, lastActivityAt: Date.now(),
    _isCountedLive: false, _adapterWorkerState: null, _workerExitPromise: null,
  };
}

test("a session query reaches the SDK with the user's settings loaded and no console tool lists", async function () {
  var h = makeBridge();
  var session = makeSession();
  h.sm.sessions.set(session.localId, session);
  await h.bridge.startQuery(session, "hello", undefined, null);
  await sleep(40);
  assertUserRulesApply(lastFakeQuery().options, "session query (SDK options)");
  if (session.queryInstance) session.queryInstance.close();
  await sleep(40);
});

test("the rewind query reaches the SDK with the user's settings loaded and no console tool lists", async function () {
  var h = makeBridge();
  var session = makeSession();
  var rewind = await h.bridge.getOrCreateRewindQuery(session);
  assert.equal(rewind.isTemp, true, "no live query, so a temporary one was started");
  assertUserRulesApply(lastFakeQuery().options, "rewind query (SDK options)");
  rewind.cleanup();
});

test("the bridge hands the adapter the user's sources and no console tool lists on a session start", async function () {
  await world.withServer(async function (server) {
    await server.startQuery();
    assert.ok(server.queryOptions.length >= 1, "the session start created a query");
    server.queryOptions.forEach(function (queryOpts, i) { assertQueryOpts(queryOpts, "session start query " + i); });
  });
});

// --- (a) and (b): the adapter, in process and in the OS user's worker ---

test("an in-process warmup loads the user's settings and sets no console tool lists", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  await adapter.init({ cwd: os.tmpdir() });
  assertUserRulesApply(lastFakeQuery().options, "in-process warmup");
});

test("a worker query forwards the bridge's sources and sets no console tool lists", async function () {
  await world.withServer(async function (server) {
    await server.startQuery();
    var claudeOpts = server.queryOptions[0].adapterOptions.CLAUDE;

    var sent = [];
    var fakeWorker = {
      ready: true,
      process: { killed: false, pid: 4242 },
      messageHandlers: [],
      exitPromise: Promise.resolve(),
      send: function (msg) { sent.push(msg); },
      onMessage: function (handler) { this.messageHandlers.push(handler); },
    };
    var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
    await adapter.createQuery({
      cwd: os.tmpdir(),
      adapterOptions: { CLAUDE: Object.assign({}, claudeOpts, { linuxUser: "alice", _workerState: { worker: fakeWorker } }) },
    });
    var start = sent.find(function (m) { return m.type === "query_start"; });
    assert.ok(start, "the worker is started on a query");
    assertUserRulesApply(start.options, "worker query_start");
  });
});

test("a worker warmup asks for the user's settings and sets no console tool lists", async function () {
  // The warmup spawns the worker as another OS user. Swap spawn for a recorder
  // while the adapter loads (it takes spawn at load), then play the worker's
  // side of the socket by hand.
  var spawned = [];
  var realSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args) {
    var fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    // No pid and already killed: the adapter's kill paths then signal no real process.
    fake.pid = undefined;
    fake.killed = true;
    spawned.push({ socketPath: args[1], process: fake });
    return fake;
  };
  var adapterModule;
  try {
    delete require.cache[CLAUDE_ADAPTER_PATH];
    adapterModule = require("../lib/yoke/adapters/claude");
  } finally {
    childProcess.spawn = realSpawn;
    delete require.cache[CLAUDE_ADAPTER_PATH];
  }

  var adapter = adapterModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var warmup = adapter.init({ cwd: os.tmpdir(), linuxUser: os.userInfo().username });
  for (var i = 0; i < 100 && !spawned.length; i++) await sleep(20);
  assert.equal(spawned.length, 1, "the warmup started a worker");

  var received = [];
  var buffer = "";
  var conn = net.connect(spawned[0].socketPath);
  conn.on("data", function (chunk) {
    buffer += chunk.toString();
    var lines = buffer.split("\n");
    buffer = lines.pop();
    lines.filter(Boolean).forEach(function (line) { received.push(JSON.parse(line)); });
  });
  await new Promise(function (resolve, reject) { conn.once("connect", resolve); conn.once("error", reject); });
  conn.write(JSON.stringify({ type: "ready" }) + "\n");
  for (i = 0; i < 100 && !received.some(function (m) { return m.type === "warmup"; }); i++) await sleep(20);
  var message = received.find(function (m) { return m.type === "warmup"; });
  assert.ok(message, "the worker is sent a warmup");
  assertUserRulesApply(message.options, "worker warmup");

  conn.write(JSON.stringify({ type: "warmup_done", result: { models: [] } }) + "\n");
  await warmup;
  conn.destroy();
  // The worker's exit is what closes the adapter's socket server; without it
  // the server keeps this test file's process alive.
  spawned[0].process.emit("exit", 0, null);
});

// --- (a) and (b): the worker process itself adds nothing ---

test("the worker process starts the SDK with the options it was sent and adds no console tool lists", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-rule-ordering-"));
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
  function next(predicate, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("timed out waiting for " + label)); }, 20000);
      waiters.push({ predicate: predicate, resolve: function (m) { clearTimeout(timer); resolve(m); } });
      deliver();
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
  var child = spawn(process.execPath, ["--import", pathToFileURL(path.join(FIXTURE_DIR, "register.mjs")).href, WORKER_PATH, socketPath], {
    env: { PATH: process.env.PATH, HOME: dir },
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await next(function (m) { return m.type === "ready"; }, "ready");
    connection.write(JSON.stringify({ type: "query_start", prompt: null, options: { cwd: dir, settingSources: USER_SOURCES }, singleTurn: false }) + "\n");
    var probe = await next(function (m) {
      return m.type === "sdk_event" && m.event.type === "fake_probe" && m.event.call === "env";
    }, "the option probe");
    assert.ok(probe.event.optionKeys.indexOf("settingSources") !== -1, "the sources the daemon sent reach the SDK");
    CONSOLE_MUST_NOT_SET.forEach(function (key) {
      assert.equal(probe.event.optionKeys.indexOf(key), -1, "the worker does not add " + key);
    });
  } finally {
    try { child.kill("SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await new Promise(function (resolve) { server.close(resolve); if (connection) connection.destroy(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- (c): a rule-forced ask is a human prompt, whatever the console would allow ---

var RULE = { source: "projectSettings", toolName: "Bash", ruleContent: "git status:*" };

test("a canUseTool ask that carries matchedAskRule opens a prompt even for a call the console's allowlist approves", async function () {
  await world.withServer(async function (server) {
    var prompts = promptsFor(server.sm);
    var calls = [
      { tool: "Bash", input: { command: "git status" } },
      { tool: "Read", input: { file_path: "/srv/app/a.txt" } },
    ];
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      var control = server.ask(call.tool, call.input, {});
      assert.equal(control.opened.length, 0, call.tool + " control: the allowlist approves without a prompt");
      assert.equal((await control.promise).behavior, "allow", call.tool + " control: allowed");

      var forced = server.ask(call.tool, call.input, { matchedAskRule: RULE });
      assert.equal(forced.opened.length, 1, call.tool + ": the user's ask rule opens a prompt");
      assert.deepEqual(server.heldPromptIds(), [forced.id], call.tool + ": and nothing answered it");
      prompts.respond(forced.id, { decision: "deny" });
      assert.equal((await forced.promise).behavior, "deny", call.tool + ": only the operator's answer settles it");
    }
  });
});
