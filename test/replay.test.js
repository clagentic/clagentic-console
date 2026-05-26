// Tests for session replay boundary logic.
// Exercises findLastTurnStart behaviour without requiring a live server or WS.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inline the logic under test so this test has no import-side-effects from
// sessions.js (which requires sendTo / ws bindings at module load time).
// The functions are pure and match the production implementation exactly.
// ---------------------------------------------------------------------------

var HISTORY_PAGE_SIZE = 100;

function findLastTurnStart(history) {
  var searchFloor = Math.max(0, history.length - HISTORY_PAGE_SIZE);
  for (var i = history.length - 1; i >= searchFloor; i--) {
    if (history[i] && history[i].type === "user_message") return i;
  }
  return searchFloor;
}

// Simulate replayHistory's fromIndex selection (the part that changed).
function selectFromIndex(history) {
  var total = history.length;
  if (total <= HISTORY_PAGE_SIZE) return 0;
  var hardFloor = Math.max(0, total - HISTORY_PAGE_SIZE);
  var lastTurn = findLastTurnStart(history);
  return Math.max(hardFloor, lastTurn);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHistory(length, userMessageIndices) {
  return Array.from({ length }, (_, i) => ({
    type: userMessageIndices.includes(i) ? "user_message" : "assistant_delta",
    content: "x",
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("short session (<=PAGE_SIZE): fromIndex is 0", () => {
  var h = makeHistory(50, [0, 20]);
  assert.equal(selectFromIndex(h), 0);
});

test("exactly PAGE_SIZE: fromIndex is 0", () => {
  var h = makeHistory(100, [0, 50]);
  assert.equal(selectFromIndex(h), 0);
});

test("lore-session shape: last user_message near end → tiny replay window", () => {
  // Mirrors the production lore session:
  // 5116 events, user_message indices at [1, 468, 1451, 5046].
  // Before fix: replayHistory returned index 1451 → 3665 events.
  // After fix:  findLastTurnStart finds 5046 → 70 events.
  var h = makeHistory(5116, [1, 468, 1451, 5046]);
  var from = selectFromIndex(h);
  assert.equal(from, 5046, "should start at the last user_message index");
  var replayCount = h.length - from;
  assert.ok(replayCount <= HISTORY_PAGE_SIZE,
    `replay window ${replayCount} should be <= ${HISTORY_PAGE_SIZE}`);
});

test("last user_message is beyond hardFloor → hardFloor wins", () => {
  // Edge case: last user_message is at index 0 (very old).
  // hardFloor = 5016, lastTurn = 0 → max(5016, 0) = 5016.
  var h = makeHistory(5116, [0]);
  var from = selectFromIndex(h);
  assert.equal(from, 5116 - HISTORY_PAGE_SIZE);
});

test("last user_message exactly at hardFloor", () => {
  // user_message sits at exactly total - PAGE_SIZE.
  var total = 200;
  var floor = total - HISTORY_PAGE_SIZE; // 100
  var h = makeHistory(total, [floor]);
  var from = selectFromIndex(h);
  // findLastTurnStart scans from 199 down to 100 — hits at 100.
  // max(100, 100) = 100.
  assert.equal(from, floor);
});

test("no user_message in window → hard-cap at floor", () => {
  // All user_messages are outside the search window (before the floor).
  var total = 300;
  var floor = total - HISTORY_PAGE_SIZE; // 200
  var h = makeHistory(total, [10, 50]); // both below floor
  var from = selectFromIndex(h);
  assert.equal(from, floor);
});

test("multiple user_messages in window → picks the LAST one", () => {
  var total = 200;
  // floor = 100; user_messages at 110 and 160 → should pick 160.
  var h = makeHistory(total, [110, 160]);
  var from = selectFromIndex(h);
  assert.equal(from, 160);
});
