"use strict";
// Changing a Claude session's effort while it runs. The SDK's Query has no
// setEffort; the live control is applyFlagSettings({effortLevel}). Every path
// that takes an effort change - the in-process query handle, the OS-isolated
// worker, the bridge and the WS handler - must act on that and must say so
// when the change did not take effect, instead of announcing an effort the
// session is not running at.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var effortControl = require("../lib/yoke/adapters/effort-control");
var claudeAdapter = require("../lib/yoke/adapters/claude");

// The shape of the real Query for this purpose: applyFlagSettings, no setEffort.
function fakeQuery(calls, failWith) {
  return {
    applyFlagSettings: function (settings) {
      calls.push(settings);
      return failWith ? Promise.reject(failWith) : Promise.resolve();
    },
  };
}

function inbox(client) { return client.inbox; }

var client = world.client;
var withServer = world.withServer;

test("every effort level the SDK names is applied through applyFlagSettings", async function () {
  assert.deepEqual(effortControl.EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  for (var i = 0; i < effortControl.EFFORT_LEVELS.length; i++) {
    var calls = [];
    await effortControl.applyEffort(fakeQuery(calls), effortControl.EFFORT_LEVELS[i]);
    assert.deepEqual(calls, [{ effortLevel: effortControl.EFFORT_LEVELS[i] }]);
  }
});

test("a level the SDK does not name, or a query that cannot change effort, is a rejection and changes nothing", async function () {
  var hostile = ["minimal", "", undefined, null, 3, {}, ["high"], "__proto__", "HIGH"];
  for (var i = 0; i < hostile.length; i++) {
    var calls = [];
    await assert.rejects(effortControl.applyEffort(fakeQuery(calls), hostile[i]), /Unknown effort level/, JSON.stringify(hostile[i]));
    assert.deepEqual(calls, [], "nothing was applied for " + JSON.stringify(hostile[i]));
  }
  await assert.rejects(effortControl.applyEffort({}, "high"), /cannot change effort/);
  await assert.rejects(effortControl.applyEffort(null, "high"), /cannot change effort/);
  var boom = new Error("organization effort limit");
  await assert.rejects(effortControl.applyEffort(fakeQuery([], boom), "max"), /organization effort limit/, "the SDK's refusal reaches the caller");
  await assert.rejects(effortControl.applyEffort({ applyFlagSettings: function () { throw new Error("sync throw"); } }, "low"), /sync throw/, "a throw is a rejection too");
});

test("the in-process query handle changes effort through the query, and rejects when it cannot", async function () {
  var calls = [];
  var queue = { push: function () {}, end: function () {} };
  var handle = claudeAdapter._test_createQueryHandle(fakeQuery(calls), queue, null);
  await handle.setEffort("xhigh");
  assert.deepEqual(calls, [{ effortLevel: "xhigh" }]);

  var bare = claudeAdapter._test_createQueryHandle({}, queue, null);
  await assert.rejects(bare.setEffort("high"), /cannot change effort/);
  await assert.rejects(handle.setEffort("minimal"), /Unknown effort level/);
});

// --- the worker's daemon-side handle ---------------------------------------

function fakeWorker() {
  var worker = { sent: [], handler: null, process: null, exitPromise: null };
  worker.onMessage = function (fn) { worker.handler = fn; };
  worker.send = function (msg) { worker.sent.push(msg); };
  return worker;
}

async function drain(handle, worker) {
  worker.handler({ type: "query_done" });
  var seen = [];
  var iter = handle[Symbol.asyncIterator]();
  for (;;) {
    var r = await iter.next();
    if (r.done) return seen;
    seen.push(r.value);
  }
}

test("a worker effort change settles on the worker's own answer", async function () {
  var worker = fakeWorker();
  var handle = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);
  var change = handle.setEffort("high");
  var state = world.isSettled(change);

  assert.equal(worker.sent.length, 1);
  assert.equal(worker.sent[0].type, "set_effort");
  assert.equal(worker.sent[0].effort, "high");
  assert.equal(typeof worker.sent[0].requestId, "string");
  await Promise.resolve();
  assert.equal(state.settled, false, "not settled until the worker answers");

  worker.handler({ type: "effort_changed", effort: "high", requestId: worker.sent[0].requestId });
  await change;
  var seen = await drain(handle, worker);
  assert.ok(seen.some(function (e) { return e.type === "_worker_meta" && e.subtype === "effort_changed"; }), "the bridge still hears effort_changed");
});

test("a worker effort change the worker refuses is a rejection, reported once", async function () {
  var worker = fakeWorker();
  var handle = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);
  var change = handle.setEffort("max");
  worker.handler({ type: "worker_error", error: "Failed to set effort: organization effort limit", requestId: worker.sent[0].requestId });
  await assert.rejects(change, /organization effort limit/);
  var seen = await drain(handle, worker);
  assert.equal(seen.filter(function (e) { return e.type === "_worker_meta" && e.subtype === "worker_error"; }).length, 0,
    "the rejection is the report: no second copy as a stream event");
});

test("an answer for another request, or none, does not settle a worker effort change", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var worker = fakeWorker();
  var handle = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);
  var outcome = null;
  var change = handle.setEffort("low").then(function () { outcome = "resolved"; }, function (e) { outcome = e.message; });

  worker.handler({ type: "effort_changed", effort: "low", requestId: "someone-else" });
  worker.handler({ type: "worker_error", error: "other", requestId: "__proto__" });
  worker.handler({ type: "effort_changed", effort: "low" });
  await Promise.resolve();
  assert.equal(outcome, null);

  t.mock.timers.tick(15000);
  await change;
  assert.match(outcome, /did not confirm the effort change/);
});

test("a worker query that ends rejects an effort change still waiting", async function () {
  var worker = fakeWorker();
  var handle = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);
  var change = handle.setEffort("medium");
  worker.handler({ type: "query_error", error: "worker died" });
  await assert.rejects(change, /ended before the effort change/);
  var iter = handle[Symbol.asyncIterator]();
  await assert.rejects(iter.next());
});

// --- the bridge and the WS handler -----------------------------------------

test("the bridge announces an effort only once the running query has taken it", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var applied = [];
    server.session.queryInstance.setEffort = function (effort) { applied.push(effort); return Promise.resolve(); };
    server.sm.currentEffort = "medium";
    inbox(c).length = 0;

    var ok = await server.bridge.setEffort(server.session, "high");
    assert.deepEqual(ok, { ok: true });
    assert.deepEqual(applied, ["high"]);
    assert.equal(server.sm.currentEffort, "high");
    var states = inbox(c).filter(function (m) { return m.type === "config_state"; });
    assert.equal(states[states.length - 1].effort, "high");

    server.session.queryInstance.setEffort = function () { return Promise.reject(new Error("organization effort limit")); };
    inbox(c).length = 0;
    var failed = await server.bridge.setEffort(server.session, "max");
    assert.deepEqual(failed, { ok: false, error: "organization effort limit" });
    assert.equal(server.sm.currentEffort, "high", "the effort the session runs at is unchanged");
    assert.equal(inbox(c).filter(function (m) { return m.type === "config_state"; }).length, 0, "no change is announced");
    var errors = inbox(c).filter(function (m) { return m.type === "error"; });
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /Failed to change effort: organization effort limit/);
  });
});

test("a session with no running query records the effort for its next query", async function () {
  await withServer(async function (server) {
    await server.endQuery();
    assert.equal(server.session.queryInstance, null);
    var result = await server.bridge.setEffort(server.session, "low");
    assert.deepEqual(result, { ok: true });
    assert.equal(server.sm.currentEffort, "low");
    await server.startQuery();
    assert.equal(server.queryOptions[server.queryOptions.length - 1].effort, "low", "the next query starts at that effort");
  });
});

test("set_effort over the socket: a refused change tells the requester and puts its picker back; an accepted one is broadcast", async function () {
  await withServer(async function (server) {
    var asker = client();
    var other = client();
    server.connect(asker.ws);
    server.connect(other.ws);
    server.sm.currentEffort = "medium";

    // Mid-turn, as well as between turns: the path does not depend on it.
    server.session.isProcessing = true;
    server.session.queryInstance.setEffort = function (effort) {
      return effort === "max" ? Promise.reject(new Error("organization effort limit")) : Promise.resolve();
    };

    inbox(asker).length = 0;
    inbox(other).length = 0;
    server.handlers.handleSessionsMessage(asker.ws, { type: "set_effort", effort: "max" });
    await world.flush();
    var askerStates = inbox(asker).filter(function (m) { return m.type === "config_state"; });
    assert.equal(askerStates.length, 1, "the requester's picker is put back");
    assert.equal(askerStates[0].effort, "medium");
    assert.equal(inbox(asker).filter(function (m) { return m.type === "error"; }).length, 1);
    assert.equal(inbox(other).filter(function (m) { return m.type === "config_state"; }).length, 0, "nobody else is told of a change that did not happen");

    inbox(asker).length = 0;
    inbox(other).length = 0;
    server.handlers.handleSessionsMessage(asker.ws, { type: "set_effort", effort: "high" });
    await world.flush();
    var otherStates = inbox(other).filter(function (m) { return m.type === "config_state"; });
    assert.ok(otherStates.length >= 1);
    assert.equal(otherStates[otherStates.length - 1].effort, "high");
    assert.equal(server.sm.currentEffort, "high");
  });
});

test("a restored session starts its query at the persisted permission mode and effort", async function () {
  await withServer(async function (server) {
    await server.endQuery();
    server.session.permissionMode = "dontAsk";
    server.sm.currentEffort = "xhigh";
    await server.startQuery();
    var opts = server.queryOptions[server.queryOptions.length - 1];
    assert.equal(opts.effort, "xhigh");
    assert.equal(opts.adapterOptions.CLAUDE.permissionMode, "dontAsk");

    await server.endQuery();
    server.session.permissionMode = "auto";
    await server.startQuery();
    assert.equal(server.queryOptions[server.queryOptions.length - 1].adapterOptions.CLAUDE.permissionMode, "auto");
  });
});
