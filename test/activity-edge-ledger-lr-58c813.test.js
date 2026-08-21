// activity-edge-ledger-lr-58c813.test.js
//
// lr-58c813: accept/reject ledger for shouldApplyActivityEdge, and a
// SEPARATE count for the fail-open branch (msgLocalId == null). This is
// instrumentation only — it must observe the SAME decision app-messages.js's
// status/done/auth_required handlers already make, never a second,
// independently-computed decision.
//
// Per lib/public/modules/activity-latch.js's own module-load hazard (see
// test/activity-latch-lr-96e7da.test.js header comment), activity-latch.js
// is DOM-free and importable directly in plain Node; app-messages.js is not
// (deep import chain reaches theme.js/markdown.js's circular-import boot
// hazard). This file therefore:
//   1. Proves recordActivityEdgeDecision/getActivityEdgeLedger are correct,
//      pure bookkeeping (sections 1-2).
//   2. Source-inspects (this suite's own established convention, see
//      activity-latch-lr-96e7da.test.js section 4) that app-messages.js
//      actually calls recordActivityEdgeDecision at its three call sites,
//      with the SAME shouldApplyActivityEdge result it already computed —
//      not a second, reimplemented check (section 3).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var LATCH_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "activity-latch.js")
).href;

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

function stripLineComments(src) {
  return src
    .split("\n")
    .map(function (line) {
      var idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

var latch;

test("activity-latch.js exports the ledger functions", { timeout: 10000 }, function () {
  return import(LATCH_URL).then(function (mod) {
    latch = mod;
    assert.strictEqual(typeof latch.recordActivityEdgeDecision, "function");
    assert.strictEqual(typeof latch.getActivityEdgeLedger, "function");
    assert.strictEqual(typeof latch._resetActivityEdgeLedgerForTest, "function");
  });
});

// ---------------------------------------------------------------------------
// 1. Pure bookkeeping correctness
// ---------------------------------------------------------------------------

test("recordActivityEdgeDecision: an accepted edge with a real localId increments accepted only", function () {
  latch._resetActivityEdgeLedgerForTest();
  latch.recordActivityEdgeDecision("status", "sess-A", "sess-A", true);
  var ledger = latch.getActivityEdgeLedger();
  assert.equal(ledger.accepted, 1);
  assert.equal(ledger.rejected, 0);
  assert.equal(ledger.acceptedFailOpen, 0, "a real localId match is not the fail-open branch");
});

test("recordActivityEdgeDecision: a rejected (cross-session) edge increments rejected only", function () {
  latch._resetActivityEdgeLedgerForTest();
  latch.recordActivityEdgeDecision("done", "sess-B", "sess-A", false);
  var ledger = latch.getActivityEdgeLedger();
  assert.equal(ledger.accepted, 0);
  assert.equal(ledger.rejected, 1);
  assert.equal(ledger.acceptedFailOpen, 0);
});

test("recordActivityEdgeDecision: an accepted edge with msgLocalId == null is counted in BOTH accepted and acceptedFailOpen — the highest-value number per the task spec, visible separately from the general accept count", function () {
  latch._resetActivityEdgeLedgerForTest();
  latch.recordActivityEdgeDecision("status", null, "sess-A", true);
  latch.recordActivityEdgeDecision("auth_required", undefined, "sess-A", true);
  var ledger = latch.getActivityEdgeLedger();
  assert.equal(ledger.accepted, 2);
  assert.equal(ledger.acceptedFailOpen, 2, "both null and undefined localId must count as fail-open");
  assert.equal(ledger.rejected, 0);
});

test("recordActivityEdgeDecision: fail-open count is NOT folded silently into the general accept count without being separately readable", function () {
  latch._resetActivityEdgeLedgerForTest();
  latch.recordActivityEdgeDecision("status", "sess-A", "sess-A", true);  // normal accept
  latch.recordActivityEdgeDecision("status", null, "sess-A", true);      // fail-open accept
  latch.recordActivityEdgeDecision("done", "sess-B", "sess-A", false);   // reject
  var ledger = latch.getActivityEdgeLedger();
  assert.equal(ledger.accepted, 2, "total accepted includes both the normal and fail-open accept");
  assert.equal(ledger.acceptedFailOpen, 1, "fail-open subset must be separately visible, not just folded into accepted");
  assert.equal(ledger.rejected, 1);
});

test("getActivityEdgeLedger: returns a snapshot, not a live reference (mutating the returned object must not affect the internal ledger)", function () {
  latch._resetActivityEdgeLedgerForTest();
  latch.recordActivityEdgeDecision("status", "sess-A", "sess-A", true);
  var snap = latch.getActivityEdgeLedger();
  snap.accepted = 9999;
  var ledger2 = latch.getActivityEdgeLedger();
  assert.equal(ledger2.accepted, 1, "returned snapshot must be a copy, not the live counter object");
});

// ---------------------------------------------------------------------------
// 2. Bounded by construction: four integers total, no per-event array — this
//    module doubles as the shape assertion for "counters, not a log stream"
//    (task spec: "log volume is a real risk ... Bound it").
// ---------------------------------------------------------------------------

test("the ledger is a fixed-shape counter object, not an unbounded per-event array", function () {
  latch._resetActivityEdgeLedgerForTest();
  for (var i = 0; i < 500; i++) {
    latch.recordActivityEdgeDecision("status", i % 2 === 0 ? "sess-A" : null, "sess-A", true);
  }
  var ledger = latch.getActivityEdgeLedger();
  assert.equal(Object.keys(ledger).length, 3, "ledger must stay a fixed 3-field counter object regardless of event volume");
  assert.equal(ledger.accepted, 500);
});

// ---------------------------------------------------------------------------
// 3. Source-inspection (this suite's own established convention, see
//    activity-latch-lr-96e7da.test.js section 4): app-messages.js's three
//    call sites record the SAME decision they already computed, not a
//    second reimplemented check.
// ---------------------------------------------------------------------------

test("CI invariant: app-messages.js imports recordActivityEdgeDecision from activity-latch.js and calls it at least 3 times (status, done, auth_required)", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\brecordActivityEdgeDecision\b[^}]*\}\s*from\s*['"]\.\/activity-latch\.js['"]/,
    "app-messages.js must import recordActivityEdgeDecision from activity-latch.js"
  );
  var occurrences = src.match(/recordActivityEdgeDecision\(/g) || [];
  assert.ok(
    occurrences.length >= 3,
    "expected recordActivityEdgeDecision(...) to be called at least 3 times (status, done, auth_required handlers) — found " + occurrences.length
  );
});

test("CI invariant: shouldApplyActivityEdge is still called at least 3 times too — the ledger must not have REPLACED the real decision with only a recorded one", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  var occurrences = src.match(/shouldApplyActivityEdge\(/g) || [];
  assert.ok(
    occurrences.length >= 3,
    "the real gating decision (shouldApplyActivityEdge) must remain — found " + occurrences.length
  );
});
