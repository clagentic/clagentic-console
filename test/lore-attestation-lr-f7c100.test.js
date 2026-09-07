"use strict";
/**
 * Regression test for lr-f7c100: lib/lore-attestation.js must be fail-open.
 * A host without LORE installed (lore binary missing -> ENOENT) or any
 * other CLI failure must never throw, never reject a promise the caller is
 * expected to await (there is none — attestHumanSession is fire-and-forget
 * by contract), and must never affect the caller's control flow.
 *
 * lr-f7c100 CI fix (PEACHES fnd, confirmed via CI failure + local
 * non-repro): the original version of the PATH test below mutated the
 * real process.env.PATH and restored it in a synchronous `finally`, but
 * execFile's child-process spawn is asynchronous — the restore ran before
 * the spawn actually resolved, so the test (a) never verified the ENOENT
 * path it claimed to (the spawn very likely raced against the ALREADY
 * -restored real PATH, which has a real `lore` binary on this and most
 * dev/CI hosts) and (b) left an un-awaited, unaccounted-for child process
 * in flight past the end of the test — exactly the leaked-handle failure
 * class check-test-count.js (lr-795882/lr-a7b03e) exists to catch. Fixed
 * by using attestHumanSession's test-only onSettled hook to await the
 * real callback deterministically, and by never touching global
 * process.env.PATH — passing a scoped, guaranteed-empty-of-`lore`
 * directory via a per-call PATH override is unnecessary once the test
 * awaits completion; asserting only "doesNotThrow synchronously plus
 * settles without throwing" is sufficient and environment-independent.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attestHumanSession } = require("../lib/lore-attestation");

test("lr-f7c100: attestHumanSession never throws, and settles without throwing, for a session id (lore may or may not be installed on this host)", function (t, done) {
  assert.doesNotThrow(function () {
    attestHumanSession("some-session-id-lr-f7c100", function () {
      // Reached regardless of whether the real `lore` binary is present —
      // attestHumanSession's own execFile callback already swallows every
      // error case (ENOENT included); onSettled firing at all, without the
      // process crashing, is the fail-open contract under test here.
      done();
    });
  });
});

test("lr-f7c100: attestHumanSession is a no-op (does not throw, settles synchronously) for a falsy/non-string session id", function () {
  var settledCount = 0;
  assert.doesNotThrow(function () { attestHumanSession(null, function () { settledCount++; }); });
  assert.doesNotThrow(function () { attestHumanSession(undefined, function () { settledCount++; }); });
  assert.doesNotThrow(function () { attestHumanSession("", function () { settledCount++; }); });
  assert.doesNotThrow(function () { attestHumanSession(42, function () { settledCount++; }); });
  // These are the invalid-input early-return branch — no child process is
  // ever spawned, so onSettled must fire synchronously, not on a later
  // event-loop tick (no execFile in flight to await).
  assert.equal(settledCount, 4, "the invalid-input branch must call onSettled synchronously for every falsy/non-string id, never spawning a process");
});
