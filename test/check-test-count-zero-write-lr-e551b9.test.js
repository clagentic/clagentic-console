"use strict";
// Regression test for the lr-e551b9 fold-in (PEACHES PR #402 BLOCKING).
// writeFullySync (test/check-test-count-short-write-lr-e551b9.test.js)
// advances `offset` ONLY by fs.writeSync's return value:
//   offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
// If fs.writeSync ever returns 0, offset does not advance and
// `while (offset < buffer.length)` spins FOREVER. On this specific script —
// the merge-gate wrapper whose entire purpose is turning a FAIL verdict into
// a legible signal — an infinite loop here is strictly worse than the
// truncation bug it replaced: the job burns its runner until the workflow
// timeout kills it, producing NO verdict and NO annotation at all, versus a
// truncated log that still fails fast with a usable exit code.
//
// This file covers the 0-byte-return path directly: assert the guard
// terminates (does not hang) and surfaces the failure as a throw rather than
// looping, via a BOUNDED call-count assertion rather than a real wall-clock
// timeout — a regression to the unguarded loop calls the stub an unbounded
// number of times with a 0 return and never returns control to the test
// runner at all, so a real-time `{ timeout }` on the test itself would only
// convert a spin into a hung *suite* (node --test's own timeout mechanism
// cannot interrupt a synchronous, non-yielding while loop — there is no
// event-loop turn for it to fire on). The stub instead throws once its own
// call count exceeds a bound comfortably above the guard's configured
// threshold, so an unguarded loop fails with a bounded, assertable stub
// error instead of hanging the process, and CI still reports a fast FAIL
// rather than stalling on a spinning regression (the exact "a test that
// hangs on regression is nearly as bad as the bug" trap named in this
// task's dispatch).
var test = require("node:test");
var assert = require("node:assert/strict");
var checkTestCount = require("../scripts/check-test-count.js");

// Comfortably above writeFullySync's own MAX_CONSECUTIVE_ZERO_WRITES bound
// (100) so the stub never trips before the guard has a chance to act, but
// still small enough that an unguarded regression fails near-instantly
// instead of iterating meaningfully long.
var STUB_CALL_BOUND = 500;

test(
  "lr-e551b9 zero-write: writeFullySync throws instead of spinning forever when fs.writeSync returns 0",
  function () {
    var fs = require("fs");
    var originalWriteSync = fs.writeSync;
    var callCount = 0;

    fs.writeSync = function () {
      callCount += 1;
      if (callCount > STUB_CALL_BOUND) {
        // Safety valve for a REGRESSION to the unguarded loop: without this,
        // an unguarded writeFullySync would call this stub forever and the
        // test process would never yield back to node --test's own result
        // reporting — the exact "hangs on regression" failure mode this test
        // exists to avoid inflicting on CI. Throwing here still fails the
        // test (the throw propagates out of writeFullySync, uncaught by the
        // test body below, and node --test reports it as a failure) — it
        // just fails FAST instead of hanging.
        throw new Error(
          "writeFullySync called the 0-byte-returning stub " + callCount +
          " times without throwing its own bounded-retry error — the " +
          "non-advancing-write guard is missing or broken (regression to " +
          "the unguarded spin this test exists to catch)."
        );
      }
      return 0;
    };

    var input = Buffer.from("hello world", "utf8");

    try {
      assert.throws(
        function () {
          checkTestCount.writeFullySync(1, input);
        },
        function (err) {
          return err instanceof Error && !/non-advancing-write guard/.test(err.message);
        },
        "writeFullySync must throw its OWN bounded-retry error, not exhaust the test's safety-valve bound first"
      );
    } finally {
      fs.writeSync = originalWriteSync;
    }

    assert.ok(
      callCount <= STUB_CALL_BOUND,
      "writeFullySync must give up well before " + STUB_CALL_BOUND + " zero-byte returns; got " + callCount + " calls"
    );
  }
);

test(
  "lr-e551b9 zero-write: a mixed sequence (partial, partial, then a run of zeros) still terminates via the guard, not just a first-call zero",
  function () {
    var fs = require("fs");
    var originalWriteSync = fs.writeSync;
    var callCount = 0;
    var progressCalls = 0;

    fs.writeSync = function (fd, buffer, offset, length) {
      callCount += 1;
      if (callCount > STUB_CALL_BOUND) {
        throw new Error(
          "writeFullySync called the stub " + callCount + " times without " +
          "throwing its own bounded-retry error after real progress was " +
          "already made — the guard must apply AFTER progress, not only " +
          "on an immediate first-call zero."
        );
      }
      // First two calls make real, partial progress (proving the guard does
      // not just special-case "the very first call returned 0" — it must
      // keep counting consecutive zeros correctly even after offset has
      // already advanced past 0).
      if (progressCalls < 2) {
        progressCalls += 1;
        var n = Math.min(2, length);
        return n;
      }
      // From here on, every call returns 0 — the non-advancing run the
      // guard must catch.
      return 0;
    };

    var input = Buffer.from("hello world", "utf8"); // 11 bytes; 2+2 real progress, then stuck

    try {
      assert.throws(
        function () {
          checkTestCount.writeFullySync(1, input);
        },
        /writeFullySync: fs\.writeSync returned 0/,
        "the guard must fire (and its own error message must be observable) after real progress was already made, not only on an immediate first-call zero"
      );
    } finally {
      fs.writeSync = originalWriteSync;
    }

    assert.ok(
      callCount <= STUB_CALL_BOUND,
      "the mixed sequence must still terminate well before " + STUB_CALL_BOUND + " calls; got " + callCount
    );
    assert.equal(progressCalls, 2, "the stub must have been allowed to make its two real partial-progress calls before the zero run began");
  }
);
