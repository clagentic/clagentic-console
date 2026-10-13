"use strict";

// The standing offer follows the current assessment only: a late change-list
// result never resurrects an offer, and adoption retracts what clients hold.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createStandingOffer } = require("../lib/build-update-standing");

function stale(installed) {
  return {
    state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: installed || "new",
    loadedContentHash: "h0", installedContentHash: "h-" + (installed || "new"),
  };
}

function setup() {
  var w = { current: null, sent: [], pending: [] };
  w.offer = createStandingOffer({
    // Each change-list read stays pending until the test resolves it.
    listChanges: function () { return new Promise(function (resolve) { w.pending.push(resolve); }); },
    currentAssessment: function () { return w.current; },
    broadcast: function (m) { w.sent.push(m); },
    compose: function (a, changes) { return { type: "diagnostic", source: "build-update", installed: a.installedBuildSha, changes: changes }; },
  });
  return w;
}

test("a change list that resolves while the verdict is still stale becomes the offer", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.pending[0]({ commits: [] });
  await p;
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].installed, "new");
  assert.equal(w.offer.current().installed, "new");
});

test("adopted before the change list resolves: no offer and no broadcast", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.current = { state: "adopted", loadedBuildSha: "new", installedBuildSha: "new" };
  w.offer.withdraw();
  var sentBefore = w.sent.length;
  w.pending[0]({ commits: [] });
  await p;
  assert.equal(w.sent.length, sentBefore, "the late result sent nothing");
  assert.equal(w.offer.current(), null, "and left no standing offer");
});

test("the verdict moved to another installed build: the old result is dropped, the new one wins", async function () {
  var w = setup();
  w.current = stale("n1");
  var first = w.offer.announce(stale("n1"));
  w.current = stale("n2");
  var second = w.offer.announce(stale("n2"));
  w.pending[0]({ commits: ["for n1"] });
  w.pending[1]({ commits: ["for n2"] });
  await Promise.all([first, second]);
  var offers = w.sent.filter(function (m) { return m.type === "diagnostic"; });
  assert.deepEqual(offers.map(function (m) { return m.installed; }), ["n2"]);
  assert.equal(w.offer.current().installed, "n2");
});

test("a verdict that is no longer stale for the same pair drops the result even without a withdrawal", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.current = { state: "inconclusive", reason: "hash-unavailable", loadedBuildSha: "old", installedBuildSha: "new" };
  w.pending[0]({ commits: [] });
  await p;
  assert.equal(w.offer.current(), null);
  assert.equal(w.sent.length, 0);
});

test("adopting retracts the offer already sent and replays none to a later client", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.pending[0]({ commits: [] });
  await p;
  assert.ok(w.offer.current(), "a client connecting now is shown the offer");
  w.current = { state: "adopted", loadedBuildSha: "new", installedBuildSha: "new" };
  w.offer.withdraw();
  var last = w.sent[w.sent.length - 1];
  assert.deepEqual(last, { type: "diagnostic_retract", source: "build-update" });
  assert.equal(w.offer.current(), null, "a client connecting later is shown nothing");
});

test("a newer stale build retracts the older offer before announcing its own", async function () {
  var w = setup();
  w.current = stale("n1");
  var first = w.offer.announce(stale("n1"));
  w.pending[0]({ commits: [] });
  await first;
  w.current = stale("n2");
  var second = w.offer.announce(stale("n2"));
  assert.deepEqual(w.sent[w.sent.length - 1], { type: "diagnostic_retract", source: "build-update" });
  assert.equal(w.offer.current(), null, "the superseded offer is not replayed while the new one is read");
  w.pending[1]({ commits: [] });
  await second;
  assert.equal(w.offer.current().installed, "n2");
});
