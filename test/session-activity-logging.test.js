"use strict";
// What the journal shows about a session's activity clock and its queries:
// the idle reaper names the sessions it left alone for an open prompt, each
// bump of lastActivityAt names its source (debug level), and the startQuery and
// result lines name the project, because console session ids repeat across
// projects.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createPromptRegistry } = require("../lib/prompt-registry");
var { bumpLastActivity } = require("../lib/activity-clock");
var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var world = require("./prompt-harness-world");

var TICK_MS = 60 * 1000;
var MIN = 60 * 1000;

function captureLog(t) {
  var lines = [];
  t.mock.method(console, "log", function () { lines.push(Array.prototype.join.call(arguments, " ")); });
  return lines;
}

function withDebug(value, fn) {
  var before = process.env.CLAGENTIC_CONSOLE_DEBUG;
  if (value) process.env.CLAGENTIC_CONSOLE_DEBUG = value;
  else delete process.env.CLAGENTIC_CONSOLE_DEBUG;
  try { return fn(); }
  finally {
    if (before === undefined) delete process.env.CLAGENTIC_CONSOLE_DEBUG;
    else process.env.CLAGENTIC_CONSOLE_DEBUG = before;
  }
}

function makeSm() {
  var sm = {
    sessions: new Map(),
    currentModel: null,
    currentPermissionMode: null,
    currentEffort: null,
    currentBetas: [],
    modelsByVendor: {},
    availableVendors: [],
    installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (session, obj) { (session.history = session.history || []).push(obj); },
    sendToSession: function () {},
    notifications: null,
  };
  sm.permissionRequestIndex = Object.create(null);
  sm.prompts = createPromptRegistry({
    index: sm.permissionRequestIndex,
    getSession: function (id) { return sm.sessions.get(id); },
    sendAndRecord: function (session, obj) { return sm.sendAndRecord(session, obj); },
    saveSessionFile: function () {},
    getProjectSlug: function () { return "proj"; },
  });
  return sm;
}

function makeSession(localId, overrides) {
  return Object.assign({
    localId: localId,
    queryInstance: { close: function () {}, pushMessage: function () {} },
    messageQueue: null,
    isProcessing: false,
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now() - 40 * MIN,
    history: [],
  }, overrides || {});
}

function freshBridge(sm) {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge").createSDKBridge({
    cwd: "/tmp",
    slug: "proj",
    sessionManager: sm,
    send: function () {},
    adapter: { vendor: "claude" },
    adapters: {},
  });
}

test("a sweep that leaves sessions alone for an open prompt names them, once per sweep", function (t) {
  var lines = captureLog(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  var sm = makeSm();
  var bridge = freshBridge(sm);
  var held = makeSession(1);
  var idle = makeSession(2);
  var second = makeSession(3);
  [held, idle, second].forEach(function (s) { sm.sessions.set(s.localId, s); });
  sm.prompts.open(held, "permission", { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" }, {});
  sm.prompts.open(second, "permission", { toolName: "Bash", toolInput: { command: "ls" }, vendor: "claude" }, {});
  sm.prompts.open(second, "permission", { toolName: "Bash", toolInput: { command: "pwd" }, vendor: "claude" }, {});
  lines.length = 0;

  bridge.startIdleReaper();
  t.mock.timers.tick(TICK_MS);
  var swept = lines.filter(function (l) { return l.indexOf("Idle reaper: skipped") !== -1; });
  assert.equal(swept.length, 1, "one line for the whole sweep");
  assert.match(swept[0], /^\[sdk-bridge\] Idle reaper: skipped 2 session\(s\) with an open prompt: project=proj sessions=1:prompts=1:idle=4\d+min,3:prompts=2:idle=4\d+min$/);
  assert.doesNotMatch(swept[0], /(sessions=|,)2:/, "the idle session without a prompt is not listed");

  t.mock.timers.tick(TICK_MS);
  assert.equal(lines.filter(function (l) { return l.indexOf("Idle reaper: skipped") !== -1; }).length, 2, "and again on the next sweep");
  bridge.stopIdleReaper();
});

test("a sweep with no open prompt logs no skipped line", function (t) {
  var lines = captureLog(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  var sm = makeSm();
  var bridge = freshBridge(sm);
  sm.sessions.set(1, makeSession(1));
  bridge.startIdleReaper();
  t.mock.timers.tick(TICK_MS);
  assert.equal(lines.filter(function (l) { return l.indexOf("Idle reaper: skipped") !== -1; }).length, 0);
  bridge.stopIdleReaper();
});

test("a bump of lastActivityAt names its source when debug is on, and is silent when it is off", function (t) {
  var lines = captureLog(t);
  var session = { localId: 12, lastActivityAt: 0 };
  withDebug("1", function () { bumpLastActivity(session, "turn-result", "alpha"); });
  assert.ok(session.lastActivityAt > 0);
  assert.deepEqual(lines, ["[activity] lastActivityAt bump: project=alpha session=12 source=turn-result"]);

  lines.length = 0;
  session.lastActivityAt = 0;
  withDebug(null, function () { bumpLastActivity(session, "turn-result", "alpha"); });
  assert.ok(session.lastActivityAt > 0, "the clock still moves");
  assert.deepEqual(lines, []);
});

test("the bridge's push and the message processor's task events each report their own source", function (t) {
  var lines = captureLog(t);
  var sm = makeSm();
  var bridge = freshBridge(sm);
  var processor = attachMessageProcessor({
    sm: sm, send: function () {}, slug: "proj", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; }, adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
  var session = makeSession(5, { blocks: {}, sentToolResults: {}, messageUUIDs: [], activeTaskToolIds: {}, responsePreview: "" });
  sm.sessions.set(5, session);

  withDebug("1", function () {
    bridge.pushMessage(session, "hi", null, "human");
    processor.processSDKMessage(session, { yokeType: "task_started", parentToolId: "tool-1", taskId: "t1", description: "d" });
    processor.processSDKMessage(session, { yokeType: "task_progress", parentToolId: "tool-1", taskId: "t1" });
    processor.processSDKMessage(session, { yokeType: "tool_progress", parentToolId: "tool-1", text: "x" });
    processor.processSDKMessage(session, { yokeType: "task_updated", taskId: "t1", patch: {} });
  });
  var sources = lines.filter(function (l) { return l.indexOf("[activity]") === 0; }).map(function (l) {
    assert.match(l, /project=proj session=5 /);
    return l.replace(/^.*source=/, "");
  });
  assert.deepEqual(sources, ["push-message", "task_started", "task_progress", "tool_progress", "task_updated"]);
});

// Send now interrupts the running turn with the query kept, so the CLI ends the
// turn with an abort result. The abort the console caused reads as an
// interruption; any other result keeps its error line.
var ABORT_STREAMING = { yokeType: "result", subtype: "error_during_execution", errors: [], terminalReason: "aborted_streaming", cost: 0 };
var ABORT_TOOLS = { yokeType: "result", subtype: "error_during_execution", errors: [], terminalReason: "aborted_tools", cost: 0 };
var API_FAILURE = { yokeType: "result", subtype: "error_during_execution", errors: ["upstream"], terminalReason: "api_error", cost: 0 };
var SUCCESS = { yokeType: "result", subtype: "success", cost: 0.01 };

// Each step is "interrupt" (a Send now interrupt, reply pending) or a result.
var SEND_NOW_ROWS = [
  { name: "AC1 marker set, aborted_streaming: interrupted, done 0, no error", steps: ["interrupt", ABORT_STREAMING], shows: ["interrupted"] },
  { name: "AC2 marker set, aborted_tools: interrupted, done 0, no error", steps: ["interrupt", ABORT_TOOLS], shows: ["interrupted"] },
  { name: "AC3 no marker, aborted_streaming: error as today", steps: [ABORT_STREAMING], shows: ["error"] },
  { name: "AC3 no marker, aborted_tools: error as today", steps: [ABORT_TOOLS], shows: ["error"] },
  { name: "AC4 marker set, api_error result: its error, marker consumed", steps: ["interrupt", API_FAILURE, ABORT_TOOLS], shows: ["error", "error"] },
  { name: "AC5 marker consumed by success, a later abort shows its error", steps: ["interrupt", SUCCESS, ABORT_STREAMING], shows: ["result", "error"] },
];

SEND_NOW_ROWS.forEach(function (row) {
  test("Send now interrupt: " + row.name, async function (t) {
    var server = await world.createServer();
    try {
      await server.bridge.startQuery(server.session, "go", null, null);
      await world.flush();
      server.session.queryInstance.interruptKeepingQueued = function () { return new Promise(function () {}); };
      captureLog(t);
      t.mock.method(console, "error", function () {});
      var recorded = [];
      t.mock.method(server.sm, "sendAndRecord", function (session, obj) { recorded.push(obj); });
      var seen = [];
      row.steps.forEach(function (step) {
        if (step === "interrupt") { server.bridge.interruptKeepingQueued(server.session); return; }
        recorded.length = 0;
        server.sdk(step);
        var done = recorded.filter(function (m) { return m.type === "done"; });
        var hasError = recorded.some(function (m) { return m.type === "error"; });
        var hasInfo = recorded.some(function (m) { return m.type === "info"; });
        if (step.subtype === "success") seen.push("result");
        else if (hasError) { seen.push("error"); assert.equal(done[0].code, 1); assert.match(recorded.filter(function (m) { return m.type === "error"; })[0].text, /error:/); }
        else { seen.push("interrupted"); assert.ok(hasInfo); assert.equal(done[0].code, 0); }
      });
      assert.deepEqual(seen, row.shows);
    } finally {
      server.shutdown();
      world.removeHome(server.home);
    }
  });
});

test("Send now interrupt: one log line names the session with debug off, and a failed interrupt clears the marker", async function (t) {
  var server = await world.createServer();
  try {
    await server.bridge.startQuery(server.session, "go", null, null);
    await world.flush();
    server.session.queryInstance.interruptKeepingQueued = function () { return Promise.reject(new Error("no")); };
    var lines = captureLog(t);
    await withDebug(null, async function () {
      await assert.rejects(server.bridge.interruptKeepingQueued(server.session), /no/);
    });
    var requested = lines.filter(function (l) { return l.indexOf("Send now interrupt requested") !== -1; });
    assert.deepEqual(requested, ["[sdk-bridge] Send now interrupt requested: project=harness session=" + server.session.localId]);
    assert.equal(server.session.selfCausedInterrupt, false, "a refused interrupt leaves no marker");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("the startQuery and result lines carry the project and not the prompt", async function (t) {
  var server = await world.createServer();
  try {
    var lines = captureLog(t);
    await server.bridge.startQuery(server.session, "SECRET-PROMPT-TEXT", null, null);
    await world.flush();
    server.sdk({ yokeType: "result", subtype: "error_during_execution", errors: ["boom"], cost: 0 });

    var start = lines.filter(function (l) { return l.indexOf("[sdk-bridge] startQuery:") === 0; });
    assert.deepEqual(start, ["[sdk-bridge] startQuery: project=harness vendor=claude session=" + server.session.localId]);
    var result = lines.filter(function (l) { return l.indexOf("result handler") !== -1; });
    assert.equal(result.length, 1);
    assert.match(result[0], /^\[sdk-bridge\] result handler: project harness session \d+ cost=/);
    var slot = lines.filter(function (l) { return l.indexOf("Live query count") !== -1; });
    assert.ok(slot.length > 0);
    slot.forEach(function (l) { assert.match(l, /\(project harness session \d+ /); });
    lines.forEach(function (l) { assert.equal(l.indexOf("SECRET-PROMPT-TEXT"), -1); });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});
