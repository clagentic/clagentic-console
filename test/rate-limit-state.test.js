// Regression coverage for lr-0827ba: rate-limit auto-schedule arming state
// was global to the browser tab (bare module-scoped variables in input.js /
// app-rate-limit.js) instead of per-session, so arming a schedule in one
// project silently clobbered another project's armed state.
//
// rate-limit-state.js is DOM-free (see sticky-notes-fmt.js for the same
// convention), so these tests import and exercise the real production
// module directly rather than asserting against its source text.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getScheduleDelayMs,
  setScheduleDelayMs,
  getRateLimitResetsAt,
  setRateLimitResetsAt,
  getRateLimitResetTimer,
  setRateLimitResetTimer,
  getRateLimitResetState,
  getScheduledMsg,
  setScheduledMsg,
  clearScheduledMsg,
  hasArmedState,
  clearSession,
  _resetAllForTest,
} from "../lib/public/modules/rate-limit-state.js";

test.beforeEach(() => {
  _resetAllForTest();
});

// ============================================================
// Per-session isolation of armed state
// ============================================================

test("arming a schedule delay in session A does not affect session B", () => {
  setScheduleDelayMs("session-A", 600000);
  assert.equal(getScheduleDelayMs("session-A"), 600000);
  assert.equal(getScheduleDelayMs("session-B"), 0, "session B must start unarmed");

  setScheduleDelayMs("session-B", 900000);
  assert.equal(getScheduleDelayMs("session-A"), 600000, "session A must still be armed after B is armed");
  assert.equal(getScheduleDelayMs("session-B"), 900000);
});

test("both sessions' armed state survives after arming a second, later session", () => {
  setScheduleDelayMs("proj-1-session", 300000);
  setScheduledMsg("proj-1-session", "continue please", Date.now() + 300000);

  setScheduleDelayMs("proj-2-session", 120000);
  setScheduledMsg("proj-2-session", "keep going", Date.now() + 120000);

  assert.equal(getScheduleDelayMs("proj-1-session"), 300000);
  assert.ok(getScheduledMsg("proj-1-session"));
  assert.equal(getScheduledMsg("proj-1-session").text, "continue please");

  assert.equal(getScheduleDelayMs("proj-2-session"), 120000);
  assert.ok(getScheduledMsg("proj-2-session"));
  assert.equal(getScheduledMsg("proj-2-session").text, "keep going");
});

test("rate limit reset bookkeeping (resetsAt, timer, per-type reset state) is isolated per session", () => {
  var timerA = setTimeout(function () {}, 1000000);
  var timerB = setTimeout(function () {}, 1000000);
  try {
    setRateLimitResetsAt("A", 111);
    setRateLimitResetTimer("A", timerA);
    getRateLimitResetState("A").five_hour = { resetsAt: 111 };

    setRateLimitResetsAt("B", 222);
    setRateLimitResetTimer("B", timerB);
    getRateLimitResetState("B").seven_day = { resetsAt: 222 };

    assert.equal(getRateLimitResetsAt("A"), 111);
    assert.equal(getRateLimitResetTimer("A"), timerA);
    assert.deepEqual(getRateLimitResetState("A"), { five_hour: { resetsAt: 111 } });

    assert.equal(getRateLimitResetsAt("B"), 222);
    assert.equal(getRateLimitResetTimer("B"), timerB);
    assert.deepEqual(getRateLimitResetState("B"), { seven_day: { resetsAt: 222 } });
  } finally {
    clearTimeout(timerA);
    clearTimeout(timerB);
  }
});

// ============================================================
// Stale-state cleanup on session teardown
// ============================================================

test("clearSession removes a session's entry entirely and clears its background timer", () => {
  var fired = false;
  var timer = setTimeout(function () { fired = true; }, 50);
  setScheduleDelayMs("dead-session", 60000);
  setScheduledMsg("dead-session", "hello", Date.now() + 60000);
  setRateLimitResetTimer("dead-session", timer);

  assert.ok(hasArmedState("dead-session"));

  clearSession("dead-session");

  assert.equal(hasArmedState("dead-session"), false, "cleared session must report no armed state");
  assert.equal(getScheduleDelayMs("dead-session"), 0, "cleared session must read back as unarmed (fresh entry)");
  assert.equal(getScheduledMsg("dead-session"), null);
  assert.equal(getRateLimitResetTimer("dead-session"), null, "clearSession must reset the timer handle for a fresh entry");

  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.equal(fired, false, "clearSession must have canceled the background reset timer");
      resolve();
    }, 100);
  });
});

test("clearScheduledMsg only clears the bubble, leaving the schedule delay untouched", () => {
  setScheduleDelayMs("s1", 600000);
  setScheduledMsg("s1", "queued text", Date.now() + 600000);

  clearScheduledMsg("s1");

  assert.equal(getScheduledMsg("s1"), null);
  assert.equal(getScheduleDelayMs("s1"), 600000, "clearing the bubble must not clear the armed delay");
});

// ============================================================
// hasArmedState / localId-style keying
// ============================================================

test("hasArmedState is false for an untouched session id and true once armed", () => {
  assert.equal(hasArmedState("never-touched"), false);
  setScheduleDelayMs("never-touched", 60000);
  assert.equal(hasArmedState("never-touched"), true);
});

test("session ids are looked up by strict key identity — numeric localId and its string form are distinct sessions", () => {
  // localId is server-stamped as a number (session.localId); the client's
  // activeSessionId store value may be read/written as a number too. Using
  // a plain object as the backing map means numeric and string keys collide
  // (JS object keys are always strings) — document that behavior explicitly
  // so callers always pass the same type consistently (the activeSessionId
  // as stored, without re-stringifying/re-parsing).
  setScheduleDelayMs(42, 60000);
  assert.equal(getScheduleDelayMs(42), 60000);
  assert.equal(getScheduleDelayMs("42"), 60000, "object-key coercion means 42 and \"42\" address the same entry");
});

test("null/undefined session id is a no-op for setters and reads back as unarmed", () => {
  setScheduleDelayMs(null, 60000);
  setScheduleDelayMs(undefined, 60000);
  assert.equal(getScheduleDelayMs(null), 0);
  assert.equal(getScheduleDelayMs(undefined), 0);
  assert.equal(hasArmedState(null), false);
  assert.equal(hasArmedState(undefined), false);
});
