"use strict";
// The initiator of a turn, per turn: the vocabulary and its Claude mapping, the
// Claude adapter's stamping and environment (in process and as sent to a
// worker), and each entry point naming its own initiator. The Claude Agent SDK
// is a stand-in that records what it was handed.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var turnInitiator = require("../lib/turn-initiator");
var claudeModule = require("../lib/yoke/adapters/claude");
var { attachUserMessage } = require("../lib/project-user-message");
var { attachExternalTrigger } = require("../lib/project-external-trigger");
var { INITIATORS } = turnInitiator;
var APP_ID = "clagentic-console/" + require("../package.json").version;

function lastFakeQuery() {
  var all = globalThis.__fakeAgentSdkQueries || [];
  return all[all.length - 1];
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// --- Vocabulary and Claude mapping ---

test("each initiator maps to the Claude SDK origin its contract names", function () {
  assert.deepEqual(turnInitiator.claudeOrigin(INITIATORS.HUMAN), { kind: "human" });
  assert.deepEqual(turnInitiator.claudeOrigin(INITIATORS.SCHEDULED),
    { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "scheduled" });
  assert.deepEqual(turnInitiator.claudeOrigin(INITIATORS.SCHEDULED_NOW),
    { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "manual" });
  assert.deepEqual(turnInitiator.claudeOrigin(INITIATORS.LOOP),
    { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "loop" });
  assert.deepEqual(turnInitiator.claudeOrigin(INITIATORS.TRIGGER),
    { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "trigger" });
});

test("a turn that names no initiator, or one nobody defined, is not stamped", function () {
  [undefined, null, "", "robot"].forEach(function (value) {
    assert.equal(turnInitiator.claudeOrigin(value), undefined);
    assert.equal(turnInitiator.isClientComposed(value), false);
    var message = turnInitiator.stampClaudeUserMessage({ type: "user" }, value);
    assert.equal("origin" in message, false);
    assert.equal("client_composed" in message, false);
  });
});

test("every turn except a typed one is client composed", function () {
  assert.equal(turnInitiator.isClientComposed(INITIATORS.HUMAN), false);
  [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP, INITIATORS.TRIGGER].forEach(function (i) {
    assert.equal(turnInitiator.isClientComposed(i), true, i);
    assert.equal(turnInitiator.stampClaudeUserMessage({}, i).client_composed, true, i);
  });
  assert.equal("client_composed" in turnInitiator.stampClaudeUserMessage({}, INITIATORS.HUMAN), false);
});

test("the Claude process environment keeps the base, then the overlay, then the product identity", function () {
  var env = turnInitiator.claudeProcessEnv({ PATH: "/bin", KEEP: "1" }, { FROM_SETTINGS: "yes", CLAUDE_AGENT_SDK_CLIENT_APP: "other/1" }, INITIATORS.HUMAN);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.KEEP, "1");
  assert.equal(env.FROM_SETTINGS, "yes");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, APP_ID, "the product identity is not settable from Settings");
  assert.equal(env.CLAUDE_CODE_HOST_SCHEDULED_RUN, undefined);
  [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP, INITIATORS.TRIGGER].forEach(function (i) {
    assert.equal(turnInitiator.claudeProcessEnv({}, null, i).CLAUDE_CODE_HOST_SCHEDULED_RUN, "1", i);
  });
  [INITIATORS.HUMAN, undefined].forEach(function (i) {
    assert.equal(turnInitiator.claudeProcessEnv({}, null, i).CLAUDE_CODE_HOST_SCHEDULED_RUN, undefined, String(i));
  });
});

// --- Claude adapter, in process ---

test("one in-process session carries a different origin on each turn", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), initiator: INITIATORS.HUMAN });
  handle.pushMessage("typed", undefined, INITIATORS.HUMAN);
  handle.pushMessage("fired", undefined, INITIATORS.SCHEDULED);
  handle.pushMessage("typed again", undefined, INITIATORS.HUMAN);
  handle.pushMessage("untagged");
  await sleep(50);
  var messages = lastFakeQuery().messages;
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0].origin, { kind: "human" });
  assert.equal("client_composed" in messages[0], false);
  assert.equal(messages[1].origin.fireReason, "scheduled");
  assert.equal(messages[1].client_composed, true);
  assert.deepEqual(messages[2].origin, { kind: "human" });
  assert.equal("origin" in messages[3], false);
  assert.equal(messages[0].message.content[0].text, "typed");
  handle.close();
});

test("a process started for a scheduled turn declares itself a host-scheduled run, one for a typed turn does not", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var scheduled = await adapter.createQuery({ cwd: os.tmpdir(), initiator: INITIATORS.SCHEDULED_NOW });
  assert.equal(lastFakeQuery().env.CLAUDE_CODE_HOST_SCHEDULED_RUN, "1");
  assert.equal(lastFakeQuery().env.CLAUDE_AGENT_SDK_CLIENT_APP, APP_ID);
  scheduled.close();
  var loop = await adapter.createQuery({ cwd: os.tmpdir(), initiator: INITIATORS.LOOP });
  assert.equal(lastFakeQuery().env.CLAUDE_CODE_HOST_SCHEDULED_RUN, "1");
  loop.close();
  var trigger = await adapter.createQuery({ cwd: os.tmpdir(), initiator: INITIATORS.TRIGGER });
  assert.equal(lastFakeQuery().env.CLAUDE_CODE_HOST_SCHEDULED_RUN, "1");
  trigger.close();
  var typed = await adapter.createQuery({ cwd: os.tmpdir(), initiator: INITIATORS.HUMAN });
  assert.equal(lastFakeQuery().env.CLAUDE_CODE_HOST_SCHEDULED_RUN, undefined);
  assert.equal(lastFakeQuery().env.CLAUDE_AGENT_SDK_CLIENT_APP, APP_ID);
  assert.equal(process.env.CLAUDE_CODE_HOST_SCHEDULED_RUN, undefined, "the daemon's own environment is not changed");
  typed.close();
});

// --- Claude adapter, as sent to the OS user's worker ---

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

test("a worker query is told the first turn's initiator and every pushed message arrives stamped", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  var handle = await adapter.createQuery({
    cwd: os.tmpdir(),
    initiator: INITIATORS.SCHEDULED,
    adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker } } },
  });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.equal(start.options.initiator, INITIATORS.SCHEDULED);
  assert.equal("env" in start.options, false, "the worker builds the environment from its own");

  handle.pushMessage("loop turn", undefined, INITIATORS.LOOP);
  handle.pushMessage("typed", undefined, INITIATORS.HUMAN);
  var pushed = worker.sent.filter(function (m) { return m.type === "push_message"; }).map(function (m) { return m.content; });
  assert.deepEqual(pushed[0].origin, { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "loop" });
  assert.equal(pushed[0].client_composed, true);
  assert.deepEqual(pushed[1].origin, { kind: "human" });
  assert.equal("client_composed" in pushed[1], false);
});

test("a worker query for a typed turn carries the initiator too, and none when the turn names none", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker } } } });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.equal("initiator" in start.options, false);
});

// --- Entry points name their own initiator ---

function makeMessageHandler(calls) {
  var sessions = new Map();
  var session = {
    localId: 7, vendor: "claude", history: [], title: "t", isProcessing: false,
    scheduledMessage: null, sentToolResults: {},
  };
  sessions.set(session.localId, session);
  var noop = function () {};
  var sm = {
    sessions: sessions,
    saveSessionFile: noop, broadcastSessionList: noop, appendToSessionFile: noop,
    sendAndRecord: noop,
    recordHistoryEntry: function (s, entry) { s.history.push(entry); },
  };
  var sdk = {
    startQuery: function (s, text, images, user, initiator) { calls.push({ call: "startQuery", text: text, initiator: initiator }); },
    pushMessage: function (s, text, images, initiator) { calls.push({ call: "pushMessage", text: text, initiator: initiator }); },
  };
  var handler = attachUserMessage({
    cwd: os.tmpdir(), slug: "p", osUsers: false, sm: sm, sdk: sdk, nm: {}, tm: {},
    send: noop, sendTo: noop, sendToSession: noop, sendToSessionOthers: noop, clients: new Set(),
    opts: {}, usersModule: {},
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: noop, hydrateImageRefs: function (m) { return m; }, saveImageFile: noop, imagesDir: os.tmpdir(),
    onProcessingChanged: noop,
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: { _browserTabList: {} },
    scheduleMessage: noop, cancelScheduledMessage: noop,
    loadContextSources: function () { return []; }, saveContextSources: noop,
    adapter: { renameSession: function () { return Promise.resolve(); } },
  });
  return { handler: handler, session: session };
}

test("a typed message names the human as the initiator, both when it starts a turn and when it joins a running one", function () {
  var calls = [];
  var h = makeMessageHandler(calls);
  h.handler.handleUserMessage({}, { type: "message", text: "first" });
  h.session.isProcessing = true;
  h.handler.handleUserMessage({}, { type: "message", text: "second" });
  assert.deepEqual(calls.map(function (c) { return c.call + ":" + c.initiator; }), ["startQuery:human", "pushMessage:human"]);
  assert.equal("humanOriginated" in h.session, false, "nothing about the initiator is kept on the session");
});

test("forcing a scheduled message to send now makes a scheduled-now turn, and a typed one after it is human again", function () {
  var calls = [];
  var h = makeMessageHandler(calls);
  h.session.scheduledMessage = { text: "scheduled text", timer: setTimeout(function () {}, 1) };
  h.handler.handleUserMessage({}, { type: "send_scheduled_now" });
  h.handler.handleUserMessage({}, { type: "message", text: "typed after" });
  assert.deepEqual(calls.map(function (c) { return c.text + ":" + c.initiator; }), ["scheduled text:scheduled-now", "typed after:human"]);
});

test("an external trigger names the trigger as the initiator for a spawned session and for an injected message", async function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-initiator-"));
  var calls = [];
  var live = { localId: "live", cliSessionId: "cli-1", history: [], isProcessing: false, sentToolResults: {} };
  // A session whose query is running takes the input into that query.
  var running = { localId: "running", cliSessionId: "cli-2", history: [], isProcessing: true, queryInstance: {}, sentToolResults: {} };
  var sessions = new Map([["live", live], ["running", running]]);
  var noop = function () {};
  var project = {
    sm: {
      sessions: sessions,
      createSession: function () { return { localId: "new", history: [], isProcessing: false, sentToolResults: {} }; },
      saveSessionFile: noop, broadcastSessionList: noop, appendToSessionFile: noop,
      recordHistoryEntry: function (s, entry) { s.history.push(entry); },
    },
    sdk: {
      startQuery: function (s, text, images, user, initiator) { calls.push("startQuery:" + initiator); },
      pushMessage: function (s, text, images, initiator) { calls.push("pushMessage:" + initiator); },
    },
    send: noop, onProcessingChanged: noop, getLinuxUserForSession: function () { return null; },
  };
  var et = attachExternalTrigger({ triggersDir: tmpDir, getProject: function () { return project; } });
  function write(id, extra) {
    fs.writeFileSync(path.join(tmpDir, id + ".json"), JSON.stringify(Object.assign({
      version: 1, id: "trigger-" + id + "-001", projectSlug: "test-project", initialPrompt: "go", contextNote: "Test", createdAt: new Date().toISOString(),
    }, extra)));
  }
  et.startWatcher();
  write("spawn", {});
  write("inject", { version: 2, sessionId: "cli-1" });
  write("inject-running", { version: 2, sessionId: "cli-2" });
  await sleep(700);
  et.stopWatcher();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // An idle session has no query to take the message, so one must start or the
  // input is silently dropped.
  assert.deepEqual(calls.slice().sort(), ["pushMessage:trigger", "startQuery:trigger", "startQuery:trigger"]);
});

test("a loop iteration names the loop as the initiator", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-initiator-"));
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-initiator-home-"));
  var gitEnv = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: cwd, env: gitEnv });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: cwd, env: gitEnv });
  var dir = path.join(cwd, ".claude", "loops", "loop_init1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ loopMode: "simple", maxIterations: 1 }));

  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var started = [];
  var engine;
  var origSetTimeout = global.setTimeout;
  var armed = [];
  // The iteration arms a ten-minute watchdog: record it so it can be cleared.
  global.setTimeout = function (fn, delay) {
    var timer = origSetTimeout(fn, delay);
    armed.push(timer);
    return timer;
  };
  try {
    var noop = function () {};
    var nextId = 1;
    var sessions = new Map();
    engine = require("../lib/project-loop").attachLoop({
      cwd: cwd, slug: "p",
      sm: {
        sessions: sessions, setResolveLoopInfo: noop,
        createSession: function () {
          var s = { localId: nextId++, history: [], loop: {}, isProcessing: false };
          sessions.set(s.localId, s);
          return s;
        },
        saveSessionFile: noop, appendToSessionFile: noop, broadcastSessionList: noop,
        recordHistoryEntry: function (s, entry) { s.history.push(entry); },
      },
      sdk: { startQuery: function (s, text, images, user, initiator) { started.push(initiator); } },
      send: noop, sendTo: noop, sendToSession: noop, pushModule: null, notificationsModule: null,
      getHubSchedules: function () { return []; }, getAllProjectSessions: function () { return []; },
      getStatus: noop, getLinuxUserForSession: function () { return null; }, onProcessingChanged: noop, hydrateImageRefs: noop,
    });
    engine.stopTimer();
    engine.loopState.loopId = "loop_init1";
    engine.loopState.loopFilesId = "loop_init1";
    engine.loopState.wizardData = { loopMode: "simple" };
    engine.startLoop({ maxIterations: 1 });
    assert.deepEqual(started, [INITIATORS.LOOP]);
  } finally {
    global.setTimeout = origSetTimeout;
    armed.forEach(function (t) { clearTimeout(t); });
    if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
