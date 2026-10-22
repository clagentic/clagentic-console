"use strict";
// The rules of scheduled input that need no session: the time inputs (durations
// and local clock times) and the record shape with the rules that create and
// advance it.

var test = require("node:test");
var assert = require("node:assert/strict");

var { parseDuration, resolveClockTime, formatLocal } = require("../lib/cli/schedule-input-subcommands");
var records = require("../lib/scheduled-input/records");
var { KIND, STATE, LIMITS } = records;

// --- durations and clock times ---

test("a duration is a number of minutes or a run of s, m, h and d parts", function () {
  assert.equal(parseDuration("90").ms, 90 * 60000);
  assert.equal(parseDuration("10m").ms, 600000);
  assert.equal(parseDuration("2h").ms, 7200000);
  assert.equal(parseDuration("1h30m").ms, 5400000);
  assert.equal(parseDuration("45s").ms, 45000);
  assert.equal(parseDuration("1d").ms, 86400000);
  assert.equal(parseDuration(" 5M ").ms, 300000);
});

test("a malformed or zero duration is an error naming the accepted forms", function () {
  ["", "abc", "10x", "-5", "1.5h", "0", "0m", "h", undefined, null, 10].forEach(function (bad) {
    var out = parseDuration(bad);
    assert.ok(out.error, "expected an error for " + String(bad));
    assert.equal(out.ms, undefined);
  });
  assert.match(parseDuration("soon").error, /use for example/);
});

function local(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test("a clock time later today resolves to today", function () {
  var now = local(2026, 3, 1, 19, 0);
  var out = resolveClockTime("20:01", now);
  assert.equal(out.ms, local(2026, 3, 1, 20, 1));
  assert.equal(out.tomorrow, false);
});

test("a clock time already passed today resolves to tomorrow, and says so", function () {
  var now = local(2026, 3, 1, 19, 0);
  var out = resolveClockTime("18:30", now);
  assert.equal(out.ms, local(2026, 3, 2, 18, 30));
  assert.equal(out.tomorrow, true);
});

test("the current minute counts as passed", function () {
  var now = local(2026, 3, 1, 19, 0);
  var out = resolveClockTime("19:00", now);
  assert.equal(out.tomorrow, true);
  assert.equal(out.ms, local(2026, 3, 2, 19, 0));
});

test("a clock time across a month end rolls over to the next day", function () {
  var now = local(2026, 1, 31, 23, 30);
  assert.equal(resolveClockTime("08:00", now).ms, local(2026, 2, 1, 8, 0));
});

test("single-digit hours and a full local date-time are accepted", function () {
  var now = local(2026, 3, 1, 6, 0);
  assert.equal(resolveClockTime("7:05", now).ms, local(2026, 3, 1, 7, 5));
  var full = resolveClockTime("2026-03-05T09:15", now);
  assert.equal(full.ms, local(2026, 3, 5, 9, 15));
  assert.equal(full.tomorrow, false);
});

test("an invalid or past full date-time is refused; an impossible clock time too", function () {
  var now = local(2026, 3, 1, 6, 0);
  assert.match(resolveClockTime("2026-03-01T05:00", now).error, /already passed/);
  assert.match(resolveClockTime("2026-02-30T09:00", now).error, /not a date and time/);
  assert.match(resolveClockTime("24:00", now).error, /not a time of day/);
  assert.match(resolveClockTime("12:60", now).error, /not a time of day/);
  assert.match(resolveClockTime("noon", now).error, /not a time/);
});

test("formatLocal prints the unambiguous absolute local form", function () {
  assert.equal(formatLocal(local(2026, 3, 1, 9, 5)), "2026-03-01 09:05");
});

// --- the record ---

var NOW = 1700000000000;
var MIN = 60000;

function once(extra) {
  return Object.assign({ sessionId: "sess-1", kind: KIND.ONCE, text: "go", createdBy: "test", at: NOW + 10 * MIN }, extra);
}
function repeat(extra) {
  return Object.assign({ sessionId: "sess-1", kind: KIND.RECURRING, text: "go", createdBy: "test", every: 10 * MIN, count: 3 }, extra);
}
function build(spec, ctx) {
  return records.buildRecord(spec, Object.assign({ now: NOW, armedForSession: 0 }, ctx));
}

test("a once record fires at its time and starts armed", function () {
  var out = build(once());
  assert.ok(out.record);
  assert.equal(out.record.state, STATE.ARMED);
  assert.equal(out.record.nextAt, NOW + 10 * MIN);
  assert.equal(out.record.firedCount, 0);
  assert.match(out.record.id, /^si_[0-9a-f]{10}$/);
});

test("a once record with a time already past fires on the next check", function () {
  assert.equal(build(once({ at: NOW - MIN })).record.nextAt, NOW);
});

test("a once record may not be more than 366 days ahead, and takes no repeat fields", function () {
  assert.match(build(once({ at: NOW + 400 * 86400000 })).error, /366 days/);
  assert.match(build(once({ every: 10 * MIN })).error, /belong to a recurring/);
});

test("every must be between 1 minute and 24 hours", function () {
  assert.match(build(repeat({ every: 59 * 1000 })).error, /between 1 minute and 24 hours/);
  assert.match(build(repeat({ every: 24 * 60 * MIN + 1 })).error, /between 1 minute and 24 hours/);
  assert.ok(build(repeat({ every: LIMITS.MIN_EVERY_MS })).record);
  assert.ok(build(repeat({ every: LIMITS.MAX_EVERY_MS })).record);
  assert.match(build(repeat({ every: undefined })).error, /between 1 minute and 24 hours/);
});

test("a recurring record needs exactly one end", function () {
  assert.match(build(repeat({ count: undefined })).error, /exactly one of until/);
  assert.match(build(repeat({ until: NOW + 60 * MIN })).error, /exactly one of until/);
  var byCount = build(repeat());
  assert.equal(byCount.record.count, 3);
  assert.equal(byCount.record.until, null);
  var byUntil = build(repeat({ count: undefined, until: NOW + 60 * MIN }));
  assert.equal(byUntil.record.until, NOW + 60 * MIN);
  assert.equal(byUntil.record.count, null);
});

test("until before the first firing and a bad count are refused", function () {
  assert.match(build(repeat({ count: undefined, until: NOW + 5 * MIN })).error, /before the first firing/);
  assert.match(build(repeat({ count: 0 })).error, /count must be/);
  assert.match(build(repeat({ count: 1.5 })).error, /count must be/);
  assert.match(build(repeat({ count: LIMITS.MAX_COUNT + 1 })).error, /count must be/);
});

test("the first firing of a recurring record is one interval after creation", function () {
  assert.equal(build(repeat()).record.nextAt, NOW + 10 * MIN);
});

test("a sixth armed record on a session is refused; the exempt caller is not", function () {
  assert.match(build(once(), { armedForSession: LIMITS.MAX_ARMED_PER_SESSION }).error, /limit/);
  assert.ok(build(once(), { armedForSession: LIMITS.MAX_ARMED_PER_SESSION - 1 }).record);
  assert.ok(build(once(), { armedForSession: LIMITS.MAX_ARMED_PER_SESSION, exemptFromCap: true }).record);
});

test("empty text, a missing session and an unknown kind are refused", function () {
  assert.match(build(once({ text: "  " })).error, /must not be empty/);
  assert.match(build(once({ sessionId: "" })).error, /session id/);
  assert.match(build(once({ kind: "weekly" })).error, /kind must be/);
  assert.match(build(once({ text: "x".repeat(LIMITS.MAX_TEXT_CHARS + 1) })).error, /longer than/);
});

test("a once record is done after its delivery", function () {
  var rec = build(once()).record;
  records.afterDelivery(rec, NOW + 11 * MIN, "delivered");
  assert.equal(rec.state, STATE.DONE);
  assert.equal(rec.firedCount, 1);
  assert.equal(rec.nextAt, null);
  assert.equal(rec.lastOutcome, "delivered");
  assert.equal(rec.lastFiredAt, NOW + 11 * MIN);
});

test("the next firing of a recurring record is the delivery time plus every, not the planned time", function () {
  var rec = build(repeat({ count: 5 })).record;
  var late = NOW + 25 * MIN;
  records.afterDelivery(rec, late, "delivered");
  assert.equal(rec.state, STATE.ARMED);
  assert.equal(rec.nextAt, late + 10 * MIN);
});

test("a recurring record is done at its count", function () {
  var rec = build(repeat({ count: 2 })).record;
  records.afterDelivery(rec, NOW + 10 * MIN, "delivered");
  assert.equal(rec.state, STATE.ARMED);
  records.afterDelivery(rec, NOW + 20 * MIN, "delivered");
  assert.equal(rec.state, STATE.DONE);
  assert.match(rec.endReason, /2 times/);
});

test("a recurring record is done when its next firing would pass until", function () {
  var rec = build(repeat({ count: undefined, until: NOW + 25 * MIN })).record;
  records.afterDelivery(rec, NOW + 10 * MIN, "delivered");
  assert.equal(rec.state, STATE.ARMED);
  assert.equal(rec.nextAt, NOW + 20 * MIN);
  records.afterDelivery(rec, NOW + 20 * MIN, "delivered");
  assert.equal(rec.state, STATE.DONE);
  assert.equal(rec.firedCount, 2);
});

test("a recurring record found past its end time is not fired late", function () {
  var rec = build(repeat({ count: undefined, until: NOW + 25 * MIN })).record;
  assert.equal(records.pastItsEnd(rec, NOW + 25 * MIN), false);
  assert.equal(records.pastItsEnd(rec, NOW + 26 * MIN), true);
  assert.equal(records.pastItsEnd(build(once()).record, NOW + 9999 * MIN), false);
});

test("a summary leaves out the full text and carries what a list shows", function () {
  var rec = build(once({ text: "y".repeat(500) })).record;
  var s = records.summarize(rec);
  assert.ok(s.preview.length < 100);
  assert.equal(s.kind, KIND.ONCE);
  assert.equal(s.at, NOW + 10 * MIN);
  assert.equal(s.every, null);
  assert.equal("text" in s, false);
});

// --- which session a record names ---

test("a session with a vendor id is named by it; one without, by the console id", function () {
  assert.deepEqual(records.targetOf({ localId: 4, cliSessionId: "vendor-4" }), { sessionId: "vendor-4", sessionIdKind: "vendor" });
  assert.deepEqual(records.targetOf({ localId: 4 }), { sessionId: "4", sessionIdKind: "console" });
});

test("a record belongs to exactly the session it names", function () {
  var byVendor = { sessionId: "vendor-4", sessionIdKind: "vendor" };
  var byConsole = { sessionId: "4", sessionIdKind: "console" };
  assert.equal(records.recordIsFor(byVendor, { localId: 9, cliSessionId: "vendor-4" }), true);
  assert.equal(records.recordIsFor(byVendor, { localId: 4, cliSessionId: "vendor-other" }), false, "the console id is not consulted for a vendor-bound record");
  assert.equal(records.recordIsFor(byVendor, { localId: 4 }), false);
  assert.equal(records.recordIsFor(byConsole, { localId: 4 }), true);
  assert.equal(records.recordIsFor(byConsole, { localId: 5 }), false);
});
