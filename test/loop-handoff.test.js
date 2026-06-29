"use strict";
/**
 * Tests for lib/loop-handoff.js (lr-ed10)
 *
 * Covers:
 *   - opt-in guard: no write/read when compactHandoff is not set
 *   - handoff write at iteration boundary
 *   - handoff preamble build for next iteration
 *   - clean degradation: first iteration has no prior handoff
 *   - clean degradation: invalid loopId is rejected
 *   - clean degradation: write errors are swallowed (loop continues)
 */

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// We need to override CONFIG_DIR used by loop-handoff.js.
// Inject a temp dir via CLAGENTIC_HOME env var before requiring the module,
// then restore it after.  This keeps the test fully isolated from the user's
// real ~/.clagentic/console/ directory.
var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loop-handoff-test-"));
var origConfigDir = process.env.CLAGENTIC_HOME;
process.env.CLAGENTIC_HOME = tmpHome;

// Require after the env override so config.js picks up our tmp dir.
var handoff = require("../lib/loop-handoff");

// Cleanup CLAGENTIC_HOME override after suite (best-effort).
process.on("exit", function () {
  process.env.CLAGENTIC_HOME = origConfigDir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoopState(overrides) {
  return Object.assign({
    loopId: "loop_test123_abc",
    iteration: 1,
    promptText: "Fix the bug",
    settings: { compactHandoff: true },
  }, overrides);
}

function makeSession(historyEntries) {
  return { history: historyEntries || [] };
}

// ---------------------------------------------------------------------------
// Tests: opt-in guard
// ---------------------------------------------------------------------------

test("writeHandoff: returns false when compactHandoff is not set", function () {
  var ls = makeLoopState({ settings: {} });
  var result = handoff.writeHandoff({ loopState: ls, session: makeSession() });
  assert.strictEqual(result, false);
});

test("writeHandoff: returns false when settings is null", function () {
  var ls = makeLoopState({ settings: null });
  var result = handoff.writeHandoff({ loopState: ls, session: makeSession() });
  assert.strictEqual(result, false);
});

test("buildHandoffPreamble: returns null when compactHandoff is not set", function () {
  var ls = makeLoopState({ settings: {}, iteration: 2 });
  var result = handoff.buildHandoffPreamble({ loopState: ls });
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Tests: invalid loopId rejected
// ---------------------------------------------------------------------------

test("writeHandoff: returns false for invalid loopId (path traversal attempt)", function () {
  var ls = makeLoopState({ loopId: "../../etc/passwd", settings: { compactHandoff: true } });
  var result = handoff.writeHandoff({ loopState: ls, session: makeSession() });
  assert.strictEqual(result, false);
});

test("writeHandoff: returns false for loopId without loop_ prefix", function () {
  var ls = makeLoopState({ loopId: "notavalidid", settings: { compactHandoff: true } });
  var result = handoff.writeHandoff({ loopState: ls, session: makeSession() });
  assert.strictEqual(result, false);
});

test("getHandoffDir: returns null for invalid loopId", function () {
  assert.strictEqual(handoff.getHandoffDir("../../evil"), null);
  assert.strictEqual(handoff.getHandoffDir("notvalid"), null);
  assert.strictEqual(handoff.getHandoffDir(null), null);
  assert.strictEqual(handoff.getHandoffDir(""), null);
});

// ---------------------------------------------------------------------------
// Tests: first iteration — no prior handoff
// ---------------------------------------------------------------------------

test("buildHandoffPreamble: returns null for iteration 1 (no prior handoff)", function () {
  var ls = makeLoopState({ settings: { compactHandoff: true }, iteration: 1 });
  var result = handoff.buildHandoffPreamble({ loopState: ls });
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Tests: handoff write and read roundtrip
// ---------------------------------------------------------------------------

test("writeHandoff: creates handoff file on disk", function () {
  var loopId = "loop_test_write_" + Date.now();
  var ls = makeLoopState({
    loopId: loopId,
    iteration: 1,
    promptText: "Implement feature X",
    settings: { compactHandoff: true },
  });
  var session = makeSession([
    { type: "user_message", text: "Implement feature X" },
    { type: "delta", text: "- Decided to use module Y\n- TODO: still need to wire up tests\n" },
  ]);

  var ok = handoff.writeHandoff({ loopState: ls, session: session, verdict: null });
  assert.strictEqual(ok, true);

  var dir = handoff.getHandoffDir(loopId);
  assert.ok(dir, "handoff dir should be non-null");
  var filePath = path.join(dir, "handoff-1.json");
  assert.ok(fs.existsSync(filePath), "handoff-1.json should exist");

  var frame = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.strictEqual(frame.loop_id, loopId);
  assert.strictEqual(frame.iteration, 1);
  assert.strictEqual(frame.schema_version, 1);
  assert.ok(typeof frame.task === "string");
  assert.ok(Array.isArray(frame.decisions));
  assert.ok(Array.isArray(frame.open_threads));
  assert.ok(typeof frame.written_at === "string");
});

test("writeHandoff: writes verdict into handoff file when provided", function () {
  var loopId = "loop_test_verdict_" + Date.now();
  var ls = makeLoopState({
    loopId: loopId,
    iteration: 2,
    promptText: "Fix remaining issues",
    settings: { compactHandoff: true },
  });
  var session = makeSession([{ type: "delta", text: "All done." }]);

  handoff.writeHandoff({ loopState: ls, session: session, verdict: "fail" });

  var dir = handoff.getHandoffDir(loopId);
  var frame = JSON.parse(fs.readFileSync(path.join(dir, "handoff-2.json"), "utf8"));
  assert.strictEqual(frame.verdict, "fail");
});

test("buildHandoffPreamble: returns a non-empty string after a handoff was written", function () {
  var loopId = "loop_test_preamble_" + Date.now();
  // Write iteration 1 handoff
  var ls1 = makeLoopState({
    loopId: loopId,
    iteration: 1,
    promptText: "Task goal",
    settings: { compactHandoff: true },
  });
  var session = makeSession([
    { type: "delta", text: "- Decided to use approach A\n- TODO: open item B\n" },
  ]);
  handoff.writeHandoff({ loopState: ls1, session: session, verdict: "fail" });

  // Now simulate iteration 2 starting — iteration is already incremented to 2
  var ls2 = makeLoopState({
    loopId: loopId,
    iteration: 2,
    promptText: "Task goal",
    settings: { compactHandoff: true },
  });
  var preamble = handoff.buildHandoffPreamble({ loopState: ls2 });

  assert.ok(preamble, "preamble should be non-null and non-empty");
  assert.ok(preamble.indexOf("Continuation from iteration 1") !== -1, "should mention iteration 1");
  assert.ok(preamble.indexOf("fail") !== -1, "should include verdict");
});

test("buildHandoffPreamble: returns null when handoff file is missing (clean degradation)", function () {
  var loopId = "loop_test_missing_" + Date.now();
  // No handoff written for iteration 1
  var ls = makeLoopState({
    loopId: loopId,
    iteration: 2,
    settings: { compactHandoff: true },
  });
  var result = handoff.buildHandoffPreamble({ loopState: ls });
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Tests: internal helpers (_parseDecisionsAndThreads)
// ---------------------------------------------------------------------------

test("_parseDecisionsAndThreads: extracts decisions from bullet text", function () {
  var text = "- Decided to use TypeScript\n- Fixed the import error\n- TODO: still need tests\n";
  var result = handoff._parseDecisionsAndThreads(text);
  assert.ok(result.decisions.length > 0, "should find at least one decision");
  assert.ok(result.open_threads.length > 0, "should find at least one open thread");
});

test("_parseDecisionsAndThreads: returns empty arrays for empty text", function () {
  var result = handoff._parseDecisionsAndThreads("");
  assert.deepStrictEqual(result.decisions, []);
  assert.deepStrictEqual(result.open_threads, []);
});

// ---------------------------------------------------------------------------
// Tests: _extractSessionSummary
// ---------------------------------------------------------------------------

test("_extractSessionSummary: returns empty string for empty history", function () {
  var result = handoff._extractSessionSummary([]);
  assert.strictEqual(result, "");
});

test("_extractSessionSummary: returns text from delta entries", function () {
  var history = [
    { type: "user_message", text: "Fix the bug" },
    { type: "delta", text: "I found the issue and fixed it." },
  ];
  var result = handoff._extractSessionSummary(history);
  assert.ok(result.indexOf("found the issue") !== -1);
});

test("_extractSessionSummary: handles text-type entries", function () {
  var history = [
    { type: "text", text: "Done implementing the feature." },
  ];
  var result = handoff._extractSessionSummary(history);
  assert.ok(result.indexOf("Done implementing") !== -1);
});
