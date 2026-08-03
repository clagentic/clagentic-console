/**
 * Unit tests for lib/session-activity.js (lr-9bcd7b).
 *
 * The registry is plain data with no DOM dependency, so it admits real
 * behavioral unit tests rather than the static source-text regex style used
 * by test/processing-indicator-subagent-lr-255e.test.js (that style is
 * explicitly weak per that file's own test-coverage caveat and caught none
 * of the four defects lr-1317b8 fixed).
 *
 * Per the lr-9bcd7b spec, covers:
 *   - acquire -> active
 *   - release -> inactive
 *   - double-release idempotent
 *   - generation-bump drains stale tokens
 *   - staleness sweep fires
 *   - the mandatory chattiness invariant: acquiring a second token while one
 *     is already held must NOT report a changed (0->1) transition.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var sessionActivity = require("../lib/session-activity");

function makeSession() {
  return {}; // session-activity.js lazily creates session.activity itself
}

test("lr-9bcd7b: acquire -> active", function () {
  var session = makeSession();
  assert.equal(sessionActivity.isSessionActive(session), false);

  var result = sessionActivity.acquireToken(session, "tok-1", { source: "task", label: "do a thing" });

  assert.equal(sessionActivity.isSessionActive(session), true);
  assert.equal(result.changed, true, "0->1 transition must report changed:true");
  assert.equal(result.activeCount, 1);
});

test("lr-9bcd7b: release -> inactive", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task" });
  assert.equal(sessionActivity.isSessionActive(session), true);

  var result = sessionActivity.releaseToken(session, "tok-1");

  assert.equal(sessionActivity.isSessionActive(session), false);
  assert.equal(result.changed, true, "1->0 transition must report changed:true");
  assert.equal(result.activeCount, 0);
});

test("lr-9bcd7b: double-release is idempotent", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task" });
  var first = sessionActivity.releaseToken(session, "tok-1");
  var second = sessionActivity.releaseToken(session, "tok-1");

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "releasing an already-released token must not report a second transition");
  assert.equal(sessionActivity.isSessionActive(session), false);
});

test("lr-9bcd7b: releasing a token that was never acquired is a no-op, not an error", function () {
  var session = makeSession();
  assert.doesNotThrow(function () {
    var result = sessionActivity.releaseToken(session, "never-acquired");
    assert.equal(result.changed, false);
  });
});

test("lr-9bcd7b: generation-bump drains stale tokens (PRIMARY leak-resistance layer)", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-stale", { source: "task" });
  assert.equal(sessionActivity.isSessionActive(session), true);

  // Simulate a subagent that died silently -- never released its token --
  // followed by a genuine new-query/turn boundary (sdk-bridge.js startQuery).
  var bumpResult = sessionActivity.bumpGeneration(session);

  assert.equal(sessionActivity.isSessionActive(session), false, "a prior-generation token must be invisible immediately after a generation bump, with no explicit release");
  assert.equal(bumpResult.changed, true, "the bump itself caused the active->inactive transition");
  assert.equal(sessionActivity.getActiveCount(session), 0);
});

test("lr-9bcd7b: a token acquired in the new generation after a bump is unaffected by the bump that preceded it", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-old", { source: "task" });
  sessionActivity.bumpGeneration(session);
  sessionActivity.acquireToken(session, "tok-new", { source: "task" });

  assert.equal(sessionActivity.isSessionActive(session), true);
  assert.equal(sessionActivity.getActiveCount(session), 1, "only the new-generation token should count");
});

test("lr-9bcd7b: staleness sweep fires as a BACKSTOP when a token outlives maxAgeMs with no generation bump", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task" });
  // Force the token to look old without waiting in real time.
  var registry = sessionActivity.ensureRegistry(session);
  registry.tokens["tok-1"].startedAt = Date.now() - 100000;

  var result = sessionActivity.sweepStaleTokens(session, 50000);

  assert.equal(result.swept, 1);
  assert.equal(result.changed, true);
  assert.equal(sessionActivity.isSessionActive(session), false);
});

test("lr-9bcd7b: staleness sweep does not touch a token younger than maxAgeMs", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task" });

  var result = sessionActivity.sweepStaleTokens(session, 50000);

  assert.equal(result.swept, 0);
  assert.equal(result.changed, false);
  assert.equal(sessionActivity.isSessionActive(session), true);
});

test("lr-9bcd7b CHATTINESS INVARIANT: acquiring a second token while one is already held must NOT report a broadcast-worthy transition", function () {
  var session = makeSession();
  var first = sessionActivity.acquireToken(session, "tok-1", { source: "task" });
  assert.equal(first.changed, true, "the FIRST acquire (0->1) is the only one allowed to report changed:true");

  var second = sessionActivity.acquireToken(session, "tok-2", { source: "tool" });
  assert.equal(second.changed, false, "acquiring a second token while count is already >=1 must not move the derived boolean");
  assert.equal(second.activeCount, 2);

  var third = sessionActivity.acquireToken(session, "tok-3", { source: "subagent" });
  assert.equal(third.changed, false);
  assert.equal(third.activeCount, 3);
});

test("lr-9bcd7b CHATTINESS INVARIANT: releasing one of several concurrent tokens must NOT report a transition until the LAST one releases", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task" });
  sessionActivity.acquireToken(session, "tok-2", { source: "tool" });

  var releaseFirst = sessionActivity.releaseToken(session, "tok-1");
  assert.equal(releaseFirst.changed, false, "one of two live tokens releasing must not flip the derived boolean");
  assert.equal(sessionActivity.isSessionActive(session), true);

  var releaseLast = sessionActivity.releaseToken(session, "tok-2");
  assert.equal(releaseLast.changed, true, "the LAST live token releasing must flip the derived boolean and be the only reported transition");
  assert.equal(sessionActivity.isSessionActive(session), false);
});

test("lr-9bcd7b: re-acquiring the same token id twice (double-acquire) is idempotent and does not double-count", function () {
  var session = makeSession();
  var first = sessionActivity.acquireToken(session, "tok-1", { source: "task", label: "first" });
  var second = sessionActivity.acquireToken(session, "tok-1", { source: "task", label: "updated label" });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "re-acquiring an already-live token must not report a fresh 0->1 transition");
  assert.equal(sessionActivity.getActiveCount(session), 1, "must not double-count the same token id");
});

test("lr-9bcd7b: replaceRegistry performs a WHOLESALE replacement, never a merge (reconnect hydration, leak-resistance layer 4)", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "stale-pre-disconnect", { source: "task" });
  assert.equal(sessionActivity.isSessionActive(session), true);

  sessionActivity.replaceRegistry(session);

  assert.equal(sessionActivity.isSessionActive(session), false, "reconnect hydration must clear stale pre-disconnect tokens outright, not merge with them");
  assert.equal(sessionActivity.getActiveCount(session), 0);
});

test("lr-9bcd7b: listActiveSources reports only current-generation live tokens with their source/label", function () {
  var session = makeSession();
  sessionActivity.acquireToken(session, "tok-1", { source: "task", label: "Researching X" });
  sessionActivity.acquireToken(session, "tok-2", { source: "tool", label: "Bash" });

  var sources = sessionActivity.listActiveSources(session);
  var bySource = {};
  sources.forEach(function (s) { bySource[s.source] = s; });

  assert.equal(sources.length, 2);
  assert.equal(bySource.task.label, "Researching X");
  assert.equal(bySource.tool.label, "Bash");
});
