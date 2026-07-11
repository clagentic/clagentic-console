/**
 * Regression test for lr-f940 (N3, top-3): sm.permissionRequestIndex leaked a
 * requestId -> session.localId entry forever whenever a turn ended while a
 * pendingPermissions entry was cleared by a turn-boundary cleanup pass
 * (sdk-message-processor.js's 'result' handler, or sdk-bridge.js's
 * processQueryStream finally block) instead of the normal permission_response
 * path (project-sessions.js), which is the only place that used to delete
 * both maps together.
 *
 * On the in-process path, an in-flight opts.signal "abort" listener also
 * deletes both maps -- but the WORKER path (yoke/adapters/claude.js) passes a
 * fake `signal: { addEventListener: function() {} }` to canUseTool, so that
 * cleanup path never fires there. For worker-path sessions, the turn-boundary
 * cleanup sweep added here is the ONLY place the index entry is ever removed.
 *
 * Fix: lib/sdk-permission-ownership.js exports sweepClearedPermissionIndex(),
 * called from both cleanup sites right before session.pendingPermissions is
 * reassigned to keptPermissions. It deletes sm.permissionRequestIndex[id] for
 * every entry NOT preserved, and resolves the dropped resolver with a deny
 * decision so an abandoned canUseTool Promise does not hang forever either.
 *
 * This test drives the real sdk-message-processor.js 'result' handler (the
 * same code path test/sdk-message-processor-subagent-permission-lr-9d4b.test.js
 * exercises) with a session manager stub that includes permissionRequestIndex,
 * and asserts the index is swept and the dropped resolver settles.
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
    permissionRequestIndex: {},
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
    localId: 42,
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

test("lr-f940: a top-level permission dropped by the result handler is swept from permissionRequestIndex and its resolver is settled", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var resolvedWith = null;
  sm.permissionRequestIndex["perm-top-level"] = session.localId;
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
    sessionId: "cli-session-lrf940-a",
  });

  assert.deepEqual(session.pendingPermissions, {}, "the dropped entry is removed from pendingPermissions as before");
  assert.equal(
    sm.permissionRequestIndex["perm-top-level"],
    undefined,
    "the matching permissionRequestIndex entry must be swept, not leaked"
  );
  assert.deepEqual(
    resolvedWith,
    { behavior: "deny", message: "Session turn ended" },
    "the orphaned resolver must be settled with a deny decision instead of hanging forever"
  );
});

test("lr-f940: a sub-agent permission preserved across the result handler keeps its permissionRequestIndex entry", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_parent_f940";
  var bashToolId = "toolu_sub_bash_f940";

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
  sm.permissionRequestIndex["perm-sub-bash-f940"] = session.localId;
  session.pendingPermissions["perm-sub-bash-f940"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-sub-bash-f940",
    toolName: "Bash",
    toolInput: { command: "true" },
    toolUseId: bashToolId,
    decisionReason: "",
  };

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.5,
    duration: 1000,
    sessionId: "cli-session-lrf940-b",
  });

  assert.ok(
    session.pendingPermissions["perm-sub-bash-f940"],
    "sub-agent's pendingPermissions entry must still survive (lr-9d4b behavior unchanged)"
  );
  assert.equal(
    sm.permissionRequestIndex["perm-sub-bash-f940"],
    session.localId,
    "a preserved (not dropped) entry's permissionRequestIndex mapping must NOT be swept"
  );
  assert.equal(resolvedWith, null, "a preserved entry's resolver must not be auto-resolved");
});

test("lr-f940: sweepClearedPermissionIndex is a no-op (including no resolve side effect) when sm has no permissionRequestIndex", function () {
  // Production sm always initializes permissionRequestIndex (lib/sessions.js)
  // — this test documents that a caller without one (e.g. a minimal test
  // double, like the pre-existing lr-9d4b fixture in
  // sdk-message-processor-subagent-permission-lr-9d4b.test.js) sees no new
  // side effect at all from this sweep, preserving its pre-lr-f940 behavior
  // exactly rather than gaining a surprise resolve() it never asked for.
  var sm = makeSm();
  delete sm.permissionRequestIndex;
  var processor = makeProcessor(sm);
  var session = makeSession();

  var resolvedWith = null;
  session.pendingPermissions["perm-no-index"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-no-index",
    toolName: "Bash",
    toolInput: {},
    toolUseId: "toolu_no_index",
    decisionReason: "",
  };

  assert.doesNotThrow(function () {
    processor.processSDKMessage(session, {
      yokeType: "result",
      cost: 0.1,
      duration: 100,
      sessionId: "cli-session-lrf940-c",
    });
  });
  assert.deepEqual(session.pendingPermissions, {}, "the entry is still cleared from pendingPermissions as before (unrelated to the sweep)");
  assert.equal(
    resolvedWith,
    null,
    "no permissionRequestIndex means the sweep is a full no-op — the resolver is not auto-settled"
  );
});
