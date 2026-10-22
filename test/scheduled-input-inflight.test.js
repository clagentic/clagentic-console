"use strict";
// A record being delivered has one owner: settle() (service.js). A daemon-made
// transition with no caller is held and applied by settle() after the delivery's
// own outcome, in one commit; so for each outcome a delivery can have and each
// such operation that can arrive while it is in flight, the final state in memory
// and on disk is the one reached by finishing the delivery first. An operation
// with a caller is never held: a delete is refused as busy, and a resume arming
// is saved before it is answered (tests below).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

// The service keeps its stores private; the real store module is wrapped while
// the service loads so the test can read what the service holds in memory.
var storeModule = require("../lib/scheduled-input/store");
var realCreateStore = storeModule.createStore;
var created = [];
var servicePath = require.resolve("../lib/scheduled-input/service");
storeModule.createStore = function (opts) {
  var store = realCreateStore(opts);
  created.push(store);
  return store;
};
delete require.cache[servicePath];
var serviceModule = require(servicePath);
delete require.cache[servicePath];
storeModule.createStore = realCreateStore;

var { createScheduledInputService, RETRY_ERROR_MS, MAX_FAILURES } = serviceModule;
var targets = require("../lib/scheduled-input/records");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;
var SLUG = "proj";
var FILE = "-work-proj.json";

function setup(sessions) {
  var dir = fakes.tmpDir();
  var clock = fakes.makeClock();
  var project = fakes.makeProject("/work/proj", sessions);
  var t = { dir: dir, clock: clock, project: project, script: null };
  t.sessionInput = fakes.makeSessionInput(project, function (req) { return t.script(req); });
  t.service = createScheduledInputService({
    dir: dir,
    getProject: function (slug) { return slug === SLUG ? project : null; },
    sessionInput: t.sessionInput,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  var before = created.length;
  t.service.attachProject(SLUG);
  t.store = created[created.length - 1];
  assert.equal(created.length, before + 1);
  return t;
}

function done(t) {
  t.service.stop();
  fakes.removeDir(t.dir);
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function onDisk(t) {
  return realCreateStore({ file: path.join(t.dir, FILE) }).load();
}

// Records as comparable data: ids are random, so they are left out, and the
// order is by content.
function shape(list) {
  return json(list).map(function (r) { delete r.id; return JSON.stringify(r); }).sort();
}

function assertMemoryIsDisk(t, label) {
  assert.deepEqual(json(t.store.all()), json(onDisk(t)), "memory equals disk: " + label);
}

var OUTCOMES = [
  { name: "ok", res: { ok: true, result: "delivered" }, failures: 0 },
  { name: "busy", res: { ok: false, result: "busy", retryable: true, reason: "mid-turn" }, failures: 0 },
  { name: "error", res: { ok: false, result: "error", retryable: true, reason: "turn start failed" }, failures: 0 },
  { name: "not-found", res: { ok: false, result: "not-found", reason: "gone" }, failures: 0 },
  { name: "max-failures", res: { ok: false, result: "error", retryable: true, reason: "turn start failed" }, failures: MAX_FAILURES - 1 },
];

var RESUME_SPEC = function (t) { return { at: t.clock.now() + 40 * MIN, text: "continue later", note: "moved" }; };

var OPERATIONS = [
  { name: "upgrade by a tick", scenario: "console", run: function (t) { t.fresh.cliSessionId = "vendor-up"; t.service.tick(); } },
  { name: "upgrade by a list", scenario: "console", run: function (t) { t.fresh.cliSessionId = "vendor-up"; t.service.list(SLUG, { state: "any" }); } },
  { name: "the session ending", scenario: "plain", run: function (t) { t.service.sessionEnded(SLUG, t.session); } },
  { name: "a second tick", scenario: "plain", run: function (t) { t.service.tick(); } },
];

// Builds the scenario's record and runs time until its delivery is the one in
// flight (after `failures` deliveries that failed). Answers the function that
// finishes the delivery with `res`.
async function startDelivery(t, scenario, outcome) {
  var calls = 0;
  var release = null;
  t.script = function () {
    calls += 1;
    if (calls <= outcome.failures) return outcome.res;
    return new Promise(function (resolve) { release = resolve; });
  };
  var firstAt;
  if (scenario === "resume") {
    firstAt = 1 * MIN;
    t.service.armResume(SLUG, t.session, { at: t.clock.now() + firstAt, text: "continue", note: "n" });
  } else {
    firstAt = 10 * MIN;
    var session = scenario === "console" ? t.fresh : t.session;
    var made = t.service.create(SLUG, { target: targets.targetOf(session), session: session, kind: "recurring", text: "wake", createdBy: "test", every: 10 * MIN, count: 50 });
    assert.equal(made.ok, true);
  }
  await t.clock.advance(firstAt);
  for (var i = 0; i < outcome.failures; i++) await t.clock.advance(RETRY_ERROR_MS);
  assert.equal(calls, outcome.failures + 1, "the delivery under test is in flight");
  return function () { release(outcome.res); return fakes.flush(); };
}

function sessionsFor(scenario) {
  var fresh = fakes.makeSession(7, undefined);
  return { fresh: fresh, list: scenario === "console" ? [fresh] : [fakes.makeSession(1, "vendor-aaa")] };
}

async function run(scenario, outcome, op, interleaved) {
  var s = sessionsFor(scenario);
  var t = setup(s.list);
  t.fresh = s.fresh;
  t.session = s.list[0];
  try {
    var finish = await startDelivery(t, scenario, outcome);
    if (interleaved) {
      op.run(t);
      await finish();
    } else {
      await finish();
      op.run(t);
    }
    assertMemoryIsDisk(t, op.name);
    return { memory: shape(t.store.all()), disk: shape(onDisk(t)) };
  } finally { done(t); }
}

OUTCOMES.forEach(function (outcome) {
  OPERATIONS.forEach(function (op) {
    test("a delivery that answers " + outcome.name + " with " + op.name + " meanwhile ends as the delivery first, the operation second", async function () {
      var expected = await run(op.scenario, outcome, op, false);
      var actual = await run(op.scenario, outcome, op, true);
      assert.deepEqual(actual.memory, expected.memory, "memory");
      assert.deepEqual(actual.disk, expected.disk, "disk");
    });
  });
});

test("nothing outside settle() changes a record that is being delivered", async function () {
  var s = sessionsFor("console");
  var t = setup(s.list);
  t.fresh = s.fresh;
  t.session = s.list[0];
  try {
    var finish = await startDelivery(t, "console", { res: { ok: true, result: "delivered" }, failures: 0 });
    t.fresh.cliSessionId = "vendor-up";
    var memoryBefore = json(t.store.all());
    var diskBefore = json(onDisk(t));
    var id = memoryBefore[0].id;
    [
      function () { t.service.list(SLUG, { state: "any" }); },
      function () { t.service.armedForSession(SLUG, t.fresh); },
      function () { t.service.tick(); },
      function () { t.service.tick(); },
      function () { t.service.sessionEnded(SLUG, t.fresh); },
      function () {
        var refused = t.service.remove(SLUG, id);
        assert.equal(refused.ok, false);
        assert.equal(refused.result, "busy");
        assert.match(refused.reason, /being sent; try again in a moment/);
      },
    ].forEach(function (act, i) {
      act();
      assert.deepEqual(json(t.store.all()), memoryBefore, "memory unchanged after operation " + i);
      assert.deepEqual(json(onDisk(t)), diskBefore, "disk unchanged after operation " + i);
    });
    await finish();
    assert.equal(t.store.all().length, 1, "the refused delete left the record");
    assertMemoryIsDisk(t, "after settle");
    assert.equal(t.service.remove(SLUG, id).ok, true, "a delete succeeds once the send is over");
    assert.equal(t.store.all().length, 0);
    assertMemoryIsDisk(t, "after the delete");
  } finally { done(t); }
});

function armedResumes(list) {
  return list.filter(function (r) { return r.state === "armed" && r.createdBy === "rate-limit"; });
}

OUTCOMES.slice(0, 4).forEach(function (outcome) {
  test("arming a resume during a resume delivery that answers " + outcome.name + " is saved before the answer and leaves one armed resume, the newer", async function () {
    var s = sessionsFor("resume");
    var t = setup(s.list);
    t.session = s.list[0];
    try {
      var finish = await startDelivery(t, "resume", outcome);
      var answer = t.service.armResume(SLUG, t.session, RESUME_SPEC(t));
      assert.equal(answer.ok, true);
      var saved = onDisk(t).filter(function (r) { return r.id === answer.record.id; });
      assert.equal(saved.length, 1, "the new record is on disk when the answer is given");
      assert.equal(saved[0].state, "armed");
      assertMemoryIsDisk(t, "after the arming");
      await finish();
      var armed = armedResumes(t.store.all());
      assert.equal(armed.length, 1, "exactly one armed resume");
      assert.equal(armed[0].id, answer.record.id, "the newer one");
      assert.equal(armed[0].text, "continue later");
      assertMemoryIsDisk(t, "after settle");
      assertMemoryIsDisk(t, "final");
      if (outcome.name === "busy" || outcome.name === "error") {
        var old = t.store.all().filter(function (r) { return r.id !== answer.record.id; })[0];
        assert.equal(old.state, "ended");
        assert.equal(old.endReason, "replaced by a newer resume");
      }
    } finally { done(t); }
  });
});

test("a crash during a delivery loses nothing a caller was told: a refused delete leaves the record, an answered resume is there", async function () {
  var s = sessionsFor("plain");
  var t = setup(s.list);
  t.session = s.list[0];
  try {
    var finish = await startDelivery(t, "plain", { res: { ok: true, result: "delivered" }, failures: 0 });
    var id = t.store.all()[0].id;
    assert.equal(t.service.remove(SLUG, id).result, "busy");
    var resume = t.service.armResume(SLUG, t.session, RESUME_SPEC(t));
    assert.equal(resume.ok, true);
    // A fresh service on the same store file: the pending map is lost.
    var again = createScheduledInputService({
      dir: t.dir,
      getProject: function (slug) { return slug === SLUG ? t.project : null; },
      sessionInput: t.sessionInput,
      now: t.clock.now,
      setTimer: t.clock.setTimer,
      clearTimer: t.clock.clearTimer,
    });
    again.attachProject(SLUG);
    try {
      var listed = again.list(SLUG, { state: "any" }).inputs;
      assert.ok(listed.some(function (r) { return r.id === id; }), "no deleted record came back, because none was reported deleted: the record is still there");
      assert.ok(listed.some(function (r) { return r.id === resume.record.id && r.state === "armed"; }), "the answered resume is present and armed");
    } finally { again.stop(); }
    await finish();
  } finally { done(t); }
});

test("held operations are not lost when settle() cannot save them: the next tick applies them", async function () {
  var s = sessionsFor("plain");
  var t = setup(s.list);
  t.session = s.list[0];
  try {
    var finish = await startDelivery(t, "plain", { res: { ok: false, result: "busy", retryable: true, reason: "mid-turn" }, failures: 0 });
    t.service.sessionEnded(SLUG, t.session);
    fs.mkdirSync(path.join(t.dir, FILE + ".tmp"));
    await finish();
    assert.equal(t.store.all()[0].state, "armed", "as last saved");
    assertMemoryIsDisk(t, "settle with a failing save");
    fs.rmdirSync(path.join(t.dir, FILE + ".tmp"));
    await t.clock.advance(RETRY_ERROR_MS);
    assert.equal(t.store.all()[0].state, "ended", "the held end is applied once saving works");
    assertMemoryIsDisk(t, "after the retry");
  } finally { done(t); }
});
