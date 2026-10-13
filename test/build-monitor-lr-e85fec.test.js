"use strict";

// The monitor confirms a stale verdict and writes the journal. It knows nothing
// about the UI: the offer is derived from confirmedStale() elsewhere.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createBuildMonitor } = require("../lib/build-monitor");

function assessment(state, extra) {
  return Object.assign({
    state: state, reason: state === "stale" ? "sha" : "identical", detail: "d",
    loadedBuildSha: "old", installedBuildSha: "new", loadedContentHash: "h0", installedContentHash: "h1",
  }, extra || {});
}

function inconclusive() { return assessment("inconclusive", { reason: "hash-unavailable" }); }

function harness(sequence, options) {
  var i = 0;
  var lines = [];
  var monitor = createBuildMonitor(Object.assign({
    assess: function () { return sequence[Math.min(i++, sequence.length - 1)]; },
    log: function (line) { lines.push(line); },
  }, options || {}));
  function run(n) { for (var k = 0; k < n; k++) monitor.check(); }
  function warnings() { return lines.filter(function (l) { return l.indexOf("WARNING: this process is serving STALE") === 0; }); }
  function reminders() { return lines.filter(function (l) { return l.indexOf("Still serving build") === 0; }); }
  return { monitor: monitor, lines: lines, run: run, warnings: warnings, reminders: reminders };
}

// Each row: the polls, then what is confirmed after them (an installed sha or null).
var CONFIRMATION_TABLE = [
  { name: "one stale sighting could be an install in progress", polls: [assessment("stale")], confirmed: null },
  { name: "the same build seen twice is confirmed", polls: [assessment("stale"), assessment("stale")], confirmed: "new" },
  { name: "a build that changes between sightings restarts the count",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n2" })], confirmed: null },
  { name: "stale, inconclusive, stale is not consecutive evidence",
    polls: [assessment("stale"), inconclusive(), assessment("stale")], confirmed: null },
  { name: "stale, inconclusive, stale, stale confirms",
    polls: [assessment("stale"), inconclusive(), assessment("stale"), assessment("stale")], confirmed: "new" },
  { name: "stale, adopted, stale is not consecutive evidence",
    polls: [assessment("stale"), assessment("adopted"), assessment("stale")], confirmed: null },
  { name: "a confirmed verdict survives an inconclusive poll",
    polls: [assessment("stale"), assessment("stale"), inconclusive()], confirmed: "new" },
  { name: "a confirmed verdict survives several inconclusive polls and the stale poll after",
    polls: [assessment("stale"), assessment("stale"), inconclusive(), inconclusive(), assessment("stale")], confirmed: "new" },
  { name: "adopted clears a confirmed verdict",
    polls: [assessment("stale"), assessment("stale"), assessment("adopted")], confirmed: null },
  { name: "adopted before anything stale confirms nothing", polls: [assessment("adopted"), assessment("adopted")], confirmed: null },
  { name: "a confirmed build is replaced only by another confirmed build",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
      assessment("stale", { installedBuildSha: "n2" })], confirmed: "n1" },
  { name: "another build seen twice replaces the confirmed one",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
      assessment("stale", { installedBuildSha: "n2" }), assessment("stale", { installedBuildSha: "n2" })], confirmed: "n2" },
  { name: "confirm n1; n2 once; inconclusive; n2 once leaves n2 unconfirmed and n1 shown",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
      assessment("stale", { installedBuildSha: "n2" }), inconclusive(), assessment("stale", { installedBuildSha: "n2" })], confirmed: "n1" },
  { name: "confirm n1; n2; n2 confirms n2 and replaces n1",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
      assessment("stale", { installedBuildSha: "n2" }), assessment("stale", { installedBuildSha: "n2" })], confirmed: "n2" },
  { name: "the confirmed build seen again after a single sighting of another stays confirmed",
    polls: [assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
      assessment("stale", { installedBuildSha: "n2" }), assessment("stale", { installedBuildSha: "n1" })], confirmed: "n1" },
];

CONFIRMATION_TABLE.forEach(function (row) {
  test("confirmation: " + row.name, function () {
    var h = harness(row.polls);
    h.run(row.polls.length);
    var c = h.monitor.confirmedStale();
    assert.equal(c === null ? null : c.installedBuildSha, row.confirmed);
  });
});

test("a re-confirmation after adoption warns again", function () {
  var h = harness([
    assessment("stale"), assessment("stale"), assessment("adopted"),
    assessment("stale"), assessment("stale"),
  ]);
  h.run(5);
  assert.equal(h.warnings().length, 2);
  assert.ok(h.monitor.confirmedStale());
});

test("the warning is journaled once when a streak is first confirmed, not on every check", function () {
  var h = harness([assessment("stale"), assessment("stale"), assessment("stale"), assessment("stale")]);
  h.run(1);
  assert.equal(h.warnings().length, 0, "one sighting is not confirmed");
  h.run(3);
  assert.equal(h.warnings().length, 1);
});

test("an inconclusive reason is logged once, not once per poll", function () {
  var h = harness([assessment("stale"), assessment("stale"), inconclusive(), inconclusive(), assessment("stale")]);
  h.run(5);
  var inconclusiveLines = h.lines.filter(function (l) { return l.indexOf("Build check inconclusive") === 0; });
  assert.equal(inconclusiveLines.length, 1);
  assert.ok(h.monitor.confirmedStale());
});

// Reminders come from the monitor's own counter. Row: polls after a confirmation at poll 2,
// the reminderEvery, and the poll numbers (1-based) that remind.
var REMINDER_TABLE = [
  { name: "every Nth stale poll after the confirmation", every: 3, tail: ["s", "s", "s", "s", "s", "s"], remindAt: [5, 8] },
  { name: "an inconclusive poll does not count toward a reminder", every: 3, tail: ["s", "i", "s", "s", "s"], remindAt: [6] },
  { name: "an inconclusive poll does not reset the count", every: 3, tail: ["s", "s", "i", "s"], remindAt: [6] },
  { name: "reminders are silent before the interval", every: 30, tail: ["s", "s", "s"], remindAt: [] },
];

REMINDER_TABLE.forEach(function (row) {
  test("journal reminders: " + row.name, function () {
    var polls = [assessment("stale"), assessment("stale")].concat(row.tail.map(function (t) {
      return t === "s" ? assessment("stale") : inconclusive();
    }));
    var h = harness(polls, { reminderEvery: row.every });
    var at = [];
    for (var n = 1; n <= polls.length; n++) {
      var before = h.reminders().length;
      h.run(1);
      if (h.reminders().length > before) at.push(n);
    }
    assert.deepEqual(at, row.remindAt);
  });
});
