"use strict";

// The update offer is level-triggered: after every poll it equals the offer
// derived from the CURRENT confirmed verdict, and a broadcast happens only when
// the shown state (offer key + change-list status) differs. These cases drive
// the real monitor and the real standing offer through assessment sequences.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createBuildMonitor } = require("../lib/build-monitor");
var { createStandingOffer } = require("../lib/build-update-standing");

function stale(installed) {
  return {
    state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: installed || "A",
    loadedContentHash: "h0", installedContentHash: "h-" + (installed || "A"),
  };
}
var ADOPTED = { state: "adopted", reason: "identical", detail: "d", loadedBuildSha: "A", installedBuildSha: "A" };
var INCONCLUSIVE = { state: "inconclusive", reason: "hash-unavailable", detail: "d", loadedBuildSha: "old", installedBuildSha: "A" };

var LABELS = { A: stale("A"), B: stale("B"), adopted: ADOPTED, inconclusive: INCONCLUSIVE };

function kind(m) {
  if (m.type === "diagnostic_retract") return "retract";
  return m.refresh ? "refresh" : "show";
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }

/**
 * @param {object} [opts]
 * @param {boolean} [opts.hold] — change-list reads stay pending until settled by the test
 */
function rig(opts) {
  opts = opts || {};
  var r = { sent: [], reads: [], lines: [], clock: 0, next: null, composeThrows: false, broadcastThrows: false };
  r.monitor = createBuildMonitor({
    assess: function () { return r.next; },
    log: function (l) { r.lines.push(l); },
    reminderEvery: opts.reminderEvery,
  });
  r.offer = createStandingOffer({
    listChanges: function (range) {
      var read = { range: range };
      r.reads.push(read);
      if (!opts.hold) return Promise.resolve({ available: true, commits: [{ sha: "1", subject: "s" }], truncated: false });
      return new Promise(function (resolve, reject) { read.resolve = resolve; read.reject = reject; });
    },
    desired: function () { return r.monitor.confirmedStale(); },
    compose: function (a, changes) {
      if (r.composeThrows) throw new Error("compose failed");
      return { type: "diagnostic", source: "build-update", installed: a.installedBuildSha, changes: changes, actionable: { action: "restart_for_build_update" } };
    },
    broadcast: function (m) {
      if (r.broadcastThrows) throw new Error("broadcast failed");
      r.sent.push(m);
    },
    now: function () { return r.clock; },
    retryAfterMs: opts.retryAfterMs === undefined ? 1000 : opts.retryAfterMs,
    log: function (l) { r.lines.push(l); },
  });
  // One poll as the daemon runs it: check, then reconcile against the latest confirmed verdict.
  r.poll = async function (assessment) {
    r.next = assessment;
    r.monitor.check();
    r.offer.reconcile(r.monitor.confirmedStale());
    await tick();
  };
  r.held = function () { var c = r.offer.current(); return c === null ? null : c.installed; };
  r.kinds = function () { var k = r.sent.map(kind); r.sent = []; return k; };
  return r;
}

// Each step: the poll, what is held after it, and the broadcasts it caused.
// With instant reads a confirmed offer is shown pending and refreshed once listed.
var SEQUENCES = [
  { name: "stale x4: shown once confirmed, then nothing more",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["A", "A", []], ["A", "A", []]] },
  { name: "stale, inconclusive, stale (unconfirmed): never shown",
    steps: [["A", null, []], ["inconclusive", null, []], ["A", null, []]] },
  { name: "stale, inconclusive, stale, stale (confirmed after the gap)",
    steps: [["A", null, []], ["inconclusive", null, []], ["A", null, []], ["A", "A", ["show", "refresh"]]] },
  { name: "confirmed, inconclusive, stale: the offer is held throughout",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["inconclusive", "A", []], ["A", "A", []]] },
  { name: "mid-install inconclusive polls leave the held offer alone",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["inconclusive", "A", []], ["inconclusive", "A", []], ["A", "A", []]] },
  { name: "stale A then stale B: one sighting of B keeps A, a confirmed B replaces it",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["B", "A", []], ["B", "B", ["retract", "show", "refresh"]]] },
  { name: "stale then adopted: retracted once, then silent",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["adopted", null, ["retract"]], ["adopted", null, []]] },
  { name: "stale, adopted, stale again: no offer until reconfirmed",
    steps: [["A", null, []], ["A", "A", ["show", "refresh"]], ["adopted", null, ["retract"]], ["A", null, []], ["A", "A", ["show", "refresh"]]] },
  { name: "adopted from the start: nothing is ever sent",
    steps: [["adopted", null, []], ["adopted", null, []]] },
];

SEQUENCES.forEach(function (row) {
  test("sequence: " + row.name, async function () {
    var r = rig();
    for (var i = 0; i < row.steps.length; i++) {
      var step = row.steps[i];
      await r.poll(LABELS[step[0]]);
      var where = "after step " + (i + 1) + " (" + step[0] + ")";
      assert.equal(r.held(), step[1], "held offer " + where);
      assert.deepEqual(r.kinds(), step[2], "broadcasts " + where);
      // Idempotent: the same desired state again changes and sends nothing.
      r.offer.reconcile(r.monitor.confirmedStale());
      await tick();
      assert.deepEqual(r.kinds(), [], "idempotent " + where);
      var desired = r.monitor.confirmedStale();
      assert.equal(r.held(), desired === null ? null : desired.installedBuildSha, "held equals desired " + where);
    }
  });
});

test("a slow change list: the offer is shown at once, never retracted, one read in flight, filled in place", async function () {
  var r = rig({ hold: true });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  assert.deepEqual(r.kinds(), ["show"]);
  assert.equal(r.offer.current().changes.available, false);
  assert.ok(r.offer.current().changes.reason, "it says why there is no list yet");
  for (var i = 0; i < 4; i++) await r.poll(LABELS.A);
  assert.deepEqual(r.kinds(), [], "reminders for the same build send nothing");
  assert.equal(r.reads.length, 1, "at most one read in flight per build pair");
  assert.equal(r.offer.current().actionable.action, "restart_for_build_update");
  r.reads[0].resolve({ available: true, commits: [{ sha: "1", subject: "late" }], truncated: false });
  await tick();
  assert.deepEqual(r.kinds(), ["refresh"]);
  assert.equal(r.offer.current().changes.available, true);
  assert.equal(r.offer.current().refresh, undefined, "a later client is replayed a plain diagnostic");
});

test("a rejected read: the offer stays, says why, and is retried at most once per interval", async function () {
  var r = rig({ hold: true, retryAfterMs: 1000 });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  r.reads[0].reject(new Error("git exploded"));
  await tick();
  assert.deepEqual(r.kinds(), ["show", "refresh"]);
  assert.equal(r.offer.current().changes.available, false);
  assert.equal(r.offer.current().changes.reason, "the change list could not be read");
  assert.doesNotMatch(JSON.stringify(r.offer.current()), /git exploded/, "reader detail never reaches clients");
  assert.ok(r.lines.some(function (l) { return /git exploded/.test(l); }), "the detail goes to the journal");
  assert.equal(r.offer.current().actionable.action, "restart_for_build_update");

  r.clock = 500;
  await r.poll(LABELS.A);
  assert.equal(r.reads.length, 1, "not retried inside the interval");
  r.clock = 1000;
  await r.poll(LABELS.A);
  assert.equal(r.reads.length, 2, "retried once the interval has passed");
  await r.poll(LABELS.A);
  assert.equal(r.reads.length, 2, "and only once while it is in flight");
  assert.deepEqual(r.kinds(), [], "the failed state stays shown while the retry runs");

  r.reads[1].reject(new Error("still failing"));
  await tick();
  assert.deepEqual(r.kinds(), [], "a repeated failure is not a new shown state");
  r.clock = 1500;
  await r.poll(LABELS.A);
  assert.equal(r.reads.length, 2, "the interval restarts at the failed retry");
  r.clock = 2000;
  await r.poll(LABELS.A);
  assert.equal(r.reads.length, 3);
  r.reads[2].resolve({ available: true, commits: [], truncated: false });
  await tick();
  assert.deepEqual(r.kinds(), ["refresh"]);
  assert.equal(r.offer.current().changes.available, true);
});

test("a reader that throws synchronously is a failed read, not a lost offer", async function () {
  var sent = [];
  var offer = createStandingOffer({
    listChanges: function () { throw new Error("sync"); },
    desired: function () { return stale("A"); },
    compose: function (a, changes) { return { type: "diagnostic", changes: changes }; },
    broadcast: function (m) { sent.push(m); },
  });
  offer.reconcile(stale("A"));
  await tick();
  assert.deepEqual(sent.map(kind), ["show", "refresh"]);
  assert.equal(offer.current().changes.reason, "the change list could not be read");
});

test("a change list that finishes after adoption sends nothing and leaves no offer", async function () {
  var r = rig({ hold: true });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  await r.poll(LABELS.adopted);
  assert.deepEqual(r.kinds(), ["show", "retract"]);
  r.reads[0].resolve({ available: true, commits: [], truncated: false });
  await tick();
  assert.deepEqual(r.kinds(), [], "the late result restored nothing");
  assert.equal(r.offer.current(), null);
});

test("a change list for a replaced build never shows over the new one", async function () {
  var r = rig({ hold: true });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  await r.poll(LABELS.B);
  await r.poll(LABELS.B);
  assert.deepEqual(r.kinds(), ["show", "retract", "show"]);
  assert.equal(r.reads.length, 2);
  r.reads[0].resolve({ available: true, commits: [{ sha: "a", subject: "for A" }], truncated: false });
  await tick();
  assert.deepEqual(r.kinds(), [], "A's list is cached and not applied to B");
  assert.equal(r.held(), "B");
  r.reads[1].resolve({ available: true, commits: [{ sha: "b", subject: "for B" }], truncated: false });
  await tick();
  assert.deepEqual(r.kinds(), ["refresh"]);
  assert.equal(r.offer.current().changes.commits[0].subject, "for B");
});

test("stale, change list in flight, inconclusive, stale again: an offer is visible throughout", async function () {
  var r = rig({ hold: true });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  assert.ok(r.offer.current(), "visible while the first read is in flight");
  await r.poll(LABELS.inconclusive);
  assert.ok(r.offer.current(), "an inconclusive poll leaves it");
  r.reads[0].resolve({ available: true, commits: [{ sha: "1", subject: "s" }], truncated: false });
  await tick();
  assert.equal(r.offer.current().changes.available, true, "the finished read fills the held offer");
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  assert.equal(r.held(), "A");
  assert.equal(r.kinds().filter(function (k) { return k === "retract"; }).length, 0, "never retracted");
});

test("compose or broadcast failures never reach the poll loop, and the next poll retries", async function () {
  var r = rig();
  r.composeThrows = true;
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  assert.equal(r.offer.current(), null, "nothing is recorded as shown when compose failed");
  assert.ok(r.lines.some(function (l) { return /compose failed/.test(l); }), "journaled");
  r.composeThrows = false;
  r.broadcastThrows = true;
  await r.poll(LABELS.A);
  assert.equal(r.offer.current(), null, "nothing is recorded as shown until the broadcast succeeded");
  r.broadcastThrows = false;
  await r.poll(LABELS.A);
  assert.equal(r.held(), "A");
  assert.deepEqual(r.kinds(), ["show"], "the offer appears as a plain show, with the list the cache already holds");
});

test("a failed retract is retried by the next poll", async function () {
  var r = rig();
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  r.kinds();
  r.broadcastThrows = true;
  await r.poll(LABELS.adopted);
  assert.equal(r.held(), "A", "still held: the retract did not reach clients");
  r.broadcastThrows = false;
  await r.poll(LABELS.adopted);
  assert.equal(r.held(), null);
  assert.deepEqual(r.kinds(), ["retract"]);
});

test("a client that connects is sent the held offer, or an explicit no-offer", async function () {
  var r = rig();
  assert.deepEqual(r.offer.forNewClient(), { type: "diagnostic_retract", source: "build-update" });
  await r.poll(LABELS.A);
  await r.poll(LABELS.A);
  assert.equal(r.offer.forNewClient().actionable.action, "restart_for_build_update");
  assert.equal(r.offer.forNewClient().refresh, undefined);
  await r.poll(LABELS.adopted);
  // A client that missed the retraction is told there is no offer when it connects.
  assert.deepEqual(r.offer.forNewClient(), { type: "diagnostic_retract", source: "build-update" });
});

test("journal reminders continue while the offer is unchanged and across an inconclusive poll", async function () {
  var r = rig({ reminderEvery: 3 });
  var seq = [LABELS.A, LABELS.A, LABELS.A, LABELS.inconclusive, LABELS.A, LABELS.A, LABELS.A];
  for (var i = 0; i < seq.length; i++) await r.poll(seq[i]);
  var reminders = r.lines.filter(function (l) { return l.indexOf("Still serving build") === 0; });
  assert.equal(reminders.length, 1, "the inconclusive poll did not count, so one reminder at the third stale poll after confirmation");
  assert.deepEqual(r.kinds(), ["show", "refresh"], "the UI broadcast nothing for reminders");
});
