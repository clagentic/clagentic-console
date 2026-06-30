// Tests for epic lr-1a52 stage 3/5 (lr-0868): diagnostic event routing.
//
// Two hops are covered:
//   Hop A — flattenEvent() in lib/yoke/adapters/claude.js
//            Raw event { type:'diagnostic', severity, source, message } must
//            produce { yokeType:'diagnostic', severity, source, message }.
//            Must NOT fall to the unknown catch-all (lr-0868 requirement a).
//
//   Hop B — attachMessageProcessor() in lib/sdk-message-processor.js
//            A flattened event with yokeType:'diagnostic' must produce a
//            distinct frontend message { type:'diagnostic', severity, source, message }
//            and must NOT produce a { type:'error' } (lr-0868 requirement b).
//
// End-to-end path coverage: an 'Unknown hook event' style CLI stderr line now
// travels capture (stage 2/5) → flatten('diagnostic') → processor →
// { type:'diagnostic', severity:'warning', source:'hook', message:... }.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Import seams under test
// ---------------------------------------------------------------------------

// flattenEvent is an internal function — exported via the module's test surface
// by accessing the real module. Because it is not directly exported we call it
// through the createQueryHandle path: we re-implement the tiny harness the
// existing yoke-robustness tests use (the function is not an exported seam).
//
// Strategy: require the module and reach flattenEvent via the IPC dispatch path
// in createWorkerQueryHandle. Because that path is hard to unit-test in isolation
// without spawning a worker, we instead directly call flattenEvent by extracting
// it via a lightweight test-seam. Since flattenEvent is module-private, we
// re-export it for tests by adding it to the existing module exports in a
// backwards-compatible way — BUT that is a landed change (stage 1/2). Instead,
// the simplest correct approach is to shadow-require the private function by
// replicating the file require and extracting via a known require-cache key.
//
// Actually the cleanest pattern this codebase uses (see yoke-robustness.test.js
// tests 7a and 7c) is to export dedicated _test_* seams from adapter modules.
// flattenEvent is not yet exported as a seam, so we add it now to avoid an
// integration test that requires spawning a worker process. This is the minimal
// change called for by the task (lr-0868).
//
// NOTE: the _test_flattenEvent export must be added to lib/yoke/adapters/claude.js
// alongside these tests — see the assertion below.

var claudeAdapter = require("../lib/yoke/adapters/claude");

// Guard: ensures the seam is present (if flattenEvent was not exported, every
// test below will correctly fail with a meaningful message).
var flattenEvent = claudeAdapter._test_flattenEvent;

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

// ---------------------------------------------------------------------------
// Minimal test helpers (mirrored from sdk-message-processor-slash.test.js)
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
    // sendAndRecord must push to sent[] so tests can assert on processor output.
    // The real sm.sendAndRecord appends to session.history and broadcasts;
    // for these unit tests only the sent[] capture matters.
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
    taskIdMap: {},
    streamedText: false,
    responsePreview: "",
    isProcessing: false,
    loop: null,
  };
}

// ---------------------------------------------------------------------------
// Hop A — flattenEvent(): raw diagnostic event → yokeType:'diagnostic'
// ---------------------------------------------------------------------------

test("A1: flattenEvent is exported as _test_flattenEvent", function() {
  assert.strictEqual(typeof flattenEvent, "function",
    "_test_flattenEvent must be exported from lib/yoke/adapters/claude.js; " +
    "add it to module.exports so the test seam exists");
});

test("A2: flattenEvent maps { type:'diagnostic' } to yokeType:'diagnostic'", function() {
  var raw = {
    type: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: AgentTeamsMemberSpawned",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.yokeType, "diagnostic",
    "flattenEvent must set yokeType:'diagnostic', not 'unknown'");
});

test("A3: flattenEvent carries severity, source, message through unchanged", function() {
  var raw = {
    type: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: AgentTeamsMemberSpawned",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.severity, "warning",
    "severity must pass through flattenEvent");
  assert.strictEqual(result.source, "hook",
    "source must pass through flattenEvent");
  assert.strictEqual(result.message, "Unknown hook event: AgentTeamsMemberSpawned",
    "message must pass through flattenEvent unchanged");
});

test("A4: flattenEvent diagnostic branch does NOT produce rawType or raw fields", function() {
  // rawType and raw are hallmarks of the unknown catch-all — they must not appear
  // when the diagnostic branch fires.
  var raw = {
    type: "diagnostic",
    severity: "info",
    source: "cli",
    message: "Ignoring unknown config key",
  };
  var result = flattenEvent(raw);
  assert.strictEqual(result.rawType, undefined,
    "rawType must not be set on a properly-routed diagnostic event");
  assert.strictEqual(result.raw, undefined,
    "raw must not be set on a properly-routed diagnostic event");
});

test("A5: flattenEvent diagnostic branch works for each severity", function() {
  var severities = ["info", "warning", "error"];
  for (var i = 0; i < severities.length; i++) {
    var raw = {
      type: "diagnostic",
      severity: severities[i],
      source: "settings",
      message: "test message for " + severities[i],
    };
    var result = flattenEvent(raw);
    assert.strictEqual(result.yokeType, "diagnostic",
      "yokeType must be 'diagnostic' for severity: " + severities[i]);
    assert.strictEqual(result.severity, severities[i],
      "severity must be preserved for: " + severities[i]);
  }
});

// ---------------------------------------------------------------------------
// Hop B — message processor: yokeType:'diagnostic' → { type:'diagnostic' }
// ---------------------------------------------------------------------------

test("B1: processor routes yokeType:'diagnostic' to a distinct frontend message", function() {
  var ctx = makeCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, {
    yokeType: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: AgentTeamsMemberSpawned",
  });

  var diagMsgs = ctx.sent.filter(function(m) { return m.type === "diagnostic"; });
  assert.strictEqual(diagMsgs.length, 1,
    "exactly one { type:'diagnostic' } frontend message must be emitted");
});

test("B2: processor diagnostic message carries severity, source, message", function() {
  var ctx = makeCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, {
    yokeType: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: AgentTeamsMemberSpawned",
  });

  var msg = ctx.sent.find(function(m) { return m.type === "diagnostic"; });
  assert.ok(msg, "diagnostic message must be present");
  assert.strictEqual(msg.severity, "warning",  "severity must be forwarded");
  assert.strictEqual(msg.source,   "hook",     "source must be forwarded");
  assert.strictEqual(msg.message,  "Unknown hook event: AgentTeamsMemberSpawned",
    "message must be forwarded");
});

test("B3: processor diagnostic route does NOT emit a { type:'error' } message", function() {
  // Regression guard: before this stage, diagnostic events fell into the system
  // catch-all and were mislabelled as errors.
  var ctx = makeCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, {
    yokeType: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: PostToolUse",
  });

  var errorMsgs = ctx.sent.filter(function(m) { return m.type === "error"; });
  assert.strictEqual(errorMsgs.length, 0,
    "diagnostic events must NOT produce a { type:'error' } frontend message");
});

test("B4: existing system catch-all still emits { type:'error' } for unhandled system subtypes", function() {
  // Non-regression: the system catch-all path must remain intact for real error subtypes.
  var ctx = makeCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, {
    yokeType: "system",
    subtype: "hook_execution_error",
    error: "Hook script exited with code 1",
    message: null,
    text: null,
    content: null,
  });

  var errorMsgs = ctx.sent.filter(function(m) { return m.type === "error"; });
  assert.strictEqual(errorMsgs.length, 1,
    "unhandled system subtype with error text must still emit { type:'error' }");
  assert.ok(errorMsgs[0].text.indexOf("Hook script") !== -1,
    "error text must be forwarded from the system event");
});

// ---------------------------------------------------------------------------
// End-to-end: simulate the full capture → flatten → route path
// ---------------------------------------------------------------------------

test("E2E: Unknown hook event travels from raw diagnostic event to { type:'diagnostic' } frontend message", function() {
  // Simulate what the worker emits after parseDiagnosticLine matches:
  //   sendToDaemon({ type: 'sdk_event', event: { type:'diagnostic', severity:'warning',
  //                                               source:'hook', message:'Unknown hook event: ...' } })
  // createWorkerQueryHandle calls flattenEvent(msg.event) to produce the flattened event,
  // which processSDKMessage then routes. We replicate both hops in sequence.
  var rawWorkerEvent = {
    type: "diagnostic",
    severity: "warning",
    source: "hook",
    message: "Unknown hook event: AgentTeamsMemberSpawned",
  };

  // Hop A: flatten
  var flattened = flattenEvent(rawWorkerEvent);
  assert.strictEqual(flattened.yokeType, "diagnostic",
    "Hop A: flattenEvent must produce yokeType:'diagnostic'");

  // Hop B: route through processor
  var ctx = makeCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, flattened);

  var diagMsgs = ctx.sent.filter(function(m) { return m.type === "diagnostic"; });
  assert.strictEqual(diagMsgs.length, 1, "E2E: exactly one diagnostic message must reach the frontend");

  var dm = diagMsgs[0];
  assert.strictEqual(dm.severity, "warning", "E2E: severity preserved end-to-end");
  assert.strictEqual(dm.source,   "hook",    "E2E: source preserved end-to-end");
  assert.ok(dm.message.indexOf("Unknown hook event") !== -1,
    "E2E: message text preserved end-to-end");

  // No spurious error message
  var errorMsgs = ctx.sent.filter(function(m) { return m.type === "error"; });
  assert.strictEqual(errorMsgs.length, 0,
    "E2E: no error message must be emitted for a diagnostic event");
});
