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
//       even though the dispatched subagent was still genuinely working.
//
// SUPERSEDED IN PART by lr-66c118 (epic lr-a6a449 child 4/4): setActivity
// collapsed to exactly ONE optimistic raise site (input.js) with no manual
// clear sites anywhere — so the hasActiveSubagents()-gated
// setActivity(null) clear this file originally proved (in app-messages.js's
// 'result'/'done' handlers and in tools.js's markSubagentDone) no longer
// exists to gate, and hasActiveSubagents() itself was removed as dead code
// (zero remaining callers). Those specific tests are removed below; see
// test/activity-state-lr-66c118.test.js for the test that now owns the
// setActivity single-call-site contract.
//
// What is UNCHANGED and still tested here: the underlying
// activeSubagentToolIds liveness tracking itself is still load-bearing for
// the per-tool "Stop" button UI (initSubagentStop / updateSubagentTaskStatus
// / resetToolState) — lr-66c118 did not touch that machinery, only its
// former setActivity consumer.
//
// Same supersession pattern already established in this repo: see
// test/hub-recent-sessions-merge-dot-lr-0aa7b6.test.js superseding
// test/hub-recent-sessions-alert-dot-lr-2b1f03.test.js.
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
// tools.js: subagent liveness tracking (still load-bearing for the Stop
// button UI, independent of the removed setActivity consumer)
// ---------------------------------------------------------------------------

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

test("tools.js (superseded, lr-66c118): markSubagentDone no longer calls setActivity", function () {
  var idx = TOOLS_JS.indexOf("export function markSubagentDone");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 700);
  assert.ok(
    block.indexOf("setActivity(") === -1,
    "markSubagentDone must not call setActivity — the indicator collapsed to a single optimistic raise in input.js (lr-66c118)"
  );
});

test("tools.js: updateSubagentTaskStatus clears liveness on a terminal failed/killed status", function () {
  var idx = TOOLS_JS.indexOf("export function updateSubagentTaskStatus");
  assert.ok(idx !== -1);
  var block = TOOLS_JS.slice(idx, idx + 250);
  assert.match(
    block,
    /if\s*\(patch\.status === "failed" \|\| patch\.status === "killed"\)\s*\{\s*delete activeSubagentToolIds\[parentToolId\];/,
    "a failed/killed subagent must stop counting as live, or the Stop button " +
    "state could stay stuck for a subagent that will never send subagent_done"
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
// app-messages.js: 'result' and 'done' handlers (superseded, lr-66c118) —
// no longer gate anything on subagent liveness, because they no longer call
// setActivity at all.
// ---------------------------------------------------------------------------

test("app-messages.js (superseded, lr-66c118): 'result' and 'done' handlers no longer call setActivity", function () {
  var resultIdx = APP_MESSAGES_JS.indexOf("result: function (msg) {");
  var doneIdx = APP_MESSAGES_JS.indexOf("done: function (msg) {\n    removePreThinking();");
  assert.ok(resultIdx !== -1, "expected to find the 'result' handler");
  assert.ok(doneIdx !== -1, "expected to find the top-level 'done' handler (removePreThinking is unique to it)");

  var resultBlock = APP_MESSAGES_JS.slice(resultIdx, resultIdx + 900);
  var doneBlock = APP_MESSAGES_JS.slice(doneIdx, doneIdx + 900);

  assert.ok(resultBlock.indexOf("setActivity(") === -1, "the 'result' handler must not call setActivity (lr-66c118)");
  assert.ok(doneBlock.indexOf("setActivity(") === -1, "the 'done' handler must not call setActivity (lr-66c118)");
});

test("app-messages.js: the 'done' handler still calls resetToolState() unconditionally", function () {
  var idx = APP_MESSAGES_JS.indexOf("done: function (msg) {\n    removePreThinking();");
  assert.ok(idx !== -1);
  var block = APP_MESSAGES_JS.slice(idx, idx + 1200);
  assert.match(
    block,
    /resetToolState\(\);/,
    "resetToolState (which wipes activeSubagentToolIds) must still run in the done handler, unconditionally now that no gate depends on it running after a decision"
  );
});
