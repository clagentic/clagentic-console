"use strict";
// Regression test for the lr-e551b9 REOPEN (MILLER third-pass diagnosis,
// confidence 0.93, reproduced locally and in CI on PR #400's rebased head
// d7dd88ae). The PR #401 fix made classifyRun() name the right failure
// reason, but its DELIVERY was broken: check-test-count.js wrote the
// ::error:: annotation with process.stdout.write() and then called
// process.exit() before that write could flush. process.stdout.write is
// ASYNCHRONOUS when stdout is a real OS pipe (always true in CI); a
// multi-MB preceding TAP dump exceeds the 64KB kernel pipe buffer, so the
// remainder — including the annotation queued behind it — sits in a
// userspace buffer that process.exit() tears down without draining. The
// annotation reached the Writable stream object and never reached the fd.
//
// test/check-test-count-signal-legibility-lr-e551b9.test.js already covers
// classifyRun()'s verdict/precedence logic and emitAnnotation()'s message
// FORMAT — that coverage is correct for what it tests and is kept unchanged.
// It stubs process.stdout.write with a function that pushes to an array and
// returns true, which is exactly why it could not catch this: a stub that
// always "succeeds" cannot observe flush, backpressure, or the interaction
// between an async queue and process.exit(). It proves the message is
// FORMATTED correctly; it cannot prove the message is DELIVERED. A write is
// not a delivery. This file is the delivery test PEACHES, BOBBIE and NAOMI's
// prior review passes did not have, because none of them exercised a real
// pipe.
//
// METHOD: spawn the actual scripts/check-test-count.js as a CHILD PROCESS
// (not require()'d, not stubbed) with stdio: ["ignore", "pipe", "pipe"] — a
// real OS pipe, matching CI exactly — against a fixture file
// (test/fixtures/check-test-count-padding-lr-e551b9.fixture.js) that emits
// ~2000 trivial passing tests, comfortably exceeding a 64KB TAP dump, plus a
// deliberately nonexistent second file to force the real missing-files FAIL
// path (a genuine wrapper-level condition, not a stub). The parent reads the
// child's stdout the way a CI log collector does — accumulate chunks,
// nothing more — and asserts the captured bytes contain the ::error:: line.
//
// DEMONSTRATED-FAILURE VERIFICATION (lr-4e1242 convention), STRONG FORM:
// this exact test file, run via `npx node --test
// test/check-test-count-delivery-lr-e551b9.test.js`, was executed against
// the pre-fix script at commit cf4b734a (git show cf4b734a:scripts/check-
// test-count.js, restored to a scratch copy since the working tree already
// carries the fix) BEFORE the delivery fix in this diff was written. It
// failed with a genuine wrong-content assertion — not a missing-symbol or
// spawn error:
//
//   AssertionError [ERR_ASSERTION]: the ::error:: annotation must be present
//   in the child's captured stdout — the wrapper must not lose it to an
//   unflushed pipe
//   + actual: false
//   - expected: true
//
// and the captured stdout in that pre-fix run measured 65536 bytes (exactly
// one 64KB pipe high-water mark) with zero occurrences of "::error::",
// reproducing MILLER's probe finding (mid-word truncation, no annotation)
// exactly. After the fix in this diff (fs.writeSync for both the annotation
// and the TAP dump, plus process.exitCode instead of process.exit()), the
// same test passes: the annotation is present regardless of TAP dump size.
// This is a real absent-annotation failure against production code, not a
// missing-symbol error — the strong form PEACHES requires.
var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { spawn } = require("child_process");

var WRAPPER_PATH = path.join(__dirname, "..", "scripts", "check-test-count.js");
var PADDING_FIXTURE = path.join(__dirname, "fixtures", "check-test-count-padding-lr-e551b9.fixture.js");
var MISSING_FIXTURE = path.join(__dirname, "fixtures", "check-test-count-DOES-NOT-EXIST-lr-e551b9.test.js");

// Runs the real wrapper as a child process with a genuine OS pipe on stdout
// and stderr, and resolves with the full captured output plus exit code.
// Deliberately does NOT force any flush/drain on the parent side — a CI log
// collector does not either; if the child loses data to an unflushed queue,
// this harness must observe that loss, not paper over it.
function runWrapperThroughRealPipe(args) {
  return new Promise(function (resolve, reject) {
    // This test file itself runs under `node --test`, which sets
    // NODE_TEST_CONTEXT in its own process.env and — because child_process
    // inherits the parent's env by default — that value leaks into the
    // spawned child below. The wrapper we're spawning ALSO runs `node
    // --test` internally, and Node's test runner treats an inherited
    // NODE_TEST_CONTEXT as "I am a nested test-runner child", which trips
    // its own recursion guard and makes it skip actually running the
    // fixture file (silently reported here as "missing-files", NOT the
    // production defect under test). Stripping it is required for this
    // harness to observe the real wrapper's behavior instead of Node's own
    // nested-test-runner guard.
    var childEnv = Object.assign({}, process.env);
    delete childEnv.NODE_TEST_CONTEXT;

    var child = spawn(process.execPath, [WRAPPER_PATH].concat(args), {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    var stdoutChunks = [];
    var stderrChunks = [];

    child.stdout.on("data", function (chunk) {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", function (chunk) {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", function (code) {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

test(
  "lr-e551b9 delivery: a fail path (missing-files) behind a large preceding TAP dump still delivers the ::error:: annotation through a real pipe",
  { timeout: 30000 },
  async function () {
    var result = await runWrapperThroughRealPipe([PADDING_FIXTURE, MISSING_FIXTURE]);

    // Sanity: this must genuinely be the missing-files fail path, not some
    // other failure mode — assert the exit code and the reason line, not
    // just the annotation, so a future regression that changes WHICH path
    // fires is also caught here.
    assert.equal(result.exitCode, 1, "the missing-files condition must still fail the run (fail-open constraint, lr-795882)");
    assert.ok(
      result.stderr.indexOf("[check-test-count] FAIL (missing-files)") !== -1,
      "stderr must still carry the plain-text FAIL line; got: " + result.stderr.slice(-500)
    );

    // The load-bearing assertion: the annotation must be present in the
    // CHILD'S ACTUAL CAPTURED stdout, past a TAP dump large enough to
    // exceed a 64KB pipe buffer. This is exactly the assertion that fails
    // against the pre-fix script (see the file header's demonstrated-
    // failure verification) and passes against the fix in this diff.
    assert.ok(
      result.stdout.indexOf("::error::") !== -1,
      "the ::error:: annotation must be present in the child's captured stdout — the wrapper must not lose it to an unflushed pipe"
    );
    assert.ok(
      result.stdout.indexOf("missing-files") !== -1,
      "the delivered annotation must name the actual verdict kind, not just any ::error:: text"
    );

    // The raw TAP dump must also survive intact — MILLER/HOLDEN both noted
    // that losing the annotation's ride-along blob (the raw test output) is
    // an independent real problem, not just the annotation. A truncated
    // capture ends abruptly with no TAP summary footer; assert the footer
    // is present as a proxy for "the dump was not cut off mid-stream".
    assert.ok(
      result.stdout.indexOf("# duration_ms") !== -1,
      "the TAP summary footer must survive intact — a truncated dump would be missing it, same as MILLER's probe finding"
    );
  }
);

test(
  "lr-e551b9 delivery: a clean run (no fail path) behind the same large TAP dump emits no annotation and exits 0",
  { timeout: 30000 },
  async function () {
    var result = await runWrapperThroughRealPipe([PADDING_FIXTURE]);

    assert.equal(result.exitCode, 0, "a genuinely clean run must still pass — the delivery fix must not introduce a new false FAIL");
    assert.ok(result.stdout.indexOf("::error::") === -1, "no annotation should be emitted when nothing failed");
  }
);
