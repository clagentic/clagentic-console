"use strict";
// The class-closing test for the scheduled-input service: after every public
// operation, each also with a save that fails where it applies, a fresh store
// loaded from the same file equals what the service holds in memory. Memory
// equals disk, always (the service changes records only inside commit()).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

// The service keeps its stores private; the real store module is wrapped for the
// duration of loading it so the test can read what the service holds in memory.
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

var { createScheduledInputService, RETRY_BUSY_MS, RETRY_ERROR_MS, MAX_FAILURES, STARTUP_GRACE_MS } = serviceModule;
var targets = require("../lib/scheduled-input/records");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;
var SLUG = "proj";
var FILE = "-work-proj.json";

function setup(opts) {
  opts = opts || {};
  var dir = opts.dir || fakes.tmpDir();
  var clock = opts.clock || fakes.makeClock();
  var sessions = opts.sessions || [fakes.makeSession(1, "vendor-aaa")];
  var project = fakes.makeProject("/work/proj", sessions);
  var t = { dir: dir, clock: clock, project: project, session: sessions[0], events: [], script: null };
  // The scripted answer when a test gives one; otherwise the fake's default
  // (not-found for an absent session, busy for a mid-turn one unless forced).
  var fallback = fakes.makeSessionInput(project);
  t.sessionInput = fakes.makeSessionInput(project, function (req, proj) {
    if (t.script) return t.script(req, proj);
    return fallback.fireScheduled(req);
  });
  t.service = createScheduledInputService({
    dir: dir,
    getProject: function (slug) { return slug === SLUG ? project : null; },
    sessionInput: t.sessionInput,
    publish: function (e) { t.events.push(e.type); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  var before = created.length;
  t.service.attachProject(SLUG);
  t.store = created.length > before ? created[created.length - 1] : null;
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
  var file = path.join(t.dir, FILE);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).records;
}

// A store loaded fresh from the same file must equal the service's memory.
function same(t, label) {
  var fresh = realCreateStore({ file: path.join(t.dir, FILE) }).load();
  assert.deepEqual(json(t.store.all()), json(fresh), "memory equals disk after: " + label);
}

function breakSaves(t) {
  fs.mkdirSync(path.join(t.dir, FILE + ".tmp"));
}

function fixSaves(t) {
  fs.rmdirSync(path.join(t.dir, FILE + ".tmp"));
}

function once(t, inMs, extra) {
  return t.service.create(SLUG, Object.assign({
    target: targets.targetOf(t.session), session: t.session, kind: "once", text: "go", createdBy: "test", at: t.clock.now() + inMs,
  }, extra));
}

function repeat(t, everyMs, extra) {
  return t.service.create(SLUG, Object.assign({
    target: targets.targetOf(t.session), session: t.session, kind: "recurring", text: "wake", createdBy: "test", every: everyMs, count: 5,
  }, extra));
}

function mem(t) {
  return t.store.all();
}

test("create, list and remove keep memory equal to disk, with and without a failing save", function () {
  var t = setup();
  try {
    var first = once(t, 60 * MIN);
    assert.equal(first.ok, true);
    same(t, "create");
    t.service.list(SLUG, { state: "any" });
    same(t, "list");

    breakSaves(t);
    assert.equal(once(t, 60 * MIN).ok, false);
    same(t, "create with a failing save");
    assert.equal(t.service.remove(SLUG, first.record.id).ok, false);
    same(t, "remove with a failing save");
    assert.equal(mem(t).length, 1, "the cancelled record is still held, as it is still on disk");
    fixSaves(t);

    assert.equal(t.service.remove(SLUG, first.record.id).ok, true);
    same(t, "remove");
    assert.equal(mem(t).length, 0);
  } finally { done(t); }
});

test("send now: the delivered outcome is saved, and a failing save keeps what was saved", async function () {
  var t = setup();
  try {
    var made = once(t, 60 * MIN);
    var res = await t.service.sendNow(SLUG, made.record.id, t.session);
    assert.equal(res.ok, true);
    same(t, "send now");
    // A fresh store from the same file shows the delivered outcome, not "sending".
    var reloaded = realCreateStore({ file: path.join(t.dir, FILE) }).load();
    assert.equal(reloaded[0].state, "done");
    assert.equal(reloaded[0].lastOutcome, "delivered");

    var second = once(t, 60 * MIN);
    breakSaves(t);
    var refused = await t.service.sendNow(SLUG, second.record.id, t.session);
    assert.equal(refused.ok, false);
    same(t, "send now with a failing save before delivery");
    assert.equal(t.sessionInput.calls.length, 1, "not delivered");
    fixSaves(t);

    var third = once(t, 60 * MIN);
    t.script = function () { breakSaves(t); return { ok: true, result: "delivered" }; };
    var sent = await t.service.sendNow(SLUG, third.record.id, t.session);
    assert.equal(sent.ok, true, "it was delivered");
    same(t, "send now whose outcome could not be saved");
    var kept = mem(t).filter(function (r) { return r.id === third.record.id; })[0];
    assert.equal(kept.lastOutcome, "sending", "the saved outcome is kept");
    assert.equal(kept.state, "done");
    fixSaves(t);
    t.script = null;
    await t.clock.advance(RETRY_ERROR_MS * 4);
    assert.equal(t.sessionInput.calls.length, 2, "delivered at most once: not again");
    same(t, "after the save works again");
  } finally { done(t); }
});

// Each result a delivery can answer, with the outcome save working and failing.
[
  { name: "ok", res: { ok: true, result: "delivered" } },
  { name: "busy", res: { ok: false, result: "busy", retryable: true, reason: "mid-turn" } },
  { name: "not-found", res: { ok: false, result: "not-found", reason: "gone" } },
  { name: "error", res: { ok: false, result: "error", retryable: true, reason: "turn start failed" } },
].forEach(function (c) {
  [false, true].forEach(function (failingSave) {
    test("a due firing that answers " + c.name + (failingSave ? ", with the following save failing" : "") + " keeps memory equal to disk", async function () {
      var t = setup();
      try {
        repeat(t, 10 * MIN);
        t.script = function () {
          if (failingSave) breakSaves(t);
          return c.res;
        };
        await t.clock.advance(10 * MIN);
        assert.equal(t.sessionInput.calls.length, 1);
        same(t, "firing " + c.name);
        if (failingSave) {
          fixSaves(t);
          t.script = null;
          await t.clock.advance(RETRY_ERROR_MS);
          same(t, "after the save works again");
        }
      } finally { done(t); }
    });
  });
});

test("a record that keeps failing ends after the limit, with and without a failing save at the end", async function () {
  for (var failLast = 0; failLast < 2; failLast++) {
    var t = setup();
    try {
      var calls = 0;
      t.script = function () {
        calls += 1;
        if (failLast && calls === MAX_FAILURES) breakSaves(t);
        return { ok: false, result: "error", retryable: true, reason: "turn start failed" };
      };
      once(t, 1 * MIN);
      await t.clock.advance(1 * MIN);
      for (var i = 1; i < MAX_FAILURES; i++) {
        await t.clock.advance(RETRY_ERROR_MS);
        same(t, "failure " + i);
      }
      assert.equal(calls, MAX_FAILURES);
      same(t, "the last failure");
      if (!failLast) {
        assert.equal(mem(t)[0].state, "ended");
        assert.match(mem(t)[0].endReason, /kept failing/);
      } else {
        // The put-back could not be saved, so the record stays as last saved: a
        // once record advanced before its delivery is done, and is not retried.
        fixSaves(t);
        await t.clock.advance(RETRY_ERROR_MS * 4);
        assert.equal(calls, MAX_FAILURES, "not delivered again");
        assert.notEqual(mem(t)[0].state, "armed", "it does not stay armed");
        assert.equal(t.clock.timers.length, 0, "nothing is waited for");
        same(t, "after the save works again");
      }
    } finally { done(t); }
  }
});

test("a recurring record whose last allowed failure could not be saved still ends once saving works", async function () {
  var t = setup();
  try {
    var calls = 0;
    t.script = function () {
      calls += 1;
      if (calls === MAX_FAILURES) breakSaves(t);
      return { ok: false, result: "error", retryable: true, reason: "turn start failed" };
    };
    repeat(t, 10 * MIN, { count: 100 });
    await t.clock.advance(10 * MIN);
    for (var i = 1; i < MAX_FAILURES; i++) await t.clock.advance(RETRY_ERROR_MS);
    assert.equal(calls, MAX_FAILURES);
    fixSaves(t);
    // Bounded: it must end within another MAX_FAILURES failures.
    for (var j = 0; j < MAX_FAILURES * 2 && mem(t)[0].state === "armed"; j++) {
      await t.clock.advance(10 * MIN);
    }
    assert.equal(mem(t)[0].state, "ended");
    assert.match(mem(t)[0].endReason, /kept failing/);
    assert.ok(calls <= MAX_FAILURES * 2 + 1, "ended after a bounded number of failures");
    same(t, "ended after the save works again");
  } finally { done(t); }
});

test("a record ended by its session during an in-flight delivery that then fails busy stays ended, in memory and on disk", async function () {
  var t = setup();
  try {
    var release = null;
    t.script = function () { return new Promise(function (resolve) { release = resolve; }); };
    repeat(t, 10 * MIN);
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 1);
    t.service.sessionEnded(SLUG, t.session);
    assert.equal(mem(t)[0].state, "armed", "only settle() changes a record in flight");
    release({ ok: false, result: "busy", retryable: true, reason: "mid-turn" });
    await fakes.flush();
    assert.equal(mem(t)[0].state, "ended", "not re-armed by the late failure");
    assert.equal(mem(t)[0].nextAt, null);
    assert.equal(onDisk(t)[0].state, "ended");
    same(t, "late busy result");
    assert.equal(t.clock.timers.length, 0);
    await t.clock.advance(60 * MIN);
    assert.equal(t.sessionInput.calls.length, 1);
  } finally { done(t); }
});

test("a delete during an in-flight delivery is refused as busy and changes nothing; after the delivery it succeeds", async function () {
  var t = setup();
  try {
    var release = null;
    t.script = function () { return new Promise(function (resolve) { release = resolve; }); };
    var made = repeat(t, 10 * MIN);
    await t.clock.advance(10 * MIN);
    var memoryBefore = json(mem(t));
    var diskBefore = json(onDisk(t));
    var refused = t.service.remove(SLUG, made.record.id);
    assert.equal(refused.ok, false);
    assert.equal(refused.result, "busy");
    assert.equal(refused.reason, "that scheduled input is being sent; try again in a moment");
    assert.deepEqual(json(mem(t)), memoryBefore);
    assert.deepEqual(json(onDisk(t)), diskBefore);
    release({ ok: false, result: "error", retryable: true, reason: "x" });
    await fakes.flush();
    assert.equal(mem(t).length, 1);
    same(t, "late result of a refused delete");
    assert.equal(t.service.remove(SLUG, made.record.id).ok, true);
    assert.equal(mem(t).length, 0);
    same(t, "delete after the delivery");
  } finally { done(t); }
});

test("a session ended keeps memory equal to disk; with a failing save the records stay armed and the next firing ends them", async function () {
  var other = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fakes.makeSession(1, "vendor-aaa"), other] });
  try {
    once(t, 30 * MIN);
    t.service.create(SLUG, { target: targets.targetOf(other), session: other, kind: "once", text: "mine", createdBy: "t", at: t.clock.now() + 30 * MIN });
    t.service.sessionEnded(SLUG, t.session);
    same(t, "session ended");
    assert.equal(mem(t).filter(function (r) { return r.state === "ended"; }).length, 1);

    var again = fakes.makeSession(3, "vendor-ccc");
    t.project.sm.sessions.set(3, again);
    t.service.create(SLUG, { target: targets.targetOf(again), session: again, kind: "once", text: "x", createdBy: "t", at: t.clock.now() + 30 * MIN });
    breakSaves(t);
    t.service.sessionEnded(SLUG, again);
    same(t, "session ended with a failing save");
    assert.equal(mem(t).filter(function (r) { return r.sessionId === "vendor-ccc"; })[0].state, "armed");
    t.project.sm.sessions.delete(3);
    fixSaves(t);
    await t.clock.advance(30 * MIN + RETRY_ERROR_MS);
    var gone = mem(t).filter(function (r) { return r.sessionId === "vendor-ccc"; })[0];
    assert.equal(gone.state, "ended");
    assert.match(gone.endReason, /no longer exists/);
    same(t, "the firing into the closed session");
  } finally { done(t); }
});

test("arming the resume keeps memory equal to disk, new and moved, with and without a failing save", function () {
  var t = setup();
  try {
    var spec = function (min) { return { at: t.clock.now() + min * MIN, text: "continue", note: "n" }; };
    var other = fakes.makeSession(2, "vendor-bbb");
    t.project.sm.sessions.set(2, other);
    breakSaves(t);
    assert.equal(t.service.armResume(SLUG, t.session, spec(20)).ok, false);
    same(t, "arm with a failing save");
    fixSaves(t);

    var first = t.service.armResume(SLUG, t.session, spec(20));
    assert.equal(first.ok, true);
    same(t, "arm");
    breakSaves(t);
    assert.equal(t.service.armResume(SLUG, t.session, spec(40)).ok, false);
    same(t, "move with a failing save");
    assert.equal(mem(t)[0].at, first.record.at);
    fixSaves(t);
    assert.equal(t.service.armResume(SLUG, t.session, spec(40)).ok, true);
    same(t, "move");
    assert.equal(t.service.hasArmedResume(SLUG, t.session), true);
  } finally { done(t); }
});

test("startup: a console-keyed record ends and a due record fires once, memory equal to disk each time", async function () {
  var fresh = fakes.makeSession(7, undefined);
  var live = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fresh, live] });
  var clock = t.clock;
  try {
    t.service.create(SLUG, { target: targets.targetOf(fresh), session: fresh, kind: "once", text: "a", createdBy: "t", at: clock.now() + 10 * MIN });
    t.service.create(SLUG, { target: targets.targetOf(live), session: live, kind: "once", text: "b", createdBy: "t", at: clock.now() + 10 * MIN });
    t.service.stop();
    clock.t += 60 * MIN;
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [fakes.makeSession(7, undefined), fakes.makeSession(2, "vendor-bbb")] });
    same(again, "attach");
    assert.equal(mem(again).filter(function (r) { return r.state === "ended"; }).length, 1);
    await clock.advance(STARTUP_GRACE_MS);
    same(again, "the due record fired");
    assert.equal(again.sessionInput.calls.length, 1);
    again.service.stop();
  } finally { done(t); }
});

test("startup with a failing save: the console-keyed record is ended by the next tick once a save works", async function () {
  var fresh = fakes.makeSession(7, undefined);
  var t = setup({ sessions: [fresh] });
  var clock = t.clock;
  try {
    t.service.create(SLUG, { target: targets.targetOf(fresh), session: fresh, kind: "once", text: "a", createdBy: "t", at: clock.now() + 600 * MIN });
    t.service.stop();
    clock.timers = [];
    breakSaves(t);
    var again = setup({ dir: t.dir, clock: clock, sessions: [fakes.makeSession(7, undefined)] });
    same(again, "attach with a failing save");
    assert.equal(mem(again)[0].state, "armed");
    fixSaves(t);
    await clock.advance(RETRY_ERROR_MS);
    assert.equal(mem(again)[0].state, "ended");
    same(again, "the retried end");
    again.service.stop();
  } finally { done(t); }
});

test("a vendor-id upgrade keeps memory equal to disk, with and without a failing save", async function () {
  var a = fakes.makeSession(7, undefined);
  var b = fakes.makeSession(8, undefined);
  var t = setup({ sessions: [a, b] });
  try {
    t.service.create(SLUG, { target: targets.targetOf(a), session: a, kind: "once", text: "a", createdBy: "t", at: t.clock.now() + 600 * MIN });
    t.service.create(SLUG, { target: targets.targetOf(b), session: b, kind: "once", text: "b", createdBy: "t", at: t.clock.now() + 600 * MIN });
    a.cliSessionId = "vendor-new-a";
    t.service.list(SLUG, {});
    same(t, "upgrade");
    assert.equal(mem(t)[0].sessionId, "vendor-new-a");

    b.cliSessionId = "vendor-new-b";
    breakSaves(t);
    t.service.list(SLUG, {});
    same(t, "upgrade with a failing save");
    assert.equal(mem(t)[1].sessionId, "8", "not upgraded in memory either");
    fixSaves(t);
    await t.clock.advance(RETRY_ERROR_MS);
    assert.equal(mem(t)[1].sessionId, "vendor-new-b");
    same(t, "the retried upgrade");
  } finally { done(t); }
});

test("a recurring record past its end is done, with and without a failing save", async function () {
  for (var failing = 0; failing < 2; failing++) {
    var t = setup();
    try {
      t.session.isProcessing = true;
      repeat(t, 10 * MIN, { count: undefined, until: t.clock.now() + 25 * MIN });
      await t.clock.advance(25 * MIN);
      same(t, "busy retries");
      if (failing) breakSaves(t);
      await t.clock.advance(RETRY_BUSY_MS);
      same(t, "past its end");
      if (failing) {
        assert.equal(mem(t)[0].state, "armed");
        fixSaves(t);
        await t.clock.advance(RETRY_ERROR_MS);
        same(t, "the retried end");
      }
      assert.equal(mem(t)[0].state, "done");
      assert.equal(t.sessionInput.calls.every(function (c) { return c.force === false; }), true);
    } finally { done(t); }
  }
});
