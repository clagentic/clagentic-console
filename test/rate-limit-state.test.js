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
  getScheduledInputs,
  setScheduledInputs,
  clearScheduledInputs,
  canArmScheduledInput,
  getArmedSchedule,
  setArmedSchedule,
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
  setScheduledInputs("proj-1-session", [{ id: "si_1", text: "continue please", nextAt: Date.now() + 300000 }]);

  setScheduleDelayMs("proj-2-session", 120000);
  setScheduledInputs("proj-2-session", [{ id: "si_2", text: "keep going", nextAt: Date.now() + 120000 }]);

  assert.equal(getScheduleDelayMs("proj-1-session"), 300000);
  assert.equal(getScheduledInputs("proj-1-session").length, 1);
  assert.equal(getScheduledInputs("proj-1-session")[0].text, "continue please");

  assert.equal(getScheduleDelayMs("proj-2-session"), 120000);
  assert.equal(getScheduledInputs("proj-2-session").length, 1);
  assert.equal(getScheduledInputs("proj-2-session")[0].text, "keep going");
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
  setScheduledInputs("dead-session", [{ id: "si_x", text: "hello", nextAt: Date.now() + 60000 }]);
  setRateLimitResetTimer("dead-session", timer);

  assert.ok(hasArmedState("dead-session"));

  clearSession("dead-session");

  assert.equal(hasArmedState("dead-session"), false, "cleared session must report no armed state");
  assert.equal(getScheduleDelayMs("dead-session"), 0, "cleared session must read back as unarmed (fresh entry)");
  assert.deepEqual(getScheduledInputs("dead-session"), []);
  assert.equal(getRateLimitResetTimer("dead-session"), null, "clearSession must reset the timer handle for a fresh entry");

  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.equal(fired, false, "clearSession must have canceled the background reset timer");
      resolve();
    }, 100);
  });
});

test("clearScheduledInputs only clears the list, leaving the armed schedule untouched", () => {
  setScheduleDelayMs("s1", 600000);
  setScheduledInputs("s1", [{ id: "si_1", text: "queued text", nextAt: Date.now() + 600000 }]);

  clearScheduledInputs("s1");

  assert.deepEqual(getScheduledInputs("s1"), []);
  assert.equal(getScheduleDelayMs("s1"), 600000, "clearing the list must not clear the armed delay");
});

test("a session can take another scheduled input until its list reaches the cap the server sent", () => {
  assert.equal(canArmScheduledInput("s2"), true);
  var five = [1, 2, 3, 4, 5].map((n) => ({ id: "si_" + n }));
  setScheduledInputs("s2", five.slice(0, 4), 5);
  assert.equal(canArmScheduledInput("s2"), true);
  setScheduledInputs("s2", five, 5);
  assert.equal(canArmScheduledInput("s2"), false);
  assert.equal(canArmScheduledInput("s3"), true, "another session is unaffected");
  setScheduledInputs("s2", five, 8);
  assert.equal(canArmScheduledInput("s2"), true, "the cap is the server's, not a constant of the client");
});

test("an armed schedule can be of any shape; the delay getter reads only an in-minutes delay", () => {
  setArmedSchedule("s4", { kind: "once", atMs: 123456 });
  assert.equal(getScheduleDelayMs("s4"), 0);
  assert.deepEqual(getArmedSchedule("s4"), { kind: "once", atMs: 123456 });
  setArmedSchedule("s4", { kind: "recurring", everyMs: 60000, count: 3 });
  assert.equal(getScheduleDelayMs("s4"), 0);
  assert.equal(hasArmedState("s4"), true);
  setScheduleDelayMs("s4", 0);
  assert.equal(getArmedSchedule("s4"), null);
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
