// Tests for the pendingNavigate peek/consume contract in filebrowser.js.
//
// Background: history_meta must inspect the pending nav target without
// consuming it (peekPendingNavigate), so that history_done can later consume
// it exactly once (getPendingNavigate). The bug (lr-a3ca) was three calls to
// getPendingNavigate() in the history_meta branch — the second returned null,
// causing a `null.toolId` TypeError and losing the nav target before
// history_done could act on it.
//
// These tests inline the peek/consume state machine from filebrowser.js so
// they have no import-side-effects from the browser module (which requires DOM
// bindings at load time). The implementation is a verbatim copy of the
// production logic — if it drifts, the functions here should be updated to
// match.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inline the pendingNavigate state machine (matches filebrowser.js exactly)
// ---------------------------------------------------------------------------

function makePendingNavigateState() {
  var pendingNavigate = null;

  function setPendingNavigate(nav) {
    pendingNavigate = nav;
  }

  // Non-consuming read — mirrors export function peekPendingNavigate()
  function peekPendingNavigate() {
    return pendingNavigate;
  }

  // Consuming read — mirrors export function getPendingNavigate()
  function getPendingNavigate() {
    var nav = pendingNavigate;
    pendingNavigate = null;
    return nav;
  }

  return { setPendingNavigate, peekPendingNavigate, getPendingNavigate };
}

// ---------------------------------------------------------------------------
// Simulate the history_meta / history_done interaction pattern
// ---------------------------------------------------------------------------

// Simulates the history_meta branch: peeks without consuming.
// If calledWithGet=true, exercises the pre-fix bug (three getPendingNavigate
// calls — second returns null, causing TypeError on .toolId access).
function simulateHistoryMeta(state, calledWithGet) {
  var nav;
  if (calledWithGet) {
    // Buggy path: consume on every read — second call returns null
    nav = state.getPendingNavigate();
    // The bug: a second access was made in the same condition block
    var navAgain = state.getPendingNavigate(); // returns null
    if (!navAgain || !(navAgain.toolId || navAgain.assistantUuid)) {
      // Third access that would TypeError: navAgain.toolId above already
      // threw in production, but here navAgain is null so we can't access it.
      // We use a guard so the test harness doesn't crash before the assertion.
    }
  } else {
    // Fixed path: peek, do not consume
    nav = state.peekPendingNavigate();
    if (!nav || !(nav.toolId || nav.assistantUuid)) {
      // arm sticky-bottom (no-op in test context)
    }
  }
  return nav;
}

// Simulates the history_done branch: consumes once.
function simulateHistoryDone(state) {
  return state.getPendingNavigate();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("peekPendingNavigate returns the nav object without consuming it", () => {
  var state = makePendingNavigateState();
  var nav = { sessionLocalId: "s1", assistantUuid: "u1", toolId: "t1" };
  state.setPendingNavigate(nav);

  var first = state.peekPendingNavigate();
  var second = state.peekPendingNavigate();

  assert.deepEqual(first, nav, "first peek should return the nav object");
  assert.deepEqual(second, nav, "second peek should return the same object (not consumed)");
});

test("getPendingNavigate returns the nav object and clears it", () => {
  var state = makePendingNavigateState();
  var nav = { sessionLocalId: "s2", assistantUuid: "u2", toolId: "t2" };
  state.setPendingNavigate(nav);

  var first = state.getPendingNavigate();
  var second = state.getPendingNavigate();

  assert.deepEqual(first, nav, "first get should return the nav object");
  assert.equal(second, null, "second get should return null (already consumed)");
});

test("peek does not affect subsequent get — nav survives history_meta and is consumed by history_done", () => {
  var state = makePendingNavigateState();
  var nav = { sessionLocalId: "s3", assistantUuid: "u3", toolId: "t3" };
  state.setPendingNavigate(nav);

  // history_meta runs: peek, no consume
  var metaNav = simulateHistoryMeta(state, false /* fixed path */);
  assert.deepEqual(metaNav, nav, "history_meta (peek) should see the nav target");

  // nav must still be available after history_meta
  var stillThere = state.peekPendingNavigate();
  assert.deepEqual(stillThere, nav, "nav must survive history_meta (not consumed)");

  // history_done consumes it
  var doneNav = simulateHistoryDone(state);
  assert.deepEqual(doneNav, nav, "history_done should receive the nav target");

  // consumed — nothing left
  var afterDone = state.getPendingNavigate();
  assert.equal(afterDone, null, "nav should be null after history_done consumes it");
});

test("regression: buggy triple-get in history_meta clears nav before history_done", () => {
  var state = makePendingNavigateState();
  var nav = { sessionLocalId: "s4", assistantUuid: "u4", toolId: "t4" };
  state.setPendingNavigate(nav);

  // Buggy path: getPendingNavigate called in history_meta (consumes on first call)
  simulateHistoryMeta(state, true /* buggy path */);

  // nav is now gone because the first getPendingNavigate() consumed it
  var doneNav = simulateHistoryDone(state);
  assert.equal(doneNav, null,
    "with buggy get-in-meta, history_done receives null (nav was consumed early)");
});

test("peekPendingNavigate on empty state returns null", () => {
  var state = makePendingNavigateState();
  assert.equal(state.peekPendingNavigate(), null);
});

test("getPendingNavigate on empty state returns null", () => {
  var state = makePendingNavigateState();
  assert.equal(state.getPendingNavigate(), null);
});
