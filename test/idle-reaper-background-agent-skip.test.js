/**
 * The idle reaper never ends a session that is held processing by a tracked
 * background agent that has not sent its terminal task_notification, however
 * long the agent is silent: ending the query closes the stream that hosts it
 * and kills the work (a long test run emits nothing for tens of minutes).
 *
 * Drives the real message processor, the real activity registry and the real
 * bridge reaper over one session, so the held token that makes isProcessing
 * true is the one production creates.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var { promptsFor } = require("../lib/prompt-registry");
var sessionActivity = require("../lib/session-activity");
var { _test_flattenEvent: flatten } = require("../lib/yoke/adapters/claude");

var TICK_MS = 60 * 1000;
var LONG_SILENCE_MS = 40 * 60 * 1000;
var AGENT = "toolu_bg_agent";
var AGENT_TASK = "task-one";

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
}

function makeSm() {
  return {
    sessions: new Map(),
    currentModel: null, currentPermissionMode: null, currentEffort: null, currentBetas: [],
    _savedDefaultModel: null, skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (session, obj) { (session.history = session.history || []).push(obj); },
    sendToSession: function () {},
  };
}

function makeSession() {
  var closed = { value: false };
  return {
    localId: 1, cliSessionId: null, vendor: "claude", history: [], messageUUIDs: [],
    blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {},
    pendingAskUser: {}, activeTaskToolIds: {}, taskIdMap: {}, streamedText: false,
    responsePreview: "", isProcessing: true, loop: null,
    queryInstance: { close: function () { closed.value = true; } },
    messageQueue: null, singleTurn: false, destroying: false,
    lastActivityAt: Date.now(), _closed: closed,
  };
}

function rig() {
  var sm = makeSm();
  var sent = [];
  var session = makeSession();
  sm.sessions.set(session.localId, session);
  var bridge = freshSdkBridge().createSDKBridge({
    cwd: "/tmp", slug: "proj", sessionManager: sm, send: function (o) { sent.push(o); },
    adapter: { vendor: "claude" }, adapters: {},
  });
  var processor = attachMessageProcessor({
    sm: sm, send: function () {}, slug: "proj", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; }, mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
  return { sm: sm, session: session, bridge: bridge, processor: processor, sent: sent };
}

function feed(r, msg) { r.processor.processSDKMessage(r.session, msg); }

function dispatch(r, toolId, taskId, background) {
  var input = { description: "agent " + taskId, subagent_type: "general-purpose" };
  if (background) input.run_in_background = true;
  feed(r, { yokeType: "tool_start", blockId: 0, toolId: toolId, toolName: "Agent" });
  feed(r, { yokeType: "tool_input_delta", blockId: 0, partialJson: JSON.stringify(input) });
  feed(r, { yokeType: "block_stop", blockId: 0 });
  feed(r, { yokeType: "task_started", parentToolId: toolId, taskId: taskId, description: input.description });
}

function toolResult(r, toolId, content, toolUseResult) {
  feed(r, flatten({
    type: "user", uuid: "u-" + toolId, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: content, is_error: false }] },
    tool_use_result: toolUseResult,
  }));
}

function launchBackground(r, toolId, taskId) {
  dispatch(r, toolId, taskId, true);
  toolResult(r, toolId, "Async agent launched", { isAsync: true, status: "async_launched", agentId: taskId });
}

function endTurn(r) { feed(r, { yokeType: "result", cost: 0, duration: 1, sessionId: "cli-1" }); }

function notify(r, toolId, taskId, status) {
  feed(r, { yokeType: "task_notification", parentToolId: toolId, taskId: taskId, status: status, summary: "" });
}

// The lr-33cc81 state: the parent turn ended, the agent holds the session.
function backgroundHeld() {
  var r = rig();
  launchBackground(r, AGENT, AGENT_TASK);
  endTurn(r);
  assert.equal(r.session.isProcessing, true, "precondition: the agent's token holds the session");
  return r;
}

function silentFor(r, ms) { r.session.lastActivityAt = Date.now() - ms; }

function reap(t, r, ticks) {
  r.bridge.startIdleReaper();
  t.mock.timers.tick(TICK_MS * ticks);
  r.bridge.stopIdleReaper();
}

function withTimers(fn) {
  return function (t) {
    t.mock.timers.enable({ apis: ["setInterval"] });
    try { return fn(t); } finally { t.mock.timers.reset(); }
  };
}

test("AC1: a tracked background agent silent past IDLE_TIMEOUT_MS with no prompt open is not reaped", withTimers(function (t) {
  var r = backgroundHeld();
  silentFor(r, LONG_SILENCE_MS);
  assert.equal(promptsFor(r.sm).pendingCount(r.session), 0);

  reap(t, r, 90); // three times IDLE_TIMEOUT_MS of ticks

  assert.equal(r.session._closed.value, false, "the query that hosts the agent must stay open");
  assert.equal(r.sent.length, 0, "no reclaim notice is sent for a session that was not ended");
  assert.equal(r.session.pendingAutoResume, undefined);
}));

test("AC2: after the terminal notification (completed, failed or stopped) the session is reaped as an ordinary idle session", function (t) {
  ["completed", "failed", "stopped"].forEach(function (status) {
    withTimers(function (tt) {
      var r = backgroundHeld();
      notify(r, AGENT, AGENT_TASK, status);
      endTurn(r); // the turn that handles the notification
      assert.equal(r.session.isProcessing, false, status + ": nothing holds the session");
      silentFor(r, LONG_SILENCE_MS);

      reap(tt, r, 2);

      assert.equal(r.session._closed.value, true, status);
      assert.equal(r.session.pendingAutoResume, undefined, status + ": no agent left to name");
    })(t);
  });
});

test("several background agents: the session is held until the last one is terminal", withTimers(function (t) {
  var r = rig();
  launchBackground(r, AGENT, AGENT_TASK);
  launchBackground(r, "toolu_second", "task-two");
  endTurn(r);
  notify(r, AGENT, AGENT_TASK, "completed");
  endTurn(r);
  assert.equal(r.session.isProcessing, true, "the second agent still holds the session");
  silentFor(r, LONG_SILENCE_MS);

  r.bridge.startIdleReaper();
  t.mock.timers.tick(TICK_MS * 2);
  assert.equal(r.session._closed.value, false);

  notify(r, "toolu_second", "task-two", "failed");
  endTurn(r);
  silentFor(r, LONG_SILENCE_MS);
  t.mock.timers.tick(TICK_MS * 2);
  assert.equal(r.session._closed.value, true);
  r.bridge.stopIdleReaper();
}));

test("a foreground agent holds the session while it runs and the reaper skips it, as any processing session", withTimers(function (t) {
  var r = rig();
  dispatch(r, "toolu_fg", "task-fg", false);
  assert.equal(r.session.isProcessing, true);
  silentFor(r, LONG_SILENCE_MS);

  reap(t, r, 2);

  assert.equal(r.session._closed.value, false);
}));

test("the query ending releases a launched agent's token, so the session no longer reads as processing", function () {
  var r = backgroundHeld();
  promptsFor(r.sm).endQuery(r.session, {}, true);
  r.processor.releaseTurnActivity(r.session);
  assert.equal(sessionActivity.isSessionActive(r.session), false);
  assert.equal(r.session.activeTaskToolIds[AGENT], undefined);
});

test("AC3: a leaked token with no queryInstance is still recovered by the sweep backstop", function (t) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    var r = rig();
    r.session.queryInstance = null;
    r.session.isProcessing = true;
    sessionActivity.acquireToken(r.session, "toolu_leaked", { source: "task" });

    r.bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 6); // past the 5-minute backstop window
    r.bridge.stopIdleReaper();

    assert.equal(sessionActivity.isSessionActive(r.session), false);
    assert.equal(r.session.isProcessing, false);
  } finally {
    t.mock.timers.reset();
  }
});

test("AC4: a session with no background agent is reaped as before, silently", withTimers(function (t) {
  var r = rig();
  r.session.isProcessing = false;
  silentFor(r, LONG_SILENCE_MS);

  reap(t, r, 2);

  assert.equal(r.session._closed.value, true);
  assert.equal(r.sent.length, 0);
}));

test("AC4: the open-prompt and keep-alive skips still hold for an idle session", withTimers(function (t) {
  var kept = rig();
  kept.session.isProcessing = false;
  kept.session.keepAlive = true;
  silentFor(kept, LONG_SILENCE_MS);
  reap(t, kept, 2);
  assert.equal(kept.session._closed.value, false, "keep-alive");

  var prompted = rig();
  prompted.session.isProcessing = false;
  promptsFor(prompted.sm).open(prompted.session, "permission", {
    toolName: "Bash", toolInput: { command: "make" }, vendor: "claude",
  }, { toolUseId: "toolu_top" });
  silentFor(prompted, LONG_SILENCE_MS);
  reap(t, prompted, 2);
  assert.equal(prompted.session._closed.value, false, "open prompt");
}));
