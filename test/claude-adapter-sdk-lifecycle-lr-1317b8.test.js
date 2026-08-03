// Regression tests for lr-1317b8: four proven divergences between the
// Claude adapter (lib/yoke/adapters/claude.js) and the SDK's own type
// contract (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts), which
// together kept the 3-dot activity indicator from surviving a live
// subagent run. See the task body for full citations.
//
// These are REAL behavioral tests, not source-text regex checks: the
// adapter's flattenEvent is a pure function over message objects with no
// DOM dependency, so we construct synthetic SDK message objects (matching
// the exact shapes documented in sdk.d.ts) and assert on flattenEvent's
// output. This is deliberately NOT the pattern used by
// test/processing-indicator-subagent-lr-255e.test.js (static source-text
// matching) — that pattern is honestly labeled weak there and did not
// catch any of the four defects this task fixes.
//
// Defect 1 (tool_progress): SDKToolProgressMessage (sdk.d.ts:4115-4124) has
//   no `content` field. The adapter used to read raw.content, which is
//   always undefined, so `text` was always "". Fixed to derive text from
//   tool_name + elapsed_time_seconds.
// Defect 2 (app-messages.js delta clear-site): covered by a static check
//   here since app-messages.js is a DOM-heavy ESM module with no jsdom
//   harness in this project (same constraint noted in lr-255e's test file)
//   — but scoped tightly to the exact guard, not a broad regex.
// Defect 3 (task_notification unreachable): the SDK emits this as
//   {type:'system', subtype:'task_notification'} (sdk.d.ts:4020-4036), not
//   a top-level message type. Fixed by moving the match into the
//   system-subtype branch.
// Defect 4 (task_updated never emitted + casing bug): the SDK emits
//   {type:'system', subtype:'task_updated'} (sdk.d.ts:4084-4101). No
//   adapter branch produced yokeType:'task_updated' before this fix, and
//   sdk-message-processor.js read parsed.task_id (snake_case) instead of
//   parsed.taskId.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var flattenEvent = claudeAdapter._test_flattenEvent;

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

test("_test_flattenEvent seam is exported", function() {
  assert.strictEqual(typeof flattenEvent, "function",
    "_test_flattenEvent must be exported from lib/yoke/adapters/claude.js");
});

// ---------------------------------------------------------------------------
// Test harness (mirrors test/diagnostic-routing-lr-0868.test.js)
// ---------------------------------------------------------------------------

function makeCtx() {
  var sent = [];
  var sm = {
    skillMeta: [],
    workflowMeta: [],
    skillNames: [],
    slashCommands: null,
    currentModel: null,
    _savedDefaultModel: null,
    sendAndRecord: function(session, obj) { sent.push(obj); },
    sendToSession: function(session, obj) { sent.push(obj); },
    saveSessionFile: function() {},
    broadcastSessionList: function() {},
    modelsByVendor: {},
    availableModels: [],
    availableVendors: [],
    installedVendors: [],
  };

  var processor = attachMessageProcessor({
    sm: sm,
    send: function(obj) { sent.push(obj); },
    slug: "test-slug",
    cwd: "/tmp",
    pushModule: null,
    getNotificationsModule: function() { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function() {},
    onTurnDone: null,
    onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function() { return []; },
    mergeSkills: function() { return []; },
    discoverWorkflows: function() { return []; },
    discoverSkillsWithMeta: function() { return []; },
    mergeSkillsWithMeta: function() { return []; },
    getSDK: null,
  });

  return { processor: processor, sm: sm, sent: sent };
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
    taskIdMap: { "toolu_1": "task_1" },
    streamedText: false,
    responsePreview: "",
    isProcessing: false,
    loop: null,
  };
}

// ---------------------------------------------------------------------------
// Defect 1 — SDKToolProgressMessage has no `content` field
// ---------------------------------------------------------------------------

test("Defect 1: tool_progress no longer reads a nonexistent content field", function() {
  var raw = {
    type: "tool_progress",
    tool_use_id: "toolu_abc",
    tool_name: "Grep",
    parent_tool_use_id: "toolu_parent",
    elapsed_time_seconds: 4,
    task_id: "task_1",
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.yokeType, "tool_progress");
  assert.notStrictEqual(result.text, "",
    "text must not be empty for a tool_progress event with tool_name+elapsed_time_seconds " +
    "(the falsy '' used to hit setActivity('') and destroy the indicator)");
  assert.ok(result.text.indexOf("Grep") !== -1,
    "text should be derived from tool_name, not the nonexistent content field");
});

test("Defect 1: tool_progress carries parity fields (toolName, elapsedTimeSeconds, taskId)", function() {
  var raw = {
    type: "tool_progress",
    tool_use_id: "toolu_abc",
    tool_name: "Bash",
    parent_tool_use_id: "toolu_parent",
    elapsed_time_seconds: 12,
    task_id: "task_1",
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.toolName, "Bash");
  assert.strictEqual(result.elapsedTimeSeconds, 12);
  assert.strictEqual(result.taskId, "task_1");
  assert.strictEqual(result.parentToolId, "toolu_parent");
});

test("Defect 1: tool_progress with no tool_name still returns a defined (non-crashing) text", function() {
  var raw = {
    type: "tool_progress",
    tool_use_id: "toolu_abc",
    parent_tool_use_id: "toolu_parent",
    elapsed_time_seconds: 1,
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(typeof result.text, "string");
});

// ---------------------------------------------------------------------------
// Defect 3 — task_notification is a system subtype, not a top-level type
// ---------------------------------------------------------------------------

test("Defect 3: flattenEvent maps {type:'system', subtype:'task_notification'} to yokeType:'task_notification'", function() {
  var raw = {
    type: "system",
    subtype: "task_notification",
    task_id: "task_1",
    tool_use_id: "toolu_parent",
    status: "completed",
    output_file: "/tmp/out.json",
    summary: "Did the thing",
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.yokeType, "task_notification",
    "system/task_notification subtype must not fall through to the generic system catch-all");
  assert.strictEqual(result.taskId, "task_1");
  assert.strictEqual(result.parentToolId, "toolu_parent");
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.summary, "Did the thing");
});

test("Defect 3: a top-level {type:'task_notification'} (never emitted by the real SDK) does NOT match the dead branch", function() {
  // Regression guard for the removed dead code: no top-level raw.type check
  // should still exist for task_notification. It must now fall to 'unknown'
  // since the real SDK never sends this shape.
  var raw = { type: "task_notification", task_id: "task_1" };
  var result = flattenEvent(raw);
  assert.notStrictEqual(result.yokeType, "task_notification",
    "the dead top-level task_notification branch must be removed, not merely shadowed");
});

test("Defect 3: task_notification carries skip_transcript parity field as skipTranscript", function() {
  var raw = {
    type: "system",
    subtype: "task_notification",
    task_id: "task_1",
    tool_use_id: "toolu_parent",
    status: "completed",
    output_file: "/tmp/out.json",
    summary: "",
    skip_transcript: true,
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.skipTranscript, true);
});

test("Defect 3 end-to-end: task_notification drains taskIdMap and emits subagent_done via the processor", function() {
  var ctx = makeCtx();
  var session = makeSession();
  var raw = {
    type: "system",
    subtype: "task_notification",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    status: "completed",
    output_file: "/tmp/out.json",
    summary: "done",
    uuid: "u1",
    session_id: "s1",
  };
  var flattened = flattenEvent(raw);
  ctx.processor.processSDKMessage(session, flattened);

  var doneMsgs = ctx.sent.filter(function(m) { return m.type === "subagent_done"; });
  assert.strictEqual(doneMsgs.length, 1,
    "the designed drain path (subagent_done) must fire now that task_notification reaches the processor");
  assert.strictEqual(doneMsgs[0].parentToolId, "toolu_1");
  assert.strictEqual(session.taskIdMap["toolu_1"], undefined,
    "taskIdMap entry must be drained on task_notification");
});

// ---------------------------------------------------------------------------
// Defect 4 — task_updated was branched on but never emitted, plus casing bug
// ---------------------------------------------------------------------------

test("Defect 4: flattenEvent maps {type:'system', subtype:'task_updated'} to yokeType:'task_updated'", function() {
  var raw = {
    type: "system",
    subtype: "task_updated",
    task_id: "task_1",
    patch: { status: "failed", error: "boom" },
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.yokeType, "task_updated",
    "no adapter branch produced this yokeType before the fix");
  assert.strictEqual(result.taskId, "task_1");
  assert.deepStrictEqual(result.patch, { status: "failed", error: "boom" });
});

test("Defect 4 end-to-end: task_updated reaches the processor via parsed.taskId (not parsed.task_id)", function() {
  var ctx = makeCtx();
  var session = makeSession();
  var raw = {
    type: "system",
    subtype: "task_updated",
    task_id: "task_1",
    patch: { status: "killed" },
    uuid: "u1",
    session_id: "s1",
  };
  var flattened = flattenEvent(raw);
  assert.strictEqual(flattened.taskId, "task_1");
  assert.strictEqual(flattened.task_id, undefined,
    "flattenEvent output uses camelCase taskId, not snake_case task_id");

  ctx.processor.processSDKMessage(session, flattened);

  var updatedMsgs = ctx.sent.filter(function(m) { return m.type === "task_updated"; });
  assert.strictEqual(updatedMsgs.length, 1,
    "task_updated must resolve parentToolId via session.taskIdMap keyed by parsed.taskId " +
    "(the casing bug at sdk-message-processor.js:702 read parsed.task_id, which is always " +
    "undefined on the flattened envelope, so parentId was never found and this never fired)");
  assert.strictEqual(updatedMsgs[0].parentToolId, "toolu_1");
  assert.deepStrictEqual(updatedMsgs[0].patch, { status: "killed" });
});

// ---------------------------------------------------------------------------
// Parity fields — task_started / task_progress (subagent_type etc.)
// ---------------------------------------------------------------------------

test("Parity: task_started carries subagentType, taskType, workflowName, skipTranscript", function() {
  var raw = {
    type: "system",
    subtype: "task_started",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    description: "Researching",
    subagent_type: "prax",
    task_type: "local_workflow",
    workflow_name: "spec",
    skip_transcript: true,
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.yokeType, "task_started");
  assert.strictEqual(result.subagentType, "prax",
    "subagent_type is HIGHEST VALUE per the task — the data behind 'PRAX researching...'");
  assert.strictEqual(result.taskType, "local_workflow");
  assert.strictEqual(result.workflowName, "spec");
  assert.strictEqual(result.skipTranscript, true);
});

test("Parity: task_started with no optional fields does not crash and defaults sanely", function() {
  var raw = {
    type: "system",
    subtype: "task_started",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    description: "Doing work",
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.subagentType, null);
  assert.strictEqual(result.taskType, null);
  assert.strictEqual(result.workflowName, null);
  assert.strictEqual(result.skipTranscript, false);
});

test("Parity: task_progress carries subagentType", function() {
  var raw = {
    type: "system",
    subtype: "task_progress",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    description: "Working",
    subagent_type: "prax",
    usage: { total_tokens: 100, tool_uses: 2, duration_ms: 5000 },
    uuid: "u1",
    session_id: "s1",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.subagentType, "prax");
});

// ---------------------------------------------------------------------------
// Defect 2 — ungated delta clear-site in app-messages.js
// ---------------------------------------------------------------------------
//
// app-messages.js is a DOM-heavy ESM frontend module with no jsdom harness in
// this project (same constraint documented in
// test/processing-indicator-subagent-lr-255e.test.js). Scoped tightly to the
// exact guard rather than a broad regex: assert the delta handler's body
// contains the hasActiveSubagents() guard around its setActivity(null) call.

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

// Extracts the body of a `<name>: function (msg) { ... }` handler by brace
// counting from the opening brace, rather than a regex that has to guess
// where the handler ends — robust to nested if-blocks inside the handler
// (like the guard this test is checking for).
function extractHandlerBody(src, handlerName) {
  // Anchor on a preceding boundary so "delta:" doesn't match inside
  // "thinking_delta:" (a real handler name in this file) as a substring.
  var re = new RegExp("[{,\\s]" + handlerName + ":\\s*function\\s*\\(msg\\)\\s*\\{");
  var m = re.exec(src);
  if (!m) return null;
  var startIdx = m.index;
  var braceStart = src.indexOf("{", startIdx);
  var depth = 0;
  for (var i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return null;
}

test("Defect 2: app-messages.js delta handler guards setActivity(null) with hasActiveSubagents()", function() {
  var src = readMod("lib/public/modules/app-messages.js");
  var deltaBody = extractHandlerBody(src, "delta");
  assert.ok(deltaBody, "delta handler must be present in app-messages.js");
  assert.ok(deltaBody.indexOf("hasActiveSubagents()") !== -1,
    "delta handler must consult hasActiveSubagents() before clearing the indicator");
  // The setActivity(null) call itself must appear inside the guarded branch,
  // not unconditionally before/after it.
  var guardIdx = deltaBody.indexOf("if (!hasActiveSubagents())");
  var clearIdx = deltaBody.indexOf("setActivity(null)");
  assert.ok(guardIdx !== -1 && clearIdx !== -1 && clearIdx > guardIdx,
    "setActivity(null) must be gated behind the hasActiveSubagents() check, not called unconditionally");
});
