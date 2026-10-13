"use strict";

// While the build is genuinely stale an actionable offer is always visible: it
// is shown at once, refreshed in place as the change list arrives, and never
// retracted for a re-announcement of the same build or a failed read. It is
// retracted only on adoption or when another build is the stale one.

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
    // Each change-list read stays pending until the test settles it.
    listChanges: function () { return new Promise(function (resolve, reject) { w.pending.push({ resolve: resolve, reject: reject }); }); },
    currentAssessment: function () { return w.current; },
    broadcast: function (m) { w.sent.push(m); },
    compose: function (a, changes) {
      return { type: "diagnostic", source: "build-update", installed: a.installedBuildSha, changes: changes, actionable: { action: "restart_for_build_update" } };
    },
  });
  return w;
}

function offers(w) { return w.sent.filter(function (m) { return m.type === "diagnostic"; }); }
function retracts(w) { return w.sent.filter(function (m) { return m.type === "diagnostic_retract"; }); }

test("the offer is shown at once with its changes unavailable, then refreshed in place when the list arrives", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  assert.equal(w.sent.length, 1, "visible before the read finishes");
  assert.equal(w.sent[0].changes.available, false);
  assert.ok(w.sent[0].changes.reason, "and it says why there is no list yet");
  assert.equal(w.sent[0].refresh, undefined, "the first sight is a plain diagnostic");
  w.pending[0].resolve({ available: true, commits: [{ sha: "1", subject: "s" }] });
  await p;
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].refresh, true, "the update replaces the entry a client holds");
  assert.equal(w.sent[1].changes.available, true);
  assert.equal(w.offer.current().changes.available, true);
  assert.equal(w.offer.current().refresh, undefined, "a later client is replayed a plain diagnostic");
  assert.equal(retracts(w).length, 0);
});

test("adopted before the change list resolves: the offer is retracted and the late result sends nothing", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.current = { state: "adopted", loadedBuildSha: "new", installedBuildSha: "new" };
  w.offer.withdraw();
  var sentBefore = w.sent.length;
  w.pending[0].resolve({ available: true, commits: [] });
  await p;
  assert.equal(w.sent.length, sentBefore, "the late result sent nothing");
  assert.equal(w.offer.current(), null, "and left no standing offer");
  assert.deepEqual(w.sent[w.sent.length - 1], { type: "diagnostic_retract", source: "build-update" });
});

test("the verdict moved to another installed build: the old offer is retracted, the old result dropped", async function () {
  var w = setup();
  w.current = stale("n1");
  var first = w.offer.announce(stale("n1"));
  w.current = stale("n2");
  var second = w.offer.announce(stale("n2"));
  w.pending[0].resolve({ available: true, commits: ["for n1"] });
  w.pending[1].resolve({ available: true, commits: ["for n2"] });
  await Promise.all([first, second]);
  assert.deepEqual(offers(w).map(function (m) { return m.installed; }), ["n1", "n2", "n2"]);
  assert.equal(retracts(w).length, 1, "n1 was retracted once, when n2 became the stale build");
  assert.deepEqual(w.offer.current().changes.commits, ["for n2"]);
});

test("a verdict no longer stale for the same pair keeps the offer standing and drops the result", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.current = { state: "inconclusive", reason: "hash-unavailable", loadedBuildSha: "old", installedBuildSha: "new" };
  w.pending[0].resolve({ available: true, commits: ["late"] });
  await p;
  assert.equal(retracts(w).length, 0, "unknown is not adopted");
  assert.equal(w.offer.current().changes.available, false, "the late list was not applied");
  assert.equal(w.offer.isShownFor(stale()), false, "so the next stale confirmation must refresh it");
});

test("adopting retracts the offer already sent and replays none to a later client", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.pending[0].resolve({ available: true, commits: [] });
  await p;
  assert.ok(w.offer.current(), "a client connecting now is shown the offer");
  w.current = { state: "adopted", loadedBuildSha: "new", installedBuildSha: "new" };
  w.offer.withdraw();
  assert.deepEqual(w.sent[w.sent.length - 1], { type: "diagnostic_retract", source: "build-update" });
  assert.equal(w.offer.current(), null, "a client connecting later is shown nothing");
});

test("announcing the same build again while a read is slow never retracts and the action stays", async function () {
  var w = setup();
  w.current = stale();
  var first = w.offer.announce(stale());
  var second = w.offer.announce(stale());
  var third = w.offer.announce(stale());
  assert.equal(retracts(w).length, 0, "no retract broadcast between announcements for the same build");
  assert.ok(w.offer.current(), "the offer is visible with every read still pending");
  assert.equal(w.offer.current().actionable.action, "restart_for_build_update");
  assert.equal(w.offer.isShownFor(stale()), true);
  w.pending[2].resolve({ available: true, commits: ["c"] });
  w.pending[0].resolve({ available: true, commits: ["superseded"] });
  w.pending[1].resolve({ available: true, commits: ["superseded"] });
  await Promise.all([first, second, third]);
  assert.equal(retracts(w).length, 0);
  assert.deepEqual(w.offer.current().changes.commits, ["c"], "only the newest read is applied");
});

test("a rejected read keeps the offer visible and says the changes are unavailable and why", async function () {
  var w = setup();
  w.current = stale();
  var p = w.offer.announce(stale());
  w.pending[0].reject(new Error("git exploded"));
  await p;
  assert.equal(retracts(w).length, 0);
  var shown = w.offer.current();
  assert.ok(shown, "the restart action is still offered");
  assert.equal(shown.actionable.action, "restart_for_build_update");
  assert.equal(shown.changes.available, false);
  assert.match(shown.changes.reason, /could not be read/);
});

test("a reader that throws synchronously is a failed read, not a lost offer", async function () {
  var sent = [];
  var offer = createStandingOffer({
    listChanges: function () { throw new Error("sync"); },
    currentAssessment: function () { return stale(); },
    broadcast: function (m) { sent.push(m); },
    compose: function (a, changes) { return { type: "diagnostic", changes: changes }; },
  });
  await offer.announce(stale());
  assert.equal(sent.filter(function (m) { return m.type === "diagnostic_retract"; }).length, 0);
  assert.ok(offer.current());
});

test("a failed re-read does not downgrade a change list already shown", async function () {
  var w = setup();
  w.current = stale();
  var first = w.offer.announce(stale());
  w.pending[0].resolve({ available: true, commits: ["kept"] });
  await first;
  var again = w.offer.announce(stale());
  w.pending[1].reject(new Error("transient"));
  await again;
  assert.equal(retracts(w).length, 0);
  assert.deepEqual(w.offer.current().changes.commits, ["kept"]);
});
