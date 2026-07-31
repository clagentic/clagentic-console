// Regression tests for lr-255e: the "3 animated thinking dots" processing
// indicator was frequently missing while a turn was actively in progress.
//
// Empirical finding (see task lr-255e comment thread): this is NOT the same
// bug as lr-8355 (already fixed/deployed — the isProcessing mid-stream
// clobber in sdk-bridge.js's processQueryStream finally-block). Reproducing
// against the current code showed:
//
//   (a) plain foreground turns (no subagent dispatch): the indicator works
//       correctly end-to-end (status:"processing" -> ... -> 'delta'/'result'/
//       'done'). No bug here.
//   (b) a turn that dispatches an Agent-tool (Task) subagent: the parent
//       turn's SDK stream ends with a normal 'result' message as soon as the
//       Task call is queued -- the Task itself keeps running as a background
//       child. app-messages.js's 'result' AND 'done' handlers unconditionally
//       called setActivity(null), which killed the .thinking-dots indicator
//       even though the dispatched subagent was still genuinely working
//       (confirmed server-side: session.isProcessing is set false in the
//       'result' handler, lib/sdk-message-processor.js, with no check for
//       session.activeTaskToolIds -- see the lr-f36626 comment in
//       lib/sdk-bridge.js's startIdleReaper documenting this exact gap for a
//       different symptom, the idle reaper).
//
// So this was case (b): foreground-turn behavior was already correct;
// subagent-in-flight activity was invisible to the indicator. The acceptance
// criterion ("visible whenever a query is actively streaming for the viewing
// user") is widened by this fix to also cover a dispatched-but-backgrounded
// Agent-tool subagent, since that is genuine in-progress work from the
// operator's point of view.
//
// Fix: lib/public/modules/tools.js tracks live subagents (keyed by
// parentToolId, the same id used for the existing stop-button dedup guard)
// via hasActiveSubagents(); app-messages.js's 'result' and 'done' handlers
// consult it before calling setActivity(null), and markSubagentDone() clears
// the indicator once the LAST live subagent actually finishes (so it doesn't
// linger stuck once nothing is left running).
//
// These are static source-text regression checks matching the existing
// project convention for ESM DOM-heavy frontend modules with no jsdom
// harness (see frontend-state-correlation-lr-fb49.test.js,
// app-messages-registry-completeness-lr-4e49.test.js).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var TOOLS_JS = readMod("lib/public/modules/tools.js");
var APP_MESSAGES_JS = readMod("lib/public/modules/app-messages.js");

// ---------------------------------------------------------------------------
// tools.js: subagent liveness tracking
// ---------------------------------------------------------------------------

test("tools.js: hasActiveSubagents() is exported", function () {
  assert.match(
    TOOLS_JS,
    /export function hasActiveSubagents\(\)/,
    "tools.js must export a hasActiveSubagents() predicate so callers can " +
    "avoid clearing the activity indicator while a subagent is still live"
  );
});

test("tools.js: initSubagentStop registers the parentToolId as an active subagent", function () {
  var idx = TOOLS_JS.indexOf("export function initSubagentStop");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 200);
  assert.match(
    block,
    /activeSubagentToolIds\[parentToolId\]\s*=\s*true;/,
    "initSubagentStop (called from the task_started handler) must mark the " +
    "subagent live BEFORE any early return, so tracking survives even if the " +
    "tool card's DOM element is already gone"
  );
});

test("tools.js: markSubagentDone clears the parentToolId's liveness", function () {
  var idx = TOOLS_JS.indexOf("export function markSubagentDone");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 300);
  assert.match(
    block,
    /delete activeSubagentToolIds\[parentToolId\];/,
    "markSubagentDone must clear liveness tracking for this subagent"
  );
});

test("tools.js: markSubagentDone clears the indicator once the last subagent finishes", function () {
  var idx = TOOLS_JS.indexOf("export function markSubagentDone");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /if\s*\(!hasActiveSubagents\(\)\)\s*\{[\s\S]*?ctx\.setActivity\(null\);[\s\S]*?\}/,
    "markSubagentDone must clear the activity indicator when no subagent " +
    "remains live, so the indicator does not get stuck on after the parent " +
    "turn's own 'result'/'done' skipped clearing it for a live subagent"
  );
});

test("tools.js: updateSubagentTaskStatus clears liveness on a terminal failed/killed status", function () {
  var idx = TOOLS_JS.indexOf("export function updateSubagentTaskStatus");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 250);
  assert.match(
    block,
    /if\s*\(patch\.status === "failed" \|\| patch\.status === "killed"\)\s*\{\s*delete activeSubagentToolIds\[parentToolId\];/,
    "a failed/killed subagent must stop counting as live, or the indicator " +
    "could stay stuck on forever for a subagent that will never send " +
    "subagent_done"
  );
});

test("tools.js: resetToolState() clears activeSubagentToolIds", function () {
  var idx = TOOLS_JS.indexOf("export function resetToolState()");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /activeSubagentToolIds\s*=\s*\{\};/,
    "resetToolState (called on 'done' and on session switch) must reset " +
    "subagent-liveness tracking so it can never leak across turns/sessions"
  );
});

// ---------------------------------------------------------------------------
// app-messages.js: 'result' and 'done' handlers must not blindly clear the
// indicator out from under a live subagent
// ---------------------------------------------------------------------------

test("app-messages.js: hasActiveSubagents is imported from tools.js", function () {
  assert.match(
    APP_MESSAGES_JS,
    /import\s*\{[^}]*\bhasActiveSubagents\b[^}]*\}\s*from\s*['"]\.\/tools\.js['"]/,
    "app-messages.js must import hasActiveSubagents from tools.js"
  );
});

test("app-messages.js: the 'result' handler only clears the indicator when no subagent is live", function () {
  var idx = APP_MESSAGES_JS.indexOf("result: function (msg) {\n    // lr-255e:");
  assert.ok(idx !== -1, "expected to find the 'result' handler's lr-255e comment");
  var block = APP_MESSAGES_JS.slice(idx, idx + 900);
  assert.match(
    block,
    /if\s*\(!hasActiveSubagents\(\)\)\s*\{[\s\S]*?setActivity\(null\);[\s\S]*?\}/,
    "the 'result' handler must gate setActivity(null) on hasActiveSubagents() " +
    "-- the parent turn's stream can end via a normal 'result' message while a " +
    "dispatched Agent-tool subagent is still genuinely running in the background"
  );
});

test("app-messages.js: the 'done' handler only clears the indicator when no subagent is live", function () {
  var idx = APP_MESSAGES_JS.indexOf("done: function (msg) {\n    removePreThinking();");
  assert.ok(idx !== -1, "expected to find the top-level 'done' handler (removePreThinking is unique to it)");
  var block = APP_MESSAGES_JS.slice(idx, idx + 900);
  assert.match(
    block,
    /if\s*\(!hasActiveSubagents\(\)\)\s*\{[\s\S]*?setActivity\(null\);[\s\S]*?\}/,
    "the 'done' handler must also gate setActivity(null) on hasActiveSubagents() " +
    "-- task-stop/error/abort paths in sdk-bridge.js can send 'done' without ever " +
    "going through the 'result' handler, and without clearing " +
    "session.activeTaskToolIds, while a subagent is still live"
  );
});

test("app-messages.js: the 'done' handler still resets tool state after deciding whether to clear the indicator", function () {
  var idx = APP_MESSAGES_JS.indexOf("done: function (msg) {\n    removePreThinking();");
  assert.ok(idx !== -1);
  var block = APP_MESSAGES_JS.slice(idx, idx + 1200);
  var hasActiveIdx = block.indexOf("hasActiveSubagents()");
  var resetIdx = block.indexOf("resetToolState();");
  assert.ok(hasActiveIdx !== -1 && resetIdx !== -1, "expected both the gate and resetToolState() in the done handler");
  assert.ok(
    hasActiveIdx < resetIdx,
    "resetToolState() (which wipes activeSubagentToolIds) must run AFTER the " +
    "indicator-clearing decision, not before -- otherwise hasActiveSubagents() " +
    "would always see an empty set and the gate would be a no-op"
  );
});
