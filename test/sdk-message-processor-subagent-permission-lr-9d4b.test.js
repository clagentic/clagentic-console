/**
 * Regression test for lr-9d4b: a backgrounded sub-agent's Bash permission
 * resolver is destroyed by the PARENT turn's 'result' handler.
 *
 * Scenario (MILLER root cause, confidence 0.9): a Task tool launches an async
 * sub-agent. The sub-agent issues its own tool call (e.g. Bash) and that
 * call's canUseTool Promise is still pending -- the permission card is on the
 * UI -- when the PARENT turn's SDK 'result' message arrives. Before the fix,
 * the result handler in sdk-message-processor.js unconditionally reset
 * session.pendingPermissions = {}, deleting the sub-agent's still-open
 * resolver. The operator's later permission_response then found nothing to
 * resolve (project-sessions.js:1143 `if (!pending) return true;`) and the
 * sub-agent's canUseTool Promise hung forever.
 *
 * This test drives the exact sequence through the real message processor:
 *   1. block_stop for a Task tool_use -> activeTaskToolIds[taskToolId] = true
 *   2. subagent_message (assistant) with a Bash tool_use -> records
 *      subagentToolOwners[bashToolId] = taskToolId
 *   3. A pendingPermissions entry is registered for that Bash call (as
 *      sdk-bridge.js's handleCanUseTool would do), carrying toolUseId ===
 *      bashToolId.
 *   4. The PARENT turn's 'result' event fires while the sub-agent is still
 *      running (its Task id is still in activeTaskToolIds).
 *
 * Assert the sub-agent's pendingPermissions entry survives the result handler,
 * and that calling its resolve() (simulating the operator's later
 * permission_response) still settles the original canUseTool Promise.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

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

function makeSession() {
  return {
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
    taskIdMap: {},
    streamedText: false,
    responsePreview: "",
    isProcessing: true,
    loop: null,
  };
}

test("lr-9d4b: sub-agent's pendingPermissions entry survives the parent turn's result handler", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_parent";
  var bashToolId = "toolu_014fQLZhyVJuSwfoDnHL7ZHS_sub_bash";

  // 1. Parent turn's assistant message emits the Task tool_use block, then
  //    block_stop marks it as an active backgrounded Task (mirrors real SDK
  //    tool_start/tool_input_delta/block_stop sequence collapsed for brevity).
  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  assert.ok(session.activeTaskToolIds[taskToolId], "Task tool must be tracked as active after block_stop");

  // 2. The backgrounded sub-agent issues its own Bash tool_use. The SDK
  //    delivers this as a subagent_message event carrying parentToolUseId.
  processor.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: taskToolId,
    messageRole: "assistant",
    content: [
      { type: "tool_use", id: bashToolId, name: "Bash", input: { command: "true" } },
    ],
  });
  assert.equal(
    session.subagentToolOwners[bashToolId],
    taskToolId,
    "sub-agent's tool id must be recorded as owned by the parent Task id"
  );

  // 3. sdk-bridge.js's handleCanUseTool registers a pendingPermissions entry
  //    for the sub-agent's Bash call, carrying toolUseId === bashToolId.
  var resolvedWith = null;
  session.pendingPermissions["perm-sub-bash"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-sub-bash",
    toolName: "Bash",
    toolInput: { command: "true" },
    toolUseId: bashToolId,
    decisionReason: "",
  };

  // 4. The PARENT turn ends -- SDK sends 'result' -- while the sub-agent
  //    (and its permission request) is still live.
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.5,
    duration: 1000,
    sessionId: "cli-session-1",
  });

  // The resolver must have survived the result handler's cleanup.
  assert.ok(
    session.pendingPermissions["perm-sub-bash"],
    "sub-agent's pendingPermissions entry must survive the parent result handler"
  );
  assert.equal(resolvedWith, null, "resolver must not have been auto-resolved/dropped");

  // The Task's active-tracking must also survive (still needed to correlate
  // any further sub-agent activity/permissions against this backgrounded run).
  assert.ok(
    session.activeTaskToolIds[taskToolId],
    "backgrounded Task must remain tracked as active across the parent's result"
  );

  // Simulate the operator's later permission_response (project-sessions.js
  // handler): look the entry up by requestId and resolve it.
  var pending = session.pendingPermissions["perm-sub-bash"];
  assert.ok(pending, "permission_response handler must find the pending entry");
  pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });

  assert.deepEqual(
    resolvedWith,
    { behavior: "allow", updatedInput: { command: "true" } },
    "resolving the surviving entry must settle the original canUseTool Promise"
  );
});

test("lr-9d4b: a permission with no live sub-agent owner is still cleared normally on result", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  // A plain top-level (non-sub-agent) permission request: no toolUseId
  // ownership recorded in subagentToolOwners.
  var resolvedWith = null;
  session.pendingPermissions["perm-top-level"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-top-level",
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    toolUseId: "toolu_top_level_bash",
    decisionReason: "",
  };

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.1,
    duration: 500,
    sessionId: "cli-session-2",
  });

  assert.deepEqual(
    session.pendingPermissions,
    {},
    "a top-level (non-sub-agent) pendingPermissions entry must still be cleared on result, preserving prior behavior"
  );
  assert.equal(resolvedWith, null, "clearing does not itself resolve/reject -- unchanged from prior behavior");
});

test("lr-9d4b: a sub-agent permission whose Task already completed (not in activeTaskToolIds) is cleared normally", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_done";
  var bashToolId = "toolu_sub_bash_done";

  // Ownership was recorded earlier, but the Task is no longer active (e.g. a
  // prior result already cleared it, or task_notification fired).
  session.subagentToolOwners = {};
  session.subagentToolOwners[bashToolId] = taskToolId;
  // activeTaskToolIds does NOT contain taskToolId -- simulates a completed sub-agent.

  session.pendingPermissions["perm-stale"] = {
    resolve: function () {},
    requestId: "perm-stale",
    toolName: "Bash",
    toolInput: {},
    toolUseId: bashToolId,
    decisionReason: "",
  };

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.2,
    duration: 200,
    sessionId: "cli-session-3",
  });

  assert.deepEqual(
    session.pendingPermissions,
    {},
    "a sub-agent permission whose owning Task is no longer active must not be preserved (avoids leaking dead entries forever)"
  );
});

// BOBBIE correctness finding (folded into the same lr-9d4b revision as
// PEACHES' changes-requested): task_notification (sub-agent completion)
// used to prune subagentToolOwners for the finished Task unconditionally.
// If the sub-agent's own permission request is STILL pending when its
// task_notification arrives (or arrives shortly after), pruning the
// ownership record makes that entry look like an orphaned top-level
// permission to a later 'result' handler or processQueryStream finally
// block -- which would then clear it and re-orphan the resolver via a
// different timing path than the original bug. Ownership must survive
// until the permission itself actually resolves.
test("lr-9d4b (BOBBIE): task_notification arriving while sub-agent permission still pending preserves ownership, and a later result still keeps the entry", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_notify_race";
  var bashToolId = "toolu_sub_bash_notify_race";

  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  processor.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: taskToolId,
    messageRole: "assistant",
    content: [
      { type: "tool_use", id: bashToolId, name: "Bash", input: { command: "true" } },
    ],
  });

  var resolvedWith = null;
  session.pendingPermissions["perm-notify-race"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-notify-race",
    toolName: "Bash",
    toolInput: { command: "true" },
    toolUseId: bashToolId,
    decisionReason: "",
  };

  // The sub-agent's task_notification (completion) arrives WHILE its own
  // permission request is still pending -- the race BOBBIE flagged.
  processor.processSDKMessage(session, {
    yokeType: "task_notification",
    parentToolId: taskToolId,
    taskId: "task-id-1",
    status: "completed",
  });

  assert.equal(
    session.subagentToolOwners[bashToolId],
    taskToolId,
    "ownership record must survive task_notification while its permission is still pending"
  );
  assert.ok(
    session.pendingPermissions["perm-notify-race"],
    "the pending permission itself is untouched by task_notification"
  );

  // The operator's permission_response can still arrive and resolve normally
  // after task_notification, regardless of what a subsequent result/finally
  // cleanup does.
  var pending = session.pendingPermissions["perm-notify-race"];
  pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
  assert.deepEqual(
    resolvedWith,
    { behavior: "allow", updatedInput: { command: "true" } },
    "resolving after task_notification must still settle the original canUseTool Promise"
  );
});

test("lr-9d4b (BOBBIE): task_notification prunes ownership normally once no pendingPermissions entry references it", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_notify_clean";
  var bashToolId = "toolu_sub_bash_notify_clean";

  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  processor.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: taskToolId,
    messageRole: "assistant",
    content: [
      { type: "tool_use", id: bashToolId, name: "Bash", input: { command: "true" } },
    ],
  });
  // No pendingPermissions entry for bashToolId -- e.g. it already resolved
  // and was deleted by the permission_response handler.

  processor.processSDKMessage(session, {
    yokeType: "task_notification",
    parentToolId: taskToolId,
    taskId: "task-id-2",
    status: "completed",
  });

  assert.equal(
    session.subagentToolOwners[bashToolId],
    undefined,
    "ownership record must still be pruned normally once nothing pending references it (no permanent leak)"
  );
});

// lr-9bcd7b: server activity registry -- extends this file's existing fake
// session/processor harness to drive a full Task lifecycle and assert on the
// derived isProcessing/session_list-broadcast behavior, not just the
// pendingPermissions ownership this file originally covered. Per the task
// spec, this is deliberately NOT the static source-text regex style of
// test/processing-indicator-subagent-lr-255e.test.js -- it drives the real
// message processor end to end.
var sessionActivity = require("../lib/session-activity");

function makeCountingSm() {
  var sm = makeSm();
  sm._broadcastCount = 0;
  var realBroadcast = sm.broadcastSessionList;
  sm.broadcastSessionList = function () {
    sm._broadcastCount++;
    return realBroadcast.apply(this, arguments);
  };
  return sm;
}

test("lr-9bcd7b: a full Task lifecycle acquires an activity token on block_stop and releases it on tool_result, keeping isProcessing true across the parent's result while the Task is live", function () {
  var sm = makeCountingSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_lifecycle";

  // Parent turn dispatches a backgrounded Task.
  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });

  assert.equal(sessionActivity.isSessionActive(session), true, "acquiring the Task token must make the session activity-registry active");
  assert.equal(sm._broadcastCount, 1, "the 0->1 transition must broadcast exactly once");

  // The PARENT turn's SDK 'result' arrives while the Task is still running.
  // lr-255e residual #2 / lr-9bcd7b: this must NOT clear isProcessing, because
  // the activity registry still reports live work for this session.
  // Note: the 'result' handler unconditionally calls sm.broadcastSessionList()
  // once per turn for unrelated reasons (cost/title/etc) regardless of the
  // activity registry -- that pre-existing per-turn broadcast is not what the
  // chattiness invariant governs, so capture the count before/after this call
  // and assert only on the activity-driven delta below, not a fixed total.
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.5,
    duration: 1000,
    sessionId: "cli-session-lifecycle",
  });

  assert.equal(
    session.isProcessing,
    true,
    "isProcessing must stay true across the parent result while a backgrounded Task subagent is still active -- this is the exact picker-dot bug this task fixes"
  );

  var countAfterResult = sm._broadcastCount;

  // The Task subagent's tool_result now arrives -- the terminal drain path.
  processor.processSDKMessage(session, {
    yokeType: "message",
    messageRole: "user",
    content: [
      { type: "tool_result", tool_use_id: taskToolId, content: "subagent finished", is_error: false },
    ],
  });

  assert.equal(sessionActivity.isSessionActive(session), false, "releasing the Task token on tool_result must clear the derived active state");
  assert.equal(
    sm._broadcastCount,
    countAfterResult + 1,
    "exactly one MORE broadcast for the 1->0 transition on tool_result -- not on every intermediate step"
  );
});

test("lr-9bcd7b: task_notification releases the activity token when it is the first terminal path to fire (tool_result never arrives)", function () {
  var sm = makeCountingSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_notify_only";

  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  assert.equal(sessionActivity.isSessionActive(session), true);

  // task_notification (subagent completion) arrives with no separate
  // tool_result for the Task id -- must still release the token.
  processor.processSDKMessage(session, {
    yokeType: "task_notification",
    parentToolId: taskToolId,
    taskId: "task-id-notify-only",
    status: "completed",
  });

  assert.equal(sessionActivity.isSessionActive(session), false, "task_notification alone must be sufficient to release the activity token");
});

test("lr-9bcd7b: tool_result releasing first, then a later task_notification for the same Task id, is idempotent and does not re-broadcast", function () {
  var sm = makeCountingSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_double_release";

  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: taskToolId,
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  processor.processSDKMessage(session, {
    yokeType: "message",
    messageRole: "user",
    content: [
      { type: "tool_result", tool_use_id: taskToolId, content: "done", is_error: false },
    ],
  });

  assert.equal(sessionActivity.isSessionActive(session), false);
  var countAfterFirstRelease = sm._broadcastCount;

  // A later task_notification for the same (already-released) Task id must
  // not report a second 1->0 transition or broadcast again.
  processor.processSDKMessage(session, {
    yokeType: "task_notification",
    parentToolId: taskToolId,
    taskId: "task-id-double-release",
    status: "completed",
  });

  assert.equal(sm._broadcastCount, countAfterFirstRelease, "a redundant release via task_notification after tool_result already released must not broadcast again");
});

test("lr-9bcd7b CHATTINESS INVARIANT: acquiring a second concurrent Task token while one is already active must NOT broadcast again", function () {
  var sm = makeCountingSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  // First Task starts -- this is the only broadcast-worthy transition.
  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 0,
    toolId: "toolu_task_a",
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 0,
  });
  assert.equal(sm._broadcastCount, 1);

  // Second concurrent Task starts while the first is still active. The
  // session was already active (count >= 1), so this acquire must NOT
  // trigger a second broadcast -- the mandatory chattiness mitigation.
  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: 1,
    toolId: "toolu_task_b",
    toolName: "Task",
  });
  processor.processSDKMessage(session, {
    yokeType: "block_stop",
    blockId: 1,
  });

  assert.equal(
    sm._broadcastCount,
    1,
    "acquiring a second token while the session is already active must not trigger a second broadcast (mandatory chattiness mitigation)"
  );
  assert.equal(sessionActivity.getActiveCount(session), 2, "both tokens must still be tracked even though only the first triggered a broadcast");
});
