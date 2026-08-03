/**
 * Behavioral coverage for lr-c56476: Codex activity-registry parity.
 *
 * Operator ruling (recorded on lr-c56476 and the governing epic lr-a6a449):
 * parity means the indicator behaves IDENTICALLY for equivalent activity. It
 * does NOT mean inventing subagent semantics for Codex -- lib/yoke/adapters/
 * codex.js has no subagent/Task concept (grep for agent/subagent turns up
 * only assistant-text fields, never a Task lifecycle). This suite therefore
 * never constructs a task_started/task_progress/task_notification/subagent_*
 * event for a Codex session -- doing so would be the exact failure mode the
 * ruling exists to prevent.
 *
 * What IS under test: lib/sdk-message-processor.js acquires an activity
 * token (lib/session-activity.js, from lr-9bcd7b) on tool_start/
 * thinking_start for a session with vendor === "codex", and releases it on
 * tool_result (per-token) or result (catch-all for every still-live
 * Codex-sourced token, since Codex's own thinking_stop event is not
 * otherwise dispatched by this shared processor -- see the release-catch-all
 * comment in sdk-message-processor.js for why that matters).
 *
 * Per this task's own instruction, this is real behavioral coverage --
 * constructs inputs, asserts on outputs -- mirroring the style of
 * test/session-activity-lr-9bcd7b.test.js and the lr-9bcd7b integration
 * tests appended to test/sdk-message-processor-subagent-permission-lr-9d4b.
 * test.js. It deliberately does NOT use the static source-text regex style
 * of test/processing-indicator-subagent-lr-255e.test.js, which is explicitly
 * labeled weak on its own admission and caught none of the defects it was
 * meant to.
 *
 * Covers:
 *   - acquire on tool_start -> session activity-registry active
 *   - release on tool_result -> inactive (single tool, happy path)
 *   - acquire on thinking_start, release via the result catch-all (since
 *     Codex's own thinking_stop is not dispatched by this processor)
 *   - abnormal termination: a turn ending in error_during_execution still
 *     drains every outstanding Codex token (the only backstop short of the
 *     next startQuery's generation bump, since Codex has no
 *     task_notification-equivalent second drain path)
 *   - concurrent tool + thinking tokens both drain on a single result event
 *   - CHATTINESS INVARIANT: a second concurrent Codex token acquired while
 *     the session is already active must not trigger a second broadcast
 *   - Claude-vendor sessions are completely unaffected: ordinary tool_start/
 *     thinking_start for vendor !== "codex" must NOT acquire a token (parity
 *     ruling: only Codex needs this shape, since Claude already has
 *     turn-wide isProcessing coverage for ordinary tool activity)
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var sessionActivity = require("../lib/session-activity");

function makeSm() {
  return {
    skillMeta: [],
    workflowMeta: [],
    skillNames: [],
    slashCommands: null,
    currentModel: null,
    _savedDefaultModel: null,
    _broadcastCount: 0,
    sendAndRecord: function (session, obj) {
      if (!session.history) session.history = [];
      session.history.push(obj);
    },
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {
      this._broadcastCount++;
    },
    modelsByVendor: {},
    availableModels: [],
    availableVendors: [],
    installedVendors: [],
  };
}

function makeProcessor(sm, vendor) {
  return attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test-slug",
    cwd: "/tmp",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: vendor || "codex" },
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

function makeSession(vendor) {
  return {
    localId: "s1",
    cliSessionId: null,
    vendor: vendor || "codex",
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

test("lr-c56476: tool_start acquires a Codex activity token; tool_result releases it", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: "blk_1",
    toolId: "codex-tool-1",
    toolName: "Bash",
  });

  assert.equal(sessionActivity.isSessionActive(session), true, "tool_start must acquire a token for a Codex session");
  assert.equal(sm._broadcastCount, 1, "the 0->1 transition must broadcast exactly once");

  processor.processSDKMessage(session, {
    yokeType: "tool_result",
    toolId: "codex-tool-1",
    content: "ok",
    isError: false,
  });

  assert.equal(sessionActivity.isSessionActive(session), false, "tool_result must release the matching token");
  assert.equal(sm._broadcastCount, 2, "the 1->0 transition must broadcast exactly once more");
});

test("lr-c56476: thinking_start acquires a token; the result catch-all releases it (Codex's own thinking_stop is not dispatched by this processor)", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, {
    yokeType: "thinking_start",
    blockId: "blk_2",
  });

  assert.equal(sessionActivity.isSessionActive(session), true, "thinking_start must acquire a token for a Codex session");

  // Codex emits a top-level thinking_stop event for a completed reasoning
  // item (lib/yoke/adapters/codex.js flattenEvent), but this shared
  // processor has no dispatch branch for a bare thinking_stop yokeType --
  // it must not be relied on to release the token. Confirm it is a no-op.
  processor.processSDKMessage(session, { yokeType: "thinking_stop", blockId: "blk_2" });
  assert.equal(sessionActivity.isSessionActive(session), true, "a bare thinking_stop event (undispatched by this processor) must not be required to release the token");

  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    duration: null,
    sessionId: "codex-thread-1",
  });

  assert.equal(sessionActivity.isSessionActive(session), false, "the result catch-all must release every still-live Codex-sourced token, including a thinking token with no dedicated release event");
});

test("lr-c56476: multiple concurrent tool + thinking tokens all drain on a single result event", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "codex-tool-a", toolName: "Bash" });
  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_2", toolId: "codex-tool-b", toolName: "Edit" });
  processor.processSDKMessage(session, { yokeType: "thinking_start", blockId: "blk_3" });

  assert.equal(sessionActivity.getActiveCount(session), 3, "all three concurrently-acquired tokens must be tracked");
  assert.equal(sessionActivity.isSessionActive(session), true);

  processor.processSDKMessage(session, { yokeType: "result", cost: null, duration: null, sessionId: "codex-thread-2" });

  assert.equal(sessionActivity.getActiveCount(session), 0, "the result catch-all must release every outstanding token, not just the most recent one");
  assert.equal(sessionActivity.isSessionActive(session), false);
});

test("lr-c56476 ABNORMAL TERMINATION: a turn ending in error_during_execution still drains every outstanding Codex token", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "codex-tool-err", toolName: "Bash" });
  assert.equal(sessionActivity.isSessionActive(session), true);

  // The SDK execution-error subtype takes an early return inside the
  // 'result' handler (see sdk-message-processor.js) -- the Codex
  // release-catch-all must run BEFORE that early return, not after it.
  processor.processSDKMessage(session, {
    yokeType: "result",
    subtype: "error_during_execution",
    errors: ["boom"],
    cost: 0,
  });

  assert.equal(sessionActivity.isSessionActive(session), false, "an execution-error result must still drain outstanding Codex tokens -- a stuck-on indicator is worse than no indicator");
  assert.equal(session.isProcessing, false, "isProcessing must be derived from the now-empty registry, not left stuck true");
});

test("lr-c56476 CHATTINESS INVARIANT: a second concurrent Codex tool token must not trigger a second broadcast", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "codex-tool-a", toolName: "Bash" });
  assert.equal(sm._broadcastCount, 1, "the first (0->1) acquire is the only one allowed to broadcast");

  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_2", toolId: "codex-tool-b", toolName: "Edit" });
  assert.equal(sm._broadcastCount, 1, "acquiring a second token while the session is already active must not trigger a second broadcast");
  assert.equal(sessionActivity.getActiveCount(session), 2, "both tokens must still be tracked even though only the first triggered a broadcast");

  // Releasing one of two concurrent tokens must not flip the derived
  // boolean or broadcast until the LAST one releases.
  processor.processSDKMessage(session, { yokeType: "tool_result", toolId: "codex-tool-a", content: "done", isError: false });
  assert.equal(sm._broadcastCount, 1, "releasing one of two live tokens must not broadcast");
  assert.equal(sessionActivity.isSessionActive(session), true);

  processor.processSDKMessage(session, { yokeType: "tool_result", toolId: "codex-tool-b", content: "done", isError: false });
  assert.equal(sm._broadcastCount, 2, "the LAST live token releasing must broadcast exactly once");
  assert.equal(sessionActivity.isSessionActive(session), false);
});

test("lr-c56476 PARITY BOUNDARY: a Claude-vendor session's ordinary tool_start/thinking_start must NOT acquire an activity token", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm, "claude");
  var session = makeSession("claude");

  // Ordinary (non-Task) tool activity for Claude already has turn-wide
  // isProcessing coverage set by the caller before startQuery -- acquiring a
  // token here as well would change Claude's existing chattiness profile,
  // which is explicitly out of scope for this task (scope: codex.js/Codex
  // parity only).
  processor.processSDKMessage(session, {
    yokeType: "tool_start",
    blockId: "blk_1",
    toolId: "claude-tool-1",
    toolName: "Bash",
  });
  assert.equal(sessionActivity.isSessionActive(session), false, "an ordinary (non-Task) tool_start for a Claude session must not acquire a token");

  processor.processSDKMessage(session, { yokeType: "thinking_start", blockId: "blk_2" });
  assert.equal(sessionActivity.isSessionActive(session), false, "thinking_start for a Claude session must not acquire a token");

  assert.equal(sm._broadcastCount, 0, "no activity-registry broadcast should occur at all for ordinary Claude tool/thinking activity");
});

test("lr-c56476: no fabricated subagent/Task lifecycle for Codex -- a Codex session never populates activeTaskToolIds or taskIdMap via this wiring", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession();

  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "codex-tool-1", toolName: "Bash" });
  processor.processSDKMessage(session, { yokeType: "thinking_start", blockId: "blk_2" });
  processor.processSDKMessage(session, { yokeType: "tool_result", toolId: "codex-tool-1", content: "ok", isError: false });
  processor.processSDKMessage(session, { yokeType: "result", cost: null, duration: null, sessionId: "codex-thread-3" });

  assert.deepEqual(session.activeTaskToolIds, {}, "Codex activity acquisition must never populate the Task-only activeTaskToolIds bookkeeping");
  assert.deepEqual(session.taskIdMap, {}, "Codex activity acquisition must never populate the Task-only taskIdMap bookkeeping");
});
