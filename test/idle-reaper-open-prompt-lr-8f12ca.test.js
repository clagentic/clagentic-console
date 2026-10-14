/**
 * An open operator prompt means the session is waiting on the operator, so
 * the idle reaper must not end it; when it does end a session that still has
 * background agents, it must say so and mark the session resumable; and a
 * prompt raised by a background agent must say which agent raised it.
 *
 * Drives the real bridge, the real prompt registry and the real reclaim
 * helper over a minimal session manager.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { promptsFor, createPromptRegistry } = require("../lib/prompt-registry");
var sessionReclaim = require("../lib/session-reclaim");

var TICK_MS = 60 * 1000;

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
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
    saved: [],
    saveSessionFile: function (s) { sm.saved.push(s.localId); },
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (session, obj) {
      if (!session.history) session.history = [];
      session.history.push(obj);
    },
    sendToSession: function () {},
    notifications: null,
  };
  // Wired as the project wires it, so a prompt's notification is observable.
  sm.permissionRequestIndex = Object.create(null);
  sm.prompts = createPromptRegistry({
    index: sm.permissionRequestIndex,
    getSession: function (id) { return sm.sessions.get(id); },
    sendAndRecord: function (session, obj) { return sm.sendAndRecord(session, obj); },
    saveSessionFile: function (session) { return sm.saveSessionFile(session); },
    getNotificationsModule: function () { return sm.notifications; },
  });
  return sm;
}

function makeSession(localId, overrides) {
  var closed = { value: false };
  return Object.assign({
    localId: localId,
    queryInstance: { close: function () { closed.value = true; } },
    messageQueue: null,
    isProcessing: false,
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now() - 40 * 60 * 1000,
    history: [],
    _closed: closed,
  }, overrides || {});
}

function makeBridge(sm, extra) {
  var sent = [];
  var bridge = freshSdkBridge().createSDKBridge(Object.assign({
    cwd: "/tmp",
    slug: "proj",
    sessionManager: sm,
    send: function (o) { sent.push(o); },
    adapter: { vendor: "claude" },
    adapters: {},
  }, extra || {}));
  return { bridge: bridge, sent: sent };
}

test("a session with a background agent blocked on a permission prompt is not reaped, however long it waits", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var h = makeBridge(sm);
    var prompts = promptsFor(sm);
    var session = makeSession(1, { activeTaskToolIds: { "task-1": true } });
    sm.sessions.set(1, session);

    prompts.noteSubagentTool(session, "toolu_sub_1", "task-1");
    var opened = prompts.open(session, "permission", {
      toolName: "Bash", toolInput: { command: "lore task create x" }, vendor: "claude",
    }, { toolUseId: "toolu_sub_1" });
    assert.equal(opened.pending, true);

    h.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 90); // three times IDLE_TIMEOUT_MS
    assert.equal(session._closed.value, false, "an open prompt means the operator owes an answer, not idleness");
    assert.equal(h.sent.length, 0);

    // Once the operator answers, the ordinary idle clock applies again.
    prompts.respond(opened.requestId, { decision: "deny" });
    t.mock.timers.tick(TICK_MS * 2);
    assert.equal(session._closed.value, true);
    h.bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("a session with an open top-level ask prompt is not reaped either", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var h = makeBridge(sm);
    var session = makeSession(2);
    sm.sessions.set(2, session);
    promptsFor(sm).open(session, "permission", {
      toolName: "Bash", toolInput: { command: "make" }, vendor: "claude",
    }, { toolUseId: "toolu_top" });

    h.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 45);
    assert.equal(session._closed.value, false);
    h.bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("reaping a session whose background agents went silent names them, marks it resumable and tells both surfaces", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var h = makeBridge(sm);
    var session = makeSession(3, { activeTaskToolIds: { "task-a": true, "task-b": true } });
    sessionReclaim.noteTaskLabel(session, "task-a", { description: "Run the migration" });
    sessionReclaim.noteTaskLabel(session, "task-b", { subagent_type: "reviewer" });
    sm.sessions.set(3, session);

    h.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS);

    assert.equal(session._closed.value, true);
    assert.equal(session.pendingAutoResume, true);
    assert.equal(session.pendingAutoResumeReason, "idle_reap");
    assert.ok(sm.saved.indexOf(3) !== -1, "the resumable marker is persisted");

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, "diagnostic");
    assert.equal(h.sent[0].source, "idle-reap");
    assert.match(h.sent[0].message, /Run the migration/);
    assert.match(h.sent[0].message, /reviewer/);
    assert.match(h.sent[0].message, /Clagentic: Console/);

    var inline = session.history.filter(function (e) { return e.type === "error"; });
    assert.equal(inline.length, 1);
    assert.match(inline[0].text, /Run the migration/);
    h.bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("reaping a session with no background agents stays silent, as before", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var h = makeBridge(sm);
    var session = makeSession(4);
    sm.sessions.set(4, session);

    h.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 2);

    assert.equal(session._closed.value, true);
    assert.equal(session.pendingAutoResume, undefined);
    assert.equal(h.sent.length, 0);
    h.bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("a permission prompt raised by a background agent names the agent on the card and in the notification", function () {
  var sm = makeSm();
  var notes = [];
  sm.notifications = { notify: function (type, payload) { notes.push({ type: type, payload: payload }); } };
  var h = makeBridge(sm);
  var prompts = promptsFor(sm);
  var session = makeSession(5, { activeTaskToolIds: { "task-1": true } });
  sm.sessions.set(5, session);
  sessionReclaim.noteTaskLabel(session, "task-1", { description: "Create the tasks" });
  prompts.noteSubagentTool(session, "toolu_sub", "task-1");

  var pending = h.bridge.handleCanUseTool(session, "Bash", { command: "rm -rf build" }, {
    toolUseID: "toolu_sub",
    signal: new AbortController().signal,
  });

  var req = session.history.filter(function (e) { return e.type === "prompt_request"; });
  assert.equal(req.length, 1, "the prompt is recorded for every client");
  assert.match(req[0].decisionReason, /Create the tasks/);
  assert.equal(notes.length, 1);
  assert.match(notes[0].payload.title, /^Background agent "Create the tasks": /);

  prompts.respond(req[0].requestId, { decision: "deny" });
  return pending;
});

test("a dispatched Task is named from its input, and forgotten when it ends", function () {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor");
  var sm = makeSm();
  var proc = attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "proj",
    cwd: "/tmp",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {},
    onTurnDone: null,
    onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
  var session = makeSession(7, {
    blocks: {}, sentToolResults: {}, messageUUIDs: [], activeTaskToolIds: {},
    pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {}, responsePreview: "",
  });
  sm.sessions.set(7, session);

  proc.processSDKMessage(session, { yokeType: "tool_start", blockId: 0, toolId: "task-x", toolName: "Task" });
  proc.processSDKMessage(session, {
    yokeType: "tool_input_delta", blockId: 0,
    partialJson: JSON.stringify({ description: "Audit\nthe   logs" }),
  });
  proc.processSDKMessage(session, { yokeType: "block_stop", blockId: 0 });
  assert.deepEqual(sessionReclaim.liveAgentLabels(session), ["Audit the logs"]);

  proc.processSDKMessage(session, { yokeType: "task_notification", parentToolId: "task-x", taskId: "t1", status: "completed" });
  assert.deepEqual(sessionReclaim.liveAgentLabels(session), []);
});

test("a top-level permission prompt is unchanged by agent naming", function () {
  var sm = makeSm();
  var notes = [];
  sm.notifications = { notify: function (type, payload) { notes.push(payload); } };
  var h = makeBridge(sm);
  var session = makeSession(6);
  sm.sessions.set(6, session);

  var pending = h.bridge.handleCanUseTool(session, "Bash", { command: "rm -rf build" }, {
    toolUseID: "toolu_top",
    decisionReason: "because",
    signal: new AbortController().signal,
  });
  var req = session.history.filter(function (e) { return e.type === "prompt_request"; })[0];
  assert.equal(req.decisionReason, "because");
  assert.doesNotMatch(notes[0].title, /Background agent/);
  promptsFor(sm).respond(req.requestId, { decision: "deny" });
  return pending;
});

function makeProcessor(sm) {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor");
  return attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "proj",
    cwd: "/tmp",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {},
    onTurnDone: null,
    onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
}

function dispatchNamedTask(proc, taskId, description) {
  proc.processSDKMessage(proc.session, { yokeType: "tool_start", blockId: 0, toolId: taskId, toolName: "Task" });
  proc.processSDKMessage(proc.session, {
    yokeType: "tool_input_delta", blockId: 0, partialJson: JSON.stringify({ description: description }),
  });
  proc.processSDKMessage(proc.session, { yokeType: "block_stop", blockId: 0 });
}

test("a Task that completed with its prompt still open keeps its name for memory reclaim and idle reap, and loses it when the prompt settles", function (t) {
  var { shedMemory, _resetRateLimitForTest } = require("../lib/memory-shed");
  _resetRateLimitForTest();
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var h = makeBridge(sm);
    var proc = makeProcessor(sm);
    var prompts = promptsFor(sm);
    var session = makeSession(8, {
      blocks: {}, sentToolResults: {}, messageUUIDs: [], activeTaskToolIds: {},
      pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {}, responsePreview: "",
    });
    sm.sessions.set(8, session);
    proc.session = session;

    dispatchNamedTask(proc, "task-open", "Create the lore tasks");
    prompts.noteSubagentTool(session, "toolu_sub_open", "task-open");
    var opened = prompts.open(session, "permission", {
      toolName: "Bash", toolInput: { command: "lore task create x" }, vendor: "claude",
    }, { toolUseId: "toolu_sub_open" });

    // The Task completes by both end paths while its prompt is open.
    proc.processSDKMessage(session, { yokeType: "task_notification", parentToolId: "task-open", taskId: "t1", status: "completed" });
    assert.deepEqual(sessionReclaim.liveAgentLabels(session), ["Create the lore tasks"]);

    // Idle reap: the open prompt means the operator owes an answer, so the
    // session is not reaped and the Task is still named.
    h.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 90);
    assert.equal(session._closed.value, false);
    h.bridge.stopIdleReaper();

    // Memory-pressure reclaim names the Task, not the fallback.
    var shedSent = [];
    sm.forceEvictToLimit = function () { return { evicted: 1, reclaimedLiveChild: [session] }; };
    sm.LRU_HISTORY_LIMIT = 10;
    sm.retrimHistory = function () {};
    shedMemory({
      projects: [{ slug: "proj", sm: sm, send: function (o) { shedSent.push(o); } }],
      log: function () {},
      nowMs: Date.now() + 3600 * 1000,
      rssBefore: 2000, readRssBytes: function () { return 1000; },
    });
    var reclaim = shedSent.filter(function (o) { return o.source === "memory-reclaim"; });
    assert.equal(reclaim.length, 1);
    assert.match(reclaim[0].message, /Create the lore tasks/);
    assert.doesNotMatch(reclaim[0].message, /"background agent"|background agent \(/);

    // Once the prompt settles the Task leaves tracking and the name goes with it.
    prompts.respond(opened.requestId, { decision: "deny" });
    assert.deepEqual(sessionReclaim.liveAgentLabels(session), []);
    sessionReclaim.pruneTaskLabels(session);
    assert.deepEqual(Object.keys(session.taskLabels), []);
  } finally {
    t.mock.timers.reset();
  }
});

test("a Task whose tool_result arrives with its prompt open keeps its name", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var prompts = promptsFor(sm);
  var session = makeSession(9, {
    blocks: {}, sentToolResults: {}, messageUUIDs: [], activeTaskToolIds: {},
    pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {}, responsePreview: "",
  });
  sm.sessions.set(9, session);
  proc.session = session;

  dispatchNamedTask(proc, "task-r", "Audit the logs");
  prompts.noteSubagentTool(session, "toolu_sub_r", "task-r");
  prompts.open(session, "permission", {
    toolName: "Bash", toolInput: { command: "ls" }, vendor: "claude",
  }, { toolUseId: "toolu_sub_r" });

  proc.processSDKMessage(session, {
    yokeType: "message", messageRole: "user",
    content: [{ type: "tool_result", tool_use_id: "task-r", content: "done" }],
  });
  assert.deepEqual(sessionReclaim.liveAgentLabels(session), ["Audit the logs"]);
});
