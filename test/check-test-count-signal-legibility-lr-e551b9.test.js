"use strict";
// Regression tests for lr-e551b9: scripts/check-test-count.js exits 1
// without naming a cause on several distinct wrapper-level FAIL routes,
// worst of all the signal-death path (result.status === null when the
// spawned `node --test` orchestrator is killed by a signal, e.g. OOM) which
// previously wrote NOTHING before exiting 1 — indistinguishable from a real
// test failure. See lr-4e1242 comment seq 5 (MILLER) for the full diagnosis
// and lr-795882 for why every one of these FAIL conditions must keep
// failing the run (a guard that looks like protection without providing it
// is worse than none — engram 7613980).
//
// classifyRun()/emitAnnotation() are exported by check-test-count.js
// specifically so this file can drive the decision logic directly with a
// hand-built spawnSync()-shaped result object, rather than needing to
// actually spawn `node --test` and kill its process tree with a real
// signal (the file-level "kill a test from inside itself" experiment run
// during this task's investigation showed Node's OWN test runner already
// intercepts a per-file worker crash and reports it as a normal test:fail
// event with a `signal` field — the true signal-death path this task fixes
// is one layer up, the top-level `node --test` orchestrator process dying,
// which is not something a `node --test`-run unit test can reproduce from
// inside that same process tree without killing itself).
//
// DEMONSTRATED-FAILURE VERIFICATION (lr-4e1242 convention): every test below
// was run against the pre-fix script (git stash) before this file existed.
// Pre-fix, classifyRun did not exist at all — check-test-count.js had no
// exported surface, so EVERY test in this file fails outright on
// `require("../scripts/check-test-count.js").classifyRun is not a
// function` against unmodified main. That is the demonstrated failure for
// the whole file: there was no unit-testable decision surface to assert
// against before this change, which is itself the defect lr-e551b9 fixes
// (the logic was unreachable except by paying for a full real `node --test`
// spawn). Per-test behavioral detail below where the mapping is not obvious
// from the function name alone.
//
// STRONG-FORM DEMONSTRATED FAILURE (PEACHES PR #401 fold-in): the "missing
// symbol" failure above proves classifyRun is new, not that its VERDICTS
// are correct — a test that would still pass against a WRONG verdict is not
// a behavioral guard. PEACHES found exactly that gap: the below-floor
// branch (~line 137, pre-fold-in) was checked before signal-death, so a
// signal-killed run with a below-floor total (the common real shape — an
// OOM-killed run IS a truncated run) reported kind "below-floor" instead of
// "signal-death". The "signal-death is checked before below-floor" test
// below was verified the strong way: run via `npx node --test
// test/check-test-count-signal-legibility-lr-e551b9.test.js` against the
// mis-ordered implementation BEFORE the reorder landed, it failed with
// `AssertionError [ERR_ASSERTION]: ... expected: 'signal-death', actual:
// 'below-floor'` (test 9 of 12, `code: 'ERR_ASSERTION'`) — a genuine
// wrong-verdict assertion failure, not a missing-symbol error. After
// reordering signal-death ahead of below-floor in classifyRun, the same
// isolated run passed 12/12. The "missing-files still wins ... full
// three-way precedence" test alongside it already passed pre-fix (missing-
// files was already checked first), which is the expected shape: that test
// pins a precedence relationship the reorder must NOT disturb, not one it
// fixes.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var checkTestCount = require("../scripts/check-test-count.js");

var FLOOR = 1300;

function absFile(name) {
  return path.resolve(name);
}

test("lr-e551b9: signal-death (result.status === null) is no longer silent — reports the signal and fails", function () {
  var files = ["test/some-file.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/some-file.test.js")] = 5;
  var result = { status: null, signal: "SIGKILL", error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 5 + FLOOR, FLOOR);

  assert.equal(verdict.ok, false, "a null-status (signal-killed) run must fail, not pass");
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.kind, "signal-death");
  assert.ok(verdict.reason, "the signal-death path must produce a non-empty reason (previously: nothing)");
  assert.ok(verdict.reason.indexOf("SIGKILL") !== -1,
    "the reason must name the actual signal, not just say 'killed'; got: " + verdict.reason);
});

test("lr-e551b9: signal-death names whichever signal fired, not a hardcoded one", function () {
  var files = ["test/some-file.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/some-file.test.js")] = 5;
  var result = { status: null, signal: "SIGTERM", error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 5 + FLOOR, FLOOR);

  assert.equal(verdict.kind, "signal-death");
  assert.ok(verdict.reason.indexOf("SIGTERM") !== -1, "must report SIGTERM, not a different signal name");
});

test("lr-e551b9: a genuine test failure (non-null, non-zero status) is distinguished from a wrapper failure", function () {
  var files = ["test/some-file.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/some-file.test.js")] = 5;
  var result = { status: 1, signal: null, error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 5 + FLOOR, FLOOR);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.kind, "test-failure",
    "a plain node --test failure must be labeled distinctly from signal-death/missing-files/below-floor");
});

test("lr-e551b9: missing-files path is preserved unchanged (still fails, still names the files)", function () {
  var files = ["test/present.test.js", "test/absent.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/present.test.js")] = 3;
  var result = { status: 0, signal: null, error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 3, FLOOR);

  assert.equal(verdict.ok, false, "a file with zero RESULT lines must still fail the run");
  assert.equal(verdict.kind, "missing-files");
  assert.ok(verdict.reason.indexOf("test/absent.test.js") !== -1,
    "must name the specific missing file; got: " + verdict.reason);
  assert.ok(verdict.reason.indexOf("test/present.test.js") === -1,
    "must NOT name the file that did report results");
});

test("lr-e551b9: below-floor path is preserved unchanged (still fails when every file reported but total is low)", function () {
  var files = ["test/a.test.js", "test/b.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/a.test.js")] = 1;
  resultsByFile[absFile("test/b.test.js")] = 1;
  var result = { status: 0, signal: null, error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 2, FLOOR);

  assert.equal(verdict.ok, false, "every file reporting at least one result must not mask a total below the floor");
  assert.equal(verdict.kind, "below-floor");
  assert.ok(verdict.reason.indexOf("2") !== -1 && verdict.reason.indexOf(String(FLOOR)) !== -1,
    "must report both the actual total and the floor; got: " + verdict.reason);
});

test("lr-e551b9: spawn-error path is preserved unchanged (spawnSync itself failing to launch the child)", function () {
  var files = ["test/a.test.js"];
  var resultsByFile = {};
  var result = { status: null, signal: null, error: new Error("ENOENT: node not found") };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 0, FLOOR);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "spawn-error");
  assert.ok(verdict.reason.indexOf("ENOENT") !== -1, "must surface the underlying spawn error message");
});

test("lr-e551b9: a clean run (every file reported, floor met, status 0) still passes", function () {
  var files = ["test/a.test.js", "test/b.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/a.test.js")] = FLOOR;
  resultsByFile[absFile("test/b.test.js")] = 1;
  var result = { status: 0, signal: null, error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, FLOOR + 1, FLOOR);

  assert.equal(verdict.ok, true, "a genuinely clean run must still pass — this fix must not introduce a new false FAIL");
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.kind, "ok");
  assert.equal(verdict.reason, null);
});

test("lr-e551b9: check ORDER — missing-files is checked before signal-death (a truncated run with both conditions reports the more specific cause)", function () {
  // If node --test died by signal AND a file has zero results (the common
  // real-world shape: a worker died mid-file, so that file never reported),
  // missing-files should win — it names the specific file, which is more
  // actionable than a bare signal name.
  var files = ["test/present.test.js", "test/killed-mid-run.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/present.test.js")] = 5;
  var result = { status: null, signal: "SIGKILL", error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 5, FLOOR);

  assert.equal(verdict.kind, "missing-files");
  assert.ok(verdict.reason.indexOf("test/killed-mid-run.test.js") !== -1);
});

test("lr-e551b9: check ORDER — signal-death is checked before below-floor (PEACHES PR #401 finding: an OOM-killed run IS a truncated run, so these two conditions fire TOGETHER in the ordinary case this task exists to make legible, and the wrong cause must not win)", function () {
  // All argv files reported at least one RESULT (so missing-files does NOT
  // fire), the orchestrator was signal-killed, AND the total is below the
  // floor — the common real shape for an OOM/CI-timeout kill mid-run: every
  // file that got to run at least once emitted partial results before the
  // process died, so nothing is individually "missing", but the aggregate
  // total is far short of a real run. signal-death must win here: it is the
  // more actionable, more specific cause (names the actual signal) and is
  // the true cause of the truncation, not a coincidental byproduct of it.
  var files = ["test/present.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/present.test.js")] = 2;
  var result = { status: null, signal: "SIGKILL", error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 2, FLOOR);

  assert.equal(verdict.kind, "signal-death",
    "a signal-killed run with a below-floor total must report signal-death, not below-floor — " +
    "otherwise the diagnostic reports the wrong cause precisely when the cause matters most; got: " + verdict.kind);
  assert.ok(verdict.reason.indexOf("SIGKILL") !== -1,
    "must name the actual signal even when below-floor also applies; got: " + verdict.reason);
});

test("lr-e551b9: check ORDER — missing-files still wins over signal-death even when below-floor would also apply (full three-way precedence)", function () {
  // Reaffirms the existing missing-files-before-signal-death precedence
  // (line ~147 above) but with a total that is ALSO below the floor, so
  // all three conditions are live at once. missing-files must still win —
  // reordering signal-death ahead of below-floor must not disturb the
  // higher-precedence missing-files check.
  var files = ["test/present.test.js", "test/killed-mid-run.test.js"];
  var resultsByFile = {};
  resultsByFile[absFile("test/present.test.js")] = 2;
  var result = { status: null, signal: "SIGKILL", error: undefined };

  var verdict = checkTestCount.classifyRun(result, files, resultsByFile, 2, FLOOR);

  assert.equal(verdict.kind, "missing-files",
    "missing-files must win over both signal-death and below-floor when all three are live; got: " + verdict.kind);
  assert.ok(verdict.reason.indexOf("test/killed-mid-run.test.js") !== -1);
});

// NOTE (lr-e551b9 reopen): emitAnnotation() is now implemented with
// fs.writeSync(1, ...) rather than process.stdout.write(...) — see
// check-test-count.js's DELIVERY comment above emitAnnotation for why: a
// process.stdout.write-based stub, exactly like the two tests below used to
// use, cannot observe the async-pipe/process.exit() race that lost the
// annotation in production (that is precisely the gap MILLER's reopen
// diagnosis found — see test/check-test-count-delivery-lr-e551b9.test.js for
// the through-a-real-pipe regression test that covers actual delivery).
// These two tests still verify message FORMAT — the ::error:: prefix and the
// GitHub workflow-command escaping — which is a real, narrower thing worth
// unit-testing fast and in isolation; they now spy on fs.writeSync (the
// primitive the implementation actually calls) instead of stubbing
// process.stdout.write (a primitive it no longer calls), so the spy remains
// truthful about what emitAnnotation does today.
test("lr-e551b9: emitAnnotation writes a ::error:: prefixed workflow command to fd 1", function () {
  var fs = require("fs");
  var chunks = [];
  var originalWriteSync = fs.writeSync;
  fs.writeSync = function (fd, chunk) {
    if (fd === 1) {
      chunks.push(chunk);
      return chunk.length;
    }
    return originalWriteSync.apply(fs, arguments);
  };
  try {
    checkTestCount.emitAnnotation("[check-test-count] FAIL (signal-death): node --test was killed by SIGKILL");
  } finally {
    fs.writeSync = originalWriteSync;
  }

  var written = chunks.join("");
  assert.ok(written.indexOf("::error::") === 0, "annotation must start with the GitHub Actions ::error:: workflow command");
  assert.ok(written.indexOf("SIGKILL") !== -1, "the annotated message must carry the actual failure reason");
});

test("lr-e551b9: emitAnnotation escapes %, CR and LF per GitHub's documented workflow-command encoding", function () {
  var fs = require("fs");
  var chunks = [];
  var originalWriteSync = fs.writeSync;
  fs.writeSync = function (fd, chunk) {
    if (fd === 1) {
      chunks.push(chunk);
      return chunk.length;
    }
    return originalWriteSync.apply(fs, arguments);
  };
  try {
    checkTestCount.emitAnnotation("100% failure\r\nline two");
  } finally {
    fs.writeSync = originalWriteSync;
  }

  var written = chunks.join("");
  assert.ok(written.indexOf("100%25 failure%0D%0Aline two") !== -1,
    "%, CR, LF must be percent-escaped or the annotation body truncates/misparses; got: " + written);
});
