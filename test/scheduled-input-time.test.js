"use strict";
// The time inputs of a scheduled input: durations and local clock times.

var test = require("node:test");
var assert = require("node:assert/strict");

var { parseDuration, resolveClockTime, formatLocal } = require("../lib/scheduled-input/time");

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
