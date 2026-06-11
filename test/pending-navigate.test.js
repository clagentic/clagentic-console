// Regression tests for the pendingNavigate peek/consume contract (lr-a3ca).
//
// Background: history_meta must inspect the pending nav target WITHOUT
// consuming it (peekPendingNavigate), so that history_done can later consume
// it exactly once (getPendingNavigate).
//
// The bug (before the fix) was three calls to getPendingNavigate() in the
// history_meta branch of app-messages.js:
//   if (!getPendingNavigate() || !(getPendingNavigate().toolId || getPendingNavigate().assistantUuid))
// First call returned the nav and cleared pendingNavigate.  Second call
// returned null → null.toolId TypeError in the WS onmessage handler.
// history_done then received null and never navigated.
//
// The fix: history_meta uses peekPendingNavigate() (non-consuming); only
// history_done calls the consuming getPendingNavigate().
//
// These tests import the real lib/public/modules/pending-navigate.js — the
// DOM-free module that filebrowser.js imports its peek/get implementations
// from.  If pending-navigate.js reverts peekPendingNavigate to a consuming
// read, the "peek does not consume" and "nav survives history_meta" tests fail.

import { test } from "node:test";
import assert from "node:assert/strict";

// Node can import ESM modules directly.  pending-navigate.js has no DOM deps.
// We append a cache-busting query param so each test file invocation gets a
// fresh module instance; within a single test run the module is loaded once and
// state is reset manually between tests using the exported clearPendingNavigate.
import {
  setPendingNavigate,
  clearPendingNavigate,
  peekPendingNavigate,
  getPendingNavigate,
} from "../lib/public/modules/pending-navigate.js";

// Reset state before each test by clearing any leftover nav target.
function reset() { clearPendingNavigate(); }

test("peekPendingNavigate returns the nav object without consuming it", () => {
  reset();
  const nav = { sessionLocalId: "s1", assistantUuid: "u1", toolId: "t1" };
  setPendingNavigate(nav);

  const first = peekPendingNavigate();
  const second = peekPendingNavigate();

  assert.deepEqual(first, nav, "first peek returns nav");
  assert.deepEqual(second, nav, "second peek returns same object (non-consuming)");
  reset();
});

test("getPendingNavigate returns the nav object and clears it", () => {
  reset();
  const nav = { sessionLocalId: "s2", assistantUuid: "u2", toolId: "t2" };
  setPendingNavigate(nav);

  const first = getPendingNavigate();
  const second = getPendingNavigate();

  assert.deepEqual(first, nav, "first get returns nav");
  assert.equal(second, null, "second get returns null (consumed)");
});

test("peek does not consume — nav survives history_meta and is available for history_done", () => {
  reset();
  const nav = { sessionLocalId: "s3", assistantUuid: "u3", toolId: "t3" };
  setPendingNavigate(nav);

  // Simulate the FIXED history_meta branch: peek, no consume
  const metaNav = peekPendingNavigate();
  assert.deepEqual(metaNav, nav, "history_meta (peek) sees the nav target");

  // Nav must still be available after history_meta
  assert.deepEqual(peekPendingNavigate(), nav, "nav survives history_meta (non-consuming)");

  // Simulate history_done: consume once
  const doneNav = getPendingNavigate();
  assert.deepEqual(doneNav, nav, "history_done receives the nav target");
  assert.equal(getPendingNavigate(), null, "nav is null after history_done consumes it");
});

test("regression: consuming get in history_meta clears nav before history_done (pre-fix bug)", () => {
  reset();
  const nav = { sessionLocalId: "s4", assistantUuid: "u4", toolId: "t4" };
  setPendingNavigate(nav);

  // Simulate the BUGGY history_meta: getPendingNavigate() called twice
  // (matches the original `!getPendingNavigate() || !(getPendingNavigate().toolId ...)`)
  const first = getPendingNavigate();  // consumes nav
  const second = getPendingNavigate(); // returns null — this was .toolId accessed → TypeError
  assert.deepEqual(first, nav);
  assert.equal(second, null, "second consuming get returns null — the bug");

  // history_done now gets null because the bug consumed nav too early
  assert.equal(getPendingNavigate(), null, "history_done receives null when nav consumed in history_meta");
});

test("clearPendingNavigate resets state (used by resetFileBrowser)", () => {
  setPendingNavigate({ sessionLocalId: "s5" });
  clearPendingNavigate();
  assert.equal(getPendingNavigate(), null, "clearPendingNavigate empties the state");
});

test("peekPendingNavigate on empty state returns null", () => {
  reset();
  assert.equal(peekPendingNavigate(), null);
});

test("getPendingNavigate on empty state returns null", () => {
  reset();
  assert.equal(getPendingNavigate(), null);
});
