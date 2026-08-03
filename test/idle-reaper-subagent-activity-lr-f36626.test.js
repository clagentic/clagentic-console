/**
 * Regression tests for lr-f36626: the idle-session reaper in sdk-bridge.js
 * kills sessions that are WAITING on a live background subagent, orphaning
 * the in-flight child.
 *
 * Root cause: session.lastActivityAt was bumped only at the two top-level
 * turn/query sites in sdk-bridge.js (post-pushMessage on startQuery, and on
 * every 'result'). Nothing bumped it when a BACKGROUND SUBAGENT (Agent-tool
 * dispatch) produced output, and session.isProcessing is false while the
 * parent session sits in the dispatch-loop WAITING state (the parent turn's
 * own 'result' already fired). After IDLE_TIMEOUT_MS the reaper closed
 * queryInstance, tearing down the stream hosting the still-running child.
 *
 * Fix: lib/sdk-message-processor.js now also bumps session.lastActivityAt on
 * genuine backgrounded-Task stream activity (subagent_message tool_use/
 * thinking/text, tool_progress, task_started, task_progress, task_updated).
 * Deliberately NOT a blanket "never reap while any child is registered" rule
 * — a dead/silent child (no activity for the full IDLE_TIMEOUT_MS) must still
 * become reapable, or a leaked registration would pin the session (and its
 * process) alive forever.
 *
 * Covers (regression guard, both directions per the task's LOCKED SCOPE):
 *   (1) subagent stream events bump session.lastActivityAt
 *   (2) a session with recent subagent activity is NOT reaped by the idle
 *       reaper even though isProcessing is false and IDLE_TIMEOUT_MS has
 *       nominally elapsed since the last top-level turn
 *   (3) a session whose child registration is stale (activeTaskToolIds
 *       non-empty but zero activity for the full timeout) is still reaped —
 *       rejects the blanket "never reap if any child registered" rule
 *   (4) a genuinely idle session with no child at all is reaped exactly as
 *       before (no regression to the pre-existing idle-reap behavior)
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

// ---------------------------------------------------------------------------
// Part 1: sdk-message-processor.js activity-bump coverage
// ---------------------------------------------------------------------------

function makeSm() {
  return {
    skillMeta: [],
    workflowMeta: [],
    skillNames: [],
    slashCommands: null,
    currentModel: null,
    _savedDefaultModel: null,
    sendAndRecord: function (session, obj) {
      if (!session.history) session.history = [];
      session.history.push(obj);
    },
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    modelsByVendor: {},
    availableModels: [],
    availableVendors: [],
    installedVendors: [],
  };
}

function makeProcessor(sm) {
  return attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test-slug",
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

function makeSession(overrides) {
  return Object.assign({
    localId: "s1",
    cliSessionId: null,
    vendor: "claude",
    history: [],
    messageUUIDs: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    isProcessing: false,
    lastActivityAt: 0,
    responsePreview: "",
  }, overrides || {});
}

test("lr-f36626: subagent_message (tool_use) bumps session.lastActivityAt", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });
  var before = Date.now();

  proc.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: "task-1",
    messageRole: "assistant",
    content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { description: "run tests" } }],
  });

  assert.ok(session.lastActivityAt >= before, "lastActivityAt should be bumped to ~now");
});

test("lr-f36626: subagent_message (thinking) bumps session.lastActivityAt", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });
  var before = Date.now();

  proc.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: "task-1",
    messageRole: "assistant",
    content: [{ type: "thinking" }],
  });

  assert.ok(session.lastActivityAt >= before);
});

test("lr-f36626: tool_progress with a parentToolId bumps session.lastActivityAt", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });
  var before = Date.now();

  proc.processSDKMessage(session, {
    yokeType: "tool_progress",
    parentToolId: "task-1",
    text: "still working...",
  });

  assert.ok(session.lastActivityAt >= before);
});

test("lr-f36626: tool_progress WITHOUT a parentToolId does not bump (not subagent-scoped)", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });

  proc.processSDKMessage(session, { yokeType: "tool_progress", text: "no parent" });

  assert.equal(session.lastActivityAt, 1000, "no parentToolId means no genuine subagent signal");
});

test("lr-f36626: task_started bumps session.lastActivityAt and records taskIdMap", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });
  var before = Date.now();

  proc.processSDKMessage(session, {
    yokeType: "task_started",
    parentToolId: "task-1",
    taskId: "abc",
    description: "background build",
  });

  assert.ok(session.lastActivityAt >= before);
  assert.equal(session.taskIdMap["task-1"], "abc");
});

test("lr-f36626: task_progress bumps session.lastActivityAt", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000 });
  var before = Date.now();

  proc.processSDKMessage(session, {
    yokeType: "task_progress",
    parentToolId: "task-1",
    taskId: "abc",
  });

  assert.ok(session.lastActivityAt >= before);
});

test("lr-f36626: task_updated bumps session.lastActivityAt when a matching taskIdMap entry exists", function () {
  var sm = makeSm();
  var proc = makeProcessor(sm);
  var session = makeSession({ lastActivityAt: 1000, taskIdMap: { "task-1": "abc" } });
  var before = Date.now();

  // lr-1317b8: the flattened yoke envelope uses camelCase taskId everywhere
  // (see task_started/task_progress above in this same file) — task_id here
  // was a fixture bug that happened to "pass" only because
  // sdk-message-processor.js:702 itself read parsed.task_id (also wrong).
  // Both are fixed together; this fixture now matches the real envelope
  // shape flattenEvent() produces (see
  // test/claude-adapter-sdk-lifecycle-lr-1317b8.test.js Defect 4).
  proc.processSDKMessage(session, {
    yokeType: "task_updated",
    taskId: "abc",
    patch: { status: "running" },
  });

  assert.ok(session.lastActivityAt >= before);
});

// ---------------------------------------------------------------------------
// Part 2: idle reaper behavior in sdk-bridge.js
// ---------------------------------------------------------------------------

function makeEmptyHandle() {
  var closed = false;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    pushMessage: function () {},
    close: function () { closed = true; },
    endInput: function () {},
    abort: function () { closed = true; },
  };
}

function makeSessionManagerForBridge() {
  return {
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
    sendAndRecord: function (session, obj) {
      if (!session.history) session.history = [];
      session.history.push(obj);
    },
    sendToSession: function () {},
  };
}

function makeReaperSession(localId, overrides) {
  var closed = { value: false };
  var queryInstance = {
    close: function () { closed.value = true; },
  };
  return Object.assign({
    localId: localId,
    queryInstance: queryInstance,
    messageQueue: null,
    isProcessing: false,
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now(),
    _closed: closed,
  }, overrides || {});
}

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
}

test("lr-f36626: a session with recent subagent activity survives the idle reaper past the timeout window", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var sm = makeSessionManagerForBridge();
    var bridge = sdkBridgeMod.createSDKBridge({
      cwd: "/tmp",
      slug: "test",
      sessionManager: sm,
      send: function () {},
      adapter: { vendor: "claude" },
      adapters: {},
    });

    // Simulate: parent turn completed 30+ minutes ago (top-level bump is
    // stale), but the backgrounded child kept reporting in 1 minute ago —
    // the exact WAITING-on-live-child shape from the bug report.
    var recentSubagentActivity = Date.now() - 60 * 1000; // 1 min ago
    var session = makeReaperSession(1, {
      lastActivityAt: recentSubagentActivity,
      activeTaskToolIds: { "task-1": true },
    });
    sm.sessions.set(1, session);

    bridge.startIdleReaper();
    // Advance past IDLE_TIMEOUT_MS (30 min) in IDLE_CHECK_INTERVAL_MS (60s) ticks.
    t.mock.timers.tick(60 * 1000 * 32);

    assert.equal(session._closed.value, false, "session with recent subagent activity must not be reaped");
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-f36626: a session with a dead/silent child (no activity for the full timeout) is still reaped — no blanket exemption", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var sm = makeSessionManagerForBridge();
    var bridge = sdkBridgeMod.createSDKBridge({
      cwd: "/tmp",
      slug: "test",
      sessionManager: sm,
      send: function () {},
      adapter: { vendor: "claude" },
      adapters: {},
    });

    // activeTaskToolIds is non-empty (a child was registered) but nothing has
    // bumped lastActivityAt in over 30 minutes — the child is dead/silent.
    var staleActivity = Date.now() - 40 * 60 * 1000; // 40 min ago
    var session = makeReaperSession(2, {
      lastActivityAt: staleActivity,
      activeTaskToolIds: { "task-1": true },
    });
    sm.sessions.set(2, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 2); // two 60s ticks is enough to observe the reap

    assert.equal(session._closed.value, true, "a dead/silent child must not pin the session alive forever");
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-f36626: a genuinely idle session with no child at all is reaped exactly as before (no regression)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var sm = makeSessionManagerForBridge();
    var bridge = sdkBridgeMod.createSDKBridge({
      cwd: "/tmp",
      slug: "test",
      sessionManager: sm,
      send: function () {},
      adapter: { vendor: "claude" },
      adapters: {},
    });

    var staleActivity = Date.now() - 40 * 60 * 1000;
    var session = makeReaperSession(3, {
      lastActivityAt: staleActivity,
      activeTaskToolIds: {},
    });
    sm.sessions.set(3, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 2);

    assert.equal(session._closed.value, true);
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-f36626: a session within the idle window (recent top-level activity, no subagent) is not reaped (no regression)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var sm = makeSessionManagerForBridge();
    var bridge = sdkBridgeMod.createSDKBridge({
      cwd: "/tmp",
      slug: "test",
      sessionManager: sm,
      send: function () {},
      adapter: { vendor: "claude" },
      adapters: {},
    });

    var session = makeReaperSession(4, { lastActivityAt: Date.now() });
    sm.sessions.set(4, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 2);

    assert.equal(session._closed.value, false);
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});
