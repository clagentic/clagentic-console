"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var { createBuildMonitor } = require("../lib/build-monitor");

function assessment(state, extra) {
  return Object.assign({
    state: state, reason: state === "stale" ? "sha" : "identical", detail: "d",
    loadedBuildSha: "old", installedBuildSha: "new", loadedContentHash: "h0", installedContentHash: "h1",
  }, extra || {});
}

function harness(sequence, options) {
  var i = 0;
  var events = [];
  var monitor = createBuildMonitor(Object.assign({
    assess: function () { return sequence[Math.min(i++, sequence.length - 1)]; },
    onStale: function (a) { events.push("stale:" + a.installedBuildSha); },
    onAdopted: function () { events.push("adopted"); },
    log: function (line) { events.push("log:" + line.split(" ")[0]); },
  }, options || {}));
  return { monitor: monitor, events: events };
}

test("a stale verdict is announced only after the same build is seen twice", function () {
  var h = harness([assessment("stale"), assessment("stale"), assessment("stale")]);
  h.monitor.check();
  assert.deepEqual(h.events, [], "one sighting could be an install in progress");
  assert.equal(h.monitor.isConfirmedStale(), false);
  h.monitor.check();
  assert.deepEqual(h.events, ["stale:new"]);
  h.monitor.check();
  assert.deepEqual(h.events, ["stale:new"], "announced once per installed build");
  assert.equal(h.monitor.isConfirmedStale(), true);
});

test("a build that changes between sightings restarts the count", function () {
  var h = harness([assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n2" }), assessment("stale", { installedBuildSha: "n2" })]);
  h.monitor.check();
  h.monitor.check();
  assert.deepEqual(h.events, []);
  h.monitor.check();
  assert.deepEqual(h.events, ["stale:n2"]);
});

test("a newer build after an announcement is announced again", function () {
  var h = harness([
    assessment("stale", { installedBuildSha: "n1" }), assessment("stale", { installedBuildSha: "n1" }),
    assessment("stale", { installedBuildSha: "n2" }), assessment("stale", { installedBuildSha: "n2" }),
  ]);
  for (var i = 0; i < 4; i++) h.monitor.check();
  assert.deepEqual(h.events, ["stale:n1", "stale:n2"]);
});

test("adopted withdraws the announcement and re-arms it", function () {
  var h = harness([
    assessment("stale"), assessment("stale"), assessment("adopted"),
    assessment("stale"), assessment("stale"),
  ]);
  for (var i = 0; i < 5; i++) h.monitor.check();
  assert.deepEqual(h.events, ["stale:new", "adopted", "stale:new"]);
});

test("adopted before any announcement says nothing", function () {
  var h = harness([assessment("adopted"), assessment("adopted")]);
  h.monitor.check();
  h.monitor.check();
  assert.deepEqual(h.events, []);
  assert.equal(h.monitor.isConfirmedStale(), false);
});

test("inconclusive neither announces nor withdraws, and is logged once per reason", function () {
  var inconclusive = assessment("inconclusive", { reason: "hash-unavailable" });
  var h = harness([assessment("stale"), assessment("stale"), inconclusive, inconclusive, assessment("stale")]);
  for (var i = 0; i < 5; i++) h.monitor.check();
  assert.deepEqual(h.events, ["stale:new", "log:Build"], "one log line for the reason, no second announcement for the same build");
  assert.equal(h.monitor.isConfirmedStale(), true);
});

test("stale, inconclusive, stale is not two consecutive sightings: no announcement", function () {
  var h = harness([assessment("stale"), assessment("inconclusive", { reason: "hash-unavailable" }), assessment("stale")]);
  for (var i = 0; i < 3; i++) h.monitor.check();
  assert.deepEqual(h.events.filter(function (e) { return e.indexOf("stale:") === 0; }), []);
  assert.equal(h.monitor.isConfirmedStale(), false);
  // Two stale sightings in a row after the gap do announce.
  var again = harness([assessment("stale"), assessment("inconclusive", { reason: "hash-unavailable" }), assessment("stale"), assessment("stale")]);
  for (var j = 0; j < 4; j++) again.monitor.check();
  assert.deepEqual(again.events.filter(function (e) { return e.indexOf("stale:") === 0; }), ["stale:new"]);
});

test("stale, adopted, stale is not two consecutive sightings either", function () {
  var h = harness([assessment("stale"), assessment("adopted"), assessment("stale")]);
  for (var i = 0; i < 3; i++) h.monitor.check();
  assert.deepEqual(h.events, []);
});

test("stale, change list in flight, inconclusive, stale again: an offer is visible", async function () {
  var { createStandingOffer } = require("../lib/build-update-standing");
  var sequence = [
    assessment("stale"), assessment("stale"), // confirmed: announced, change list read starts
    assessment("inconclusive", { reason: "hash-unavailable" }),
    assessment("stale"), assessment("stale"), // confirmed again
  ];
  var i = 0;
  var latest = null;
  var sent = [];
  var reads = [];
  var offer = createStandingOffer({
    listChanges: function () { return new Promise(function (resolve) { reads.push(resolve); }); },
    currentAssessment: function () { return latest; },
    broadcast: function (m) { sent.push(m); },
    compose: function (a, changes) { return { type: "diagnostic", changes: changes, actionable: { action: "restart_for_build_update" } }; },
  });
  var announces = [];
  var monitor = createBuildMonitor({
    assess: function () { latest = sequence[Math.min(i++, sequence.length - 1)]; return latest; },
    onStale: function (a) { announces.push(offer.announce(a)); },
    isOfferShown: function (a) { return offer.isShownFor(a); },
    onReoffer: function (a) { announces.push(offer.announce(a)); },
  });
  monitor.check();
  monitor.check();
  assert.ok(offer.current(), "visible while the first read is in flight");
  monitor.check(); // inconclusive
  reads[0]({ available: true, commits: ["late"] }); // resolves under an inconclusive verdict: discarded
  await announces[0];
  assert.equal(offer.isShownFor(sequence[0]), false, "the discarded read leaves the offer needing a refresh");
  assert.ok(offer.current(), "the offer is still visible");
  monitor.check();
  monitor.check(); // second consecutive stale sighting: re-announced
  assert.equal(announces.length, 2, "the next stale confirmation announced it again");
  reads[1]({ available: true, commits: ["fresh"] });
  await announces[1];
  assert.deepEqual(offer.current().changes.commits, ["fresh"]);
  assert.equal(sent.filter(function (m) { return m.type === "diagnostic_retract"; }).length, 0, "never retracted");
});

test("a confirmed stale build whose offer is shown is not re-announced on later checks", function () {
  var reoffers = 0;
  var h = harness([assessment("stale"), assessment("stale"), assessment("stale"), assessment("stale")], {
    isOfferShown: function () { return true; },
    onReoffer: function () { reoffers += 1; },
  });
  for (var i = 0; i < 4; i++) h.monitor.check();
  assert.equal(reoffers, 0);
});

test("a confirmed stale build whose offer is not shown is re-announced, without a second journal warning", function () {
  var reoffers = 0;
  var h = harness([assessment("stale"), assessment("stale"), assessment("stale"), assessment("stale")], {
    isOfferShown: function () { return false; },
    onReoffer: function () { reoffers += 1; },
  });
  for (var i = 0; i < 4; i++) h.monitor.check();
  assert.equal(reoffers, 2, "checks 3 and 4");
  assert.equal(h.events.filter(function (e) { return e.indexOf("stale:") === 0; }).length, 1, "onStale (the warning) fired once");
});

test("a confirmed stale build is repeated in the journal at the reminder interval, not every check", function () {
  var seq = [];
  for (var i = 0; i < 8; i++) seq.push(assessment("stale"));
  var h = harness(seq, { reminderEvery: 3 });
  for (var j = 0; j < 8; j++) h.monitor.check();
  var reminders = h.events.filter(function (e) { return e === "log:Still"; });
  assert.equal(reminders.length, 2, "checks 5 and 8 remind; the other confirmed checks are silent");
  assert.equal(h.events.filter(function (e) { return e.indexOf("stale:") === 0; }).length, 1);
});
