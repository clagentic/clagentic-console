/**
 * Regression test for lr-b75006: a backgrounded sub-agent's still-pending
 * permission is force-denied and purged when the PARENT Task's
 * `task_notification` (completion) arrives before the operator answers, and
 * a later turn-boundary cleanup (`result` / processQueryStream's finally)
 * runs afterward.
 *
 * THIRD INSTANCE OF THIS CLASS (lr-8b2e, lr-f969dc, lr-9d4b). This is an
 * incomplete application of lr-9d4b's own fix, not a fresh independent bug:
 * lr-9d4b added an explicit exception so `task_notification` would NOT prune
 * `session.subagentToolOwners` for a tool id that still has a live
 * `pendingPermissions` entry (see the existing BOBBIE test in
 * sdk-message-processor-subagent-permission-lr-9d4b.test.js). But
 * `task_notification` ALSO deletes `session.activeTaskToolIds[parentId]`
 * unconditionally, a few lines before that guard, and nothing mirrored the
 * same exception onto it.
 *
 * `lib/sdk-permission-ownership.js`'s `partitionSubagentOwnedPermissions` --
 * the function both `result` and `processQueryStream`'s `finally` rely on to
 * decide whether to preserve a sub-agent-owned pending permission across
 * turn-boundary cleanup -- requires BOTH halves of
 * `owningTaskId && activeTaskToolIds[owningTaskId]` to be true. Guarding only
 * `subagentToolOwners` (which supplies `owningTaskId`) while leaving
 * `activeTaskToolIds` unconditionally cleared meant the second half of that
 * check was false by the time `result` ran, so the entry was NOT preserved:
 * it was force-resolved to `deny` and purged from both
 * `session.pendingPermissions` and `sm.permissionRequestIndex` by
 * `sweepClearedPermissionIndex`, while the browser's permission card was
 * never told to update and stayed rendered as if still awaiting an answer.
 *
 * Every subsequent click (Allow Once / Allow for Session / Deny) on that
 * stale card then hits `project-sessions.js`'s
 * `if (!pending) return true;` no-op -- explaining why NONE of the three
 * buttons "stuck": the underlying resolver was already gone by the time any
 * of them were clicked.
 *
 * This test drives the exact sequence end-to-end through the real message
 * processor (task_notification, THEN a later result) and asserts the
 * permission survives both -- the layer this bug's absence of coverage let
 * slip through twice already. It fails on pre-fix code (task_notification's
 * unconditional activeTaskToolIds delete) and passes once
 * activeTaskToolIds[parentId] is deferred using the same live-ownership
 * check as subagentToolOwners.
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

test("lr-b75006: a sub-agent permission still pending survives BOTH task_notification AND a later result, end to end", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  var taskToolId = "toolu_task_b75006";
  var bashToolId = "toolu_sub_bash_b75006";

  // Parent turn dispatches a backgrounded Task sub-agent.
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
  assert.ok(session.activeTaskToolIds[taskToolId], "Task must be tracked active after block_stop");

  // The sub-agent issues its own Bash tool_use (e.g. `lore task comment ...`).
  processor.processSDKMessage(session, {
    yokeType: "subagent_message",
    parentToolUseId: taskToolId,
    messageRole: "assistant",
    content: [
      { type: "tool_use", id: bashToolId, name: "Bash", input: { command: "lore task comment lr-6ab846 --comment ..." } },
    ],
  });

  // sdk-bridge.js's handleCanUseTool registers the pending permission for
  // that Bash call -- this is the card the operator sees and clicks.
  var resolvedWith = null;
  session.pendingPermissions["perm-b75006"] = {
    resolve: function (result) { resolvedWith = result; },
    requestId: "perm-b75006",
    toolName: "Bash",
    toolInput: { command: "lore task comment lr-6ab846 --comment ..." },
    toolUseId: bashToolId,
    decisionReason: "",
  };

  // The sub-agent's Task reports completion (task_notification) WHILE its
  // own nested permission is still awaiting the operator's click -- the
  // exact race this task is about.
  processor.processSDKMessage(session, {
    yokeType: "task_notification",
    parentToolId: taskToolId,
    taskId: "task-id-b75006",
    status: "completed",
  });

  // Both ownership records that partitionSubagentOwnedPermissions depends on
  // must survive task_notification -- not just subagentToolOwners (the half
  // lr-9d4b already guarded) but ALSO activeTaskToolIds (the half that was
  // still being cleared unconditionally).
  assert.equal(
    session.subagentToolOwners[bashToolId],
    taskToolId,
    "subagentToolOwners must survive task_notification while the permission is pending"
  );
  assert.ok(
    session.activeTaskToolIds[taskToolId],
    "activeTaskToolIds must ALSO survive task_notification while the permission is pending -- " +
    "this is the half of the ownership check lr-9d4b's guard missed"
  );
  assert.ok(
    session.pendingPermissions["perm-b75006"],
    "the pending permission itself must be untouched by task_notification"
  );

  // Some time later, the PARENT turn's SDK 'result' arrives (a normal event
  // in crew-manifest orchestration -- the parent turn wraps up while its
  // backgrounded sub-agent's last action is still awaiting operator review).
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.3,
    duration: 1500,
    sessionId: "cli-session-b75006",
  });

  // THE ACTUAL BUG: pre-fix, activeTaskToolIds[taskToolId] was already gone
  // (deleted unconditionally by task_notification above), so
  // partitionSubagentOwnedPermissions's `owningTaskId && activeTaskToolIds[owningTaskId]`
  // check failed even though subagentToolOwners still pointed at a live
  // Task id. The entry was dropped, force-resolved to deny by
  // sweepClearedPermissionIndex, and purged -- while the browser's card
  // stayed rendered. This assertion is what a passing pre-fix test run would
  // have caught and did not.
  assert.ok(
    session.pendingPermissions["perm-b75006"],
    "the sub-agent's permission must survive the LATER result cleanup too -- " +
    "this is the reproduction of lr-b75006's 'clicks don't stick' symptom"
  );
  assert.equal(
    resolvedWith,
    null,
    "the resolver must not have been silently force-denied by turn-boundary cleanup"
  );

  // Now the operator's actual click (permission_response handler in
  // project-sessions.js) can still find and resolve it.
  var pending = session.pendingPermissions["perm-b75006"];
  assert.ok(pending, "permission_response handler must find a live entry to resolve");
  pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });

  assert.deepEqual(
    resolvedWith,
    { behavior: "allow", updatedInput: { command: "lore task comment lr-6ab846 --comment ..." } },
    "resolving the surviving entry must settle the original canUseTool Promise -- Allow actually sticks"
  );
});

test("lr-b75006: Deny still works normally for an ordinary (non-subagent) permission after a result cleanup", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  // Sanity guard: this fix must not change behavior for the ordinary
  // top-level case (no Task/sub-agent involved at all) -- a plain permission
  // still pending at 'result' time is unusual but if it happens it must
  // still be cleared exactly as before (lr-9d4b's existing top-level test
  // covers this too; repeated narrowly here as a same-file cross-check
  // against this fix's new liveOwnedToolIds computation).
  session.pendingPermissions["perm-top-level-b75006"] = {
    resolve: function () {},
    requestId: "perm-top-level-b75006",
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    toolUseId: "toolu_top_level_b75006",
    decisionReason: "",
  };

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0.1,
    duration: 500,
    sessionId: "cli-session-b75006-top-level",
  });

  assert.deepEqual(
    session.pendingPermissions,
    {},
    "a plain top-level permission with no sub-agent ownership must still be cleared normally on result"
  );
});
