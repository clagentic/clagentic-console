"use strict";
// The scheduled-input service: records, the one timer, the firing rules and the
// lifecycle. A manual clock stands in for time; the firing itself is scripted
// (the real delivery path is exercised in scheduled-input-delivery.test.js).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var { createScheduledInputService, RETRY_BUSY_MS, RETRY_ERROR_MS, MAX_FAILURES, STARTUP_GRACE_MS } = require("../lib/scheduled-input/service");
var { LIMITS } = require("../lib/scheduled-input/records");
var targets = require("../lib/scheduled-input/records");
var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var { createRateLimitResume, resumeAt, RATE_LIMIT_RESUME_NOTE, RESET_BUFFER_MS, IMMEDIATE_DELAY_MS } = require("../lib/scheduled-input/rate-limit-resume");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;
var SLUG = "proj";

function setup(opts) {
  opts = opts || {};
  var dir = opts.dir || fakes.tmpDir();
  var clock = opts.clock || fakes.makeClock();
  var sessions = opts.sessions || [fakes.makeSession(1, "vendor-aaa")];
  var project = fakes.makeProject("/work/proj", sessions);
  var sessionInput = fakes.makeSessionInput(project, opts.behaviour);
  var events = [];
  var service = createScheduledInputService({
    dir: dir,
    getProject: function (slug) { return slug === SLUG ? project : null; },
    sessionInput: sessionInput,
    publish: function (e) { events.push({ type: e.type, id: e.record.id, state: e.record.state }); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  service.attachProject(SLUG);
  return { dir: dir, clock: clock, project: project, sessionInput: sessionInput, service: service, events: events, session: sessions[0] };
}

function done(t) {
  t.service.stop();
  fakes.removeDir(t.dir);
}

function once(t, inMs, extra) {
  return t.service.create(SLUG, Object.assign({
    target: targets.targetOf(t.session), session: t.session, kind: "once", text: "go", createdBy: "test", at: t.clock.now() + inMs,
  }, extra));
}

function repeat(t, everyMs, extra) {
  return t.service.create(SLUG, Object.assign({
    target: targets.targetOf(t.session), session: t.session, kind: "recurring", text: "wake", createdBy: "test", every: everyMs, count: 3,
  }, extra));
}

function armedList(t) {
  return t.service.list(SLUG, {}).inputs;
}

test("a once input is delivered at its time into the session it names, and is then done", async function () {
  var t = setup();
  try {
    var made = once(t, 10 * MIN);
    assert.equal(made.ok, true);
    assert.equal(t.sessionInput.calls.length, 0);
    await t.clock.advance(9 * MIN);
    assert.equal(t.sessionInput.calls.length, 0, "not before its time");
    await t.clock.advance(1 * MIN);
    assert.equal(t.sessionInput.calls.length, 1);
    var call = t.sessionInput.calls[0];
    assert.equal(call.sessionId, "vendor-aaa");
    assert.equal(call.prompt, "go");
    assert.equal(call.initiator, "scheduled");
    assert.equal(call.force, false);
    assert.equal(t.service.list(SLUG, { state: "done" }).count, 1);
    assert.equal(armedList(t).length, 0);
    assert.equal(t.clock.timers.length, 0, "nothing armed, no timer");
    assert.equal(t.project.sm.sessions.size, 1, "no new session is made");
  } finally { done(t); }
});

test("there is one timer, set for the earliest due record, and it is re-armed on every change", async function () {
  var t = setup();
  try {
    once(t, 30 * MIN);
    assert.equal(t.clock.timers.length, 1);
    assert.equal(t.clock.timers[0].at, t.clock.now() + 30 * MIN);
    var early = once(t, 5 * MIN);
    assert.equal(t.clock.timers.length, 1);
    assert.equal(t.clock.timers[0].at, t.clock.now() + 5 * MIN);
    t.service.remove(SLUG, early.record.id);
    assert.equal(t.clock.timers.length, 1);
    assert.equal(t.clock.timers[0].at, t.clock.now() + 30 * MIN);
  } finally { done(t); }
});

test("a recurring input fires every interval from the delivery and ends at its count", async function () {
  var t = setup();
  try {
    repeat(t, 10 * MIN, { count: 3 });
    await t.clock.advance(10 * MIN);
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 2);
    assert.equal(armedList(t).length, 1);
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 3);
    assert.equal(armedList(t).length, 0);
    var finished = t.service.list(SLUG, { state: "done" }).inputs[0];
    assert.equal(finished.firedCount, 3);
    await t.clock.advance(60 * MIN);
    assert.equal(t.sessionInput.calls.length, 3, "no firing after the end");
  } finally { done(t); }
});

test("a recurring input ends at its until time", async function () {
  var t = setup();
  try {
    repeat(t, 10 * MIN, { count: undefined, until: t.clock.now() + 25 * MIN });
    await t.clock.advance(60 * MIN);
    assert.equal(t.sessionInput.calls.length, 2, "10 and 20 minutes; a third would pass the end");
    assert.equal(armedList(t).length, 0);
  } finally { done(t); }
});

test("a firing skipped for a busy session retries within the bounded delay once it is idle", async function () {
  var t = setup();
  try {
    assert.ok(RETRY_BUSY_MS <= 30000, "the retry is at most 30 s");
    once(t, 10 * MIN);
    t.session.isProcessing = true;
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 1);
    assert.equal(armedList(t).length, 1, "skipped, still armed");
    assert.match(armedList(t)[0].lastOutcome, /mid-turn/);
    assert.equal(armedList(t)[0].firedCount, 0);
    assert.equal(t.clock.timers.length, 1);
    assert.equal(t.clock.timers[0].at, t.clock.now() + RETRY_BUSY_MS);
    t.session.isProcessing = false;
    await t.clock.advance(RETRY_BUSY_MS);
    assert.equal(t.sessionInput.calls.length, 2);
    assert.equal(armedList(t).length, 0);
  } finally { done(t); }
});

test("a recurring input busy for several intervals fires once when idle and carries on from that delivery", async function () {
  var t = setup();
  try {
    repeat(t, 10 * MIN, { count: 5 });
    t.session.isProcessing = true;
    await t.clock.advance(35 * MIN);
    var busyCalls = t.sessionInput.calls.length;
    t.session.isProcessing = false;
    await t.clock.advance(RETRY_BUSY_MS);
    assert.equal(t.sessionInput.calls.length, busyCalls + 1, "one delivery, no burst of the missed ones");
    var rec = armedList(t)[0];
    assert.equal(rec.firedCount, 1);
    assert.equal(rec.nextAt, t.clock.now() + 10 * MIN);
  } finally { done(t); }
});

test("send now delivers at once as scheduled-now, even into a running turn, and consumes a once input", async function () {
  var t = setup();
  try {
    var made = once(t, 60 * MIN);
    t.session.isProcessing = true;
    var res = await t.service.sendNow(SLUG, made.record.id, t.session);
    assert.equal(res.ok, true);
    var call = t.sessionInput.calls[0];
    assert.equal(call.initiator, "scheduled-now");
    assert.equal(call.force, true);
    assert.equal(armedList(t).length, 0);
    assert.equal(t.clock.timers.length, 0);
  } finally { done(t); }
});

test("send now on a recurring input counts as a firing and moves the next one to now plus every", async function () {
  var t = setup();
  try {
    var made = repeat(t, 10 * MIN, { count: 4 });
    await t.clock.advance(3 * MIN);
    await t.service.sendNow(SLUG, made.record.id, t.session);
    var rec = armedList(t)[0];
    assert.equal(rec.firedCount, 1);
    assert.equal(rec.nextAt, t.clock.now() + 10 * MIN);
  } finally { done(t); }
});

test("send now and cancel refuse a record that belongs to another session", async function () {
  var other = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fakes.makeSession(1, "vendor-aaa"), other] });
  try {
    var made = once(t, 60 * MIN);
    assert.equal((await t.service.sendNow(SLUG, made.record.id, other)).result, "not-found");
    assert.equal(t.service.remove(SLUG, made.record.id, other).result, "not-found");
    assert.equal(armedList(t).length, 1);
  } finally { done(t); }
});

test("a reaped target is resumed by the firing and the record stays valid", async function () {
  var t = setup({
    behaviour: function () { return { ok: true, result: "resumed-and-delivered" }; },
  });
  try {
    repeat(t, 10 * MIN, { count: 3 });
    await t.clock.advance(10 * MIN);
    var rec = armedList(t)[0];
    assert.equal(rec.lastOutcome, "resumed-and-delivered");
    assert.equal(rec.state, "armed");
    assert.equal(rec.firedCount, 1);
  } finally { done(t); }
});

test("deleting a session ends its armed records, and only its own", async function () {
  var other = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fakes.makeSession(1, "vendor-aaa"), other] });
  try {
    once(t, 30 * MIN);
    repeat(t, 10 * MIN);
    t.service.create(SLUG, { target: targets.targetOf(other), session: other, kind: "once", text: "mine", createdBy: "t", at: t.clock.now() + 30 * MIN });
    t.events.length = 0;
    t.service.sessionEnded(SLUG, t.session);
    var ended = t.service.list(SLUG, { state: "ended" });
    assert.equal(ended.count, 2);
    assert.match(ended.inputs[0].endReason, /closed or deleted/);
    assert.equal(armedList(t).length, 1);
    assert.equal(armedList(t)[0].sessionId, "vendor-bbb");
    assert.deepEqual(t.events.map(function (e) { return e.type; }), ["ended", "ended"]);
    await t.clock.advance(120 * MIN);
    assert.equal(t.sessionInput.calls.length, 1, "only the other session's input was delivered");
  } finally { done(t); }
});

test("a firing that finds no such session ends the record", async function () {
  var t = setup({ behaviour: function () { return { ok: false, result: "not-found", reason: "gone" }; } });
  try {
    once(t, 5 * MIN);
    await t.clock.advance(5 * MIN);
    var ended = t.service.list(SLUG, { state: "ended" });
    assert.equal(ended.count, 1);
    assert.match(ended.inputs[0].endReason, /no longer exists/);
  } finally { done(t); }
});

test("a delivery error is retried and the record ends after repeated failures", async function () {
  var t = setup({ behaviour: function () { return { ok: false, result: "error", retryable: true, reason: "turn start failed" }; } });
  try {
    once(t, 1 * MIN);
    await t.clock.advance(1 * MIN);
    assert.match(armedList(t)[0].lastOutcome, /turn start failed/);
    for (var i = 1; i < MAX_FAILURES; i++) await t.clock.advance(RETRY_ERROR_MS);
    assert.equal(t.sessionInput.calls.length, MAX_FAILURES);
    assert.equal(armedList(t).length, 0);
    assert.match(t.service.list(SLUG, { state: "ended" }).inputs[0].endReason, /kept failing/);
  } finally { done(t); }
});

test("records survive a daemon restart", async function () {
  var t = setup();
  var clock = t.clock;
  try {
    var made = repeat(t, 10 * MIN, { count: 4 });
    t.service.stop();
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    var after = again.service.list(SLUG, {});
    assert.equal(after.count, 1);
    assert.equal(after.inputs[0].id, made.record.id);
    assert.equal(after.inputs[0].every, 10 * MIN);
    again.service.stop();
  } finally { done(t); }
});

test("a once input that came due while the daemon was down fires once at startup", async function () {
  var t = setup();
  var clock = t.clock;
  try {
    once(t, 10 * MIN);
    t.service.stop();
    clock.t += 3 * 60 * MIN;
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    assert.equal(again.sessionInput.calls.length, 0, "not at once: the project is settling");
    await clock.advance(STARTUP_GRACE_MS);
    assert.equal(again.sessionInput.calls.length, 1);
    assert.equal(again.service.list(SLUG, { state: "done" }).count, 1);
    await clock.advance(60 * MIN);
    assert.equal(again.sessionInput.calls.length, 1, "exactly once");
    again.service.stop();
  } finally { done(t); }
});

test("a recurring input that came due many times during downtime fires once and continues from that delivery", async function () {
  var t = setup();
  var clock = t.clock;
  try {
    repeat(t, 10 * MIN, { count: 50 });
    t.service.stop();
    clock.t += 10 * 60 * MIN;
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    await clock.advance(STARTUP_GRACE_MS);
    assert.equal(again.sessionInput.calls.length, 1, "no catch-up burst");
    var rec = again.service.list(SLUG, {}).inputs[0];
    assert.equal(rec.firedCount, 1);
    assert.equal(rec.nextAt, clock.now() + 10 * MIN);
    again.service.stop();
  } finally { done(t); }
});

test("a recurring input whose end passed during downtime is done without a firing", async function () {
  var t = setup();
  var clock = t.clock;
  try {
    repeat(t, 10 * MIN, { count: undefined, until: clock.now() + 30 * MIN });
    t.service.stop();
    clock.t += 5 * 60 * MIN;
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    await clock.advance(STARTUP_GRACE_MS);
    assert.equal(again.sessionInput.calls.length, 0);
    assert.equal(again.service.list(SLUG, { state: "done" }).count, 1);
    again.service.stop();
  } finally { done(t); }
});

test("limits: a sixth armed input, a bad interval and a recurring input without an end are refused", function () {
  var t = setup();
  try {
    for (var i = 0; i < LIMITS.MAX_ARMED_PER_SESSION; i++) assert.equal(once(t, 60 * MIN).ok, true);
    var sixth = once(t, 60 * MIN);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.result, "refused");
    assert.match(sixth.reason, /limit/);
    assert.equal(repeat(t, 10 * MIN).ok, false);
    var other = fakes.makeSession(2, "vendor-bbb");
    t.project.sm.sessions.set(2, other);
    var forOther = { service: t.service, session: other, clock: t.clock };
    assert.match(repeat(forOther, 30 * 1000).reason, /between 1 minute and 24 hours/);
    assert.match(repeat(forOther, 25 * 60 * MIN).reason, /between 1 minute and 24 hours/);
    assert.match(repeat(forOther, 10 * MIN, { count: undefined }).reason, /needs an end/);
    assert.equal(repeat(forOther, MIN).ok, true);
    assert.equal(repeat(forOther, 24 * 60 * MIN).ok, true);
  } finally { done(t); }
});

test("the limit counts per session, and finished records do not count", async function () {
  var other = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fakes.makeSession(1, "vendor-aaa"), other] });
  try {
    for (var i = 0; i < LIMITS.MAX_ARMED_PER_SESSION; i++) once(t, 5 * MIN);
    assert.equal(once(t, 5 * MIN).ok, false);
    assert.equal(t.service.create(SLUG, { target: targets.targetOf(other), session: other, kind: "once", text: "x", createdBy: "t", at: t.clock.now() + MIN }).ok, true);
    await t.clock.advance(5 * MIN);
    assert.equal(once(t, 5 * MIN).ok, true, "the fired ones no longer count");
  } finally { done(t); }
});

test("cancelling deletes the record and clears the timer", function () {
  var t = setup();
  try {
    var made = once(t, 10 * MIN);
    var res = t.service.remove(SLUG, made.record.id);
    assert.equal(res.ok, true);
    assert.equal(t.service.list(SLUG, { state: "any" }).count, 0);
    assert.equal(t.clock.timers.length, 0);
    assert.equal(t.service.remove(SLUG, made.record.id).result, "not-found");
  } finally { done(t); }
});

test("list filters by session id (vendor or console id) and by state", function () {
  var other = fakes.makeSession(2, "vendor-bbb");
  var t = setup({ sessions: [fakes.makeSession(1, "vendor-aaa"), other] });
  try {
    once(t, 10 * MIN);
    t.service.create(SLUG, { target: targets.targetOf(other), session: other, kind: "once", text: "x", createdBy: "t", at: t.clock.now() + MIN });
    assert.equal(t.service.list(SLUG, {}).count, 2);
    assert.equal(t.service.list(SLUG, { sessionId: "vendor-aaa" }).count, 1);
    assert.equal(t.service.list(SLUG, { sessionId: "2" }).count, 1);
    assert.equal(t.service.list(SLUG, { sessionId: "vendor-zzz" }).count, 0);
    assert.equal(t.service.list(SLUG, { state: "done" }).count, 0);
    assert.equal(t.service.list(SLUG, { state: "bogus" }).ok, false);
    assert.equal(t.service.list("nope", {}).ok, false);
  } finally { done(t); }
});

test("the rate-limit resume is one once record per session that does not block a person's own schedules", async function () {
  var t = setup();
  try {
    for (var i = 0; i < LIMITS.MAX_ARMED_PER_SESSION - 1; i++) assert.equal(once(t, 60 * MIN).ok, true);
    var first = t.service.armResume(SLUG, t.session, { at: t.clock.now() + 20 * MIN, text: "continue", note: "automatic resume after rate limit" });
    assert.equal(first.ok, true);
    assert.equal(t.service.hasArmedResume(SLUG, t.session), true);
    // At the limit now, yet re-arming moves the one record instead of adding.
    var moved = t.service.armResume(SLUG, t.session, { at: t.clock.now() + 40 * MIN, text: "continue", note: "automatic resume after rate limit" });
    assert.equal(moved.record.id, first.record.id);
    assert.equal(armedList(t).length, LIMITS.MAX_ARMED_PER_SESSION);
    // The resume is exempt from the limit when the person already filled it.
    var full = setup();
    for (var j = 0; j < LIMITS.MAX_ARMED_PER_SESSION; j++) once(full, 60 * MIN);
    assert.equal(full.service.armResume(SLUG, full.session, { at: full.clock.now() + 5 * MIN, text: "continue", note: "n" }).ok, true);
    done(full);
  } finally { done(t); }
});

test("a person's schedule is not blocked by an armed resume", function () {
  var t = setup();
  try {
    t.service.armResume(SLUG, t.session, { at: t.clock.now() + 20 * MIN, text: "continue", note: "n" });
    assert.equal(once(t, 5 * MIN).ok, true);
    assert.equal(armedList(t).length, 2);
  } finally { done(t); }
});

test("a record made before its session had a vendor id takes the id once it exists, and ends across a restart if not", async function () {
  var fresh = fakes.makeSession(7, undefined);
  var t = setup({ sessions: [fresh] });
  try {
    var made = once(t, 60 * MIN);
    assert.equal(made.record.sessionId, "7");
    fresh.cliSessionId = "vendor-new";
    assert.equal(t.service.armedForSession(SLUG, fresh)[0].sessionId, "vendor-new");
    t.service.stop();

    var second = setup({ sessions: [fakes.makeSession(9, undefined)] });
    var m2 = second.service.create(SLUG, { target: targets.targetOf(second.session), session: second.session, kind: "once", text: "x", createdBy: "t", at: second.clock.now() + 60 * MIN });
    assert.equal(m2.record.sessionId, "9");
    second.service.stop();
    var restarted = setup({ dir: second.dir, clock: second.clock, sessions: [fakes.makeSession(9, undefined)] });
    assert.equal(restarted.service.list(SLUG, { state: "ended" }).count, 1);
    assert.match(restarted.service.list(SLUG, { state: "ended" }).inputs[0].endReason, /had not started/);
    restarted.service.stop();
    fakes.removeDir(second.dir);
  } finally { done(t); }
});

test("a corrupt store file is set aside, not overwritten, and the project starts empty", function () {
  var dir = fakes.tmpDir();
  var project = fakes.makeProject("/work/proj", []);
  fs.writeFileSync(path.join(dir, "-work-proj.json"), "{ not json");
  var service = createScheduledInputService({
    dir: dir, getProject: function () { return project; }, sessionInput: fakes.makeSessionInput(project),
  });
  service.attachProject(SLUG);
  assert.equal(service.list(SLUG, {}).count, 0);
  var names = fs.readdirSync(dir);
  assert.ok(names.some(function (n) { return n.indexOf("-work-proj.json.unreadable-") === 0; }), names.join(","));
  service.stop();
  fakes.removeDir(dir);
});

// --- saving: at most once, and a store that cannot be written ---

// The store writes through <file>.tmp; a directory of that name makes every save
// fail, and removing it makes saves work again.
function breakSaves(t) {
  fs.mkdirSync(path.join(t.dir, "-work-proj.json.tmp"));
}

function fixSaves(t) {
  fs.rmdirSync(path.join(t.dir, "-work-proj.json.tmp"));
}

function onDisk(t) {
  return JSON.parse(fs.readFileSync(path.join(t.dir, "-work-proj.json"), "utf8")).records;
}

test("a save that fails before a firing means nothing is delivered; firing resumes once a save works", async function () {
  var t = setup();
  try {
    once(t, 10 * MIN);
    breakSaves(t);
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 0, "not delivered: it could not be recorded first");
    var listed = t.service.list(SLUG, {});
    assert.equal(listed.inputs[0].state, "armed");
    assert.equal(listed.inputs[0].firedCount, 0, "the record is back as it was");
    assert.equal(listed.store.state, "unhealthy");
    assert.equal(onDisk(t)[0].state, "armed");

    await t.clock.advance(5 * RETRY_ERROR_MS);
    assert.equal(t.sessionInput.calls.length, 0, "still unwritable: still nothing delivered");
    fixSaves(t);
    await t.clock.advance(RETRY_ERROR_MS);
    assert.equal(t.sessionInput.calls.length, 1, "delivered once the list could be saved");
    assert.equal(t.service.list(SLUG, { state: "any" }).store, undefined, "healthy again");
    assert.equal(onDisk(t)[0].state, "done");
  } finally { done(t); }
});

test("send now is refused while the list cannot be saved", async function () {
  var t = setup();
  try {
    var made = once(t, 60 * MIN);
    breakSaves(t);
    var res = await t.service.sendNow(SLUG, made.record.id, t.session);
    assert.equal(res.ok, false);
    assert.match(res.reason, /not delivered/);
    assert.equal(t.sessionInput.calls.length, 0);
    assert.equal(armedList(t).length, 1);
  } finally { done(t); }
});

test("the record is advanced and saved before the text is delivered, and a delivery failure after that follows the retry rule", async function () {
  var seenOnDisk = null;
  var t = setup({
    behaviour: function () {
      seenOnDisk = onDisk(t)[0];
      return { ok: false, result: "error", retryable: true, reason: "turn start failed" };
    },
  });
  try {
    once(t, 1 * MIN);
    await t.clock.advance(1 * MIN);
    assert.equal(seenOnDisk.state, "done", "already recorded as delivered when the delivery started");
    assert.equal(seenOnDisk.firedCount, 1);
    var rec = armedList(t)[0];
    assert.equal(rec.state, "armed", "the failed delivery put the record back");
    assert.equal(rec.firedCount, 0);
    assert.match(rec.lastOutcome, /turn start failed/);
    assert.equal(onDisk(t)[0].state, "armed", "and saved that");
    assert.equal(onDisk(t)[0].failures, 1);
    assert.equal(t.clock.timers[0].at, t.clock.now() + RETRY_ERROR_MS, "retried on the error delay");
  } finally { done(t); }
});

test("a busy session is put back and saved, and the retry rule is the busy delay", async function () {
  var t = setup();
  try {
    once(t, 1 * MIN);
    t.session.isProcessing = true;
    await t.clock.advance(1 * MIN);
    assert.equal(onDisk(t)[0].state, "armed");
    assert.equal(onDisk(t)[0].firedCount, 0);
    assert.equal(t.clock.timers[0].at, t.clock.now() + RETRY_BUSY_MS);
  } finally { done(t); }
});

test("a delivered input is not delivered again after a restart", async function () {
  var t = setup();
  var clock = t.clock;
  try {
    repeat(t, 10 * MIN, { count: 5 });
    await clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls.length, 1);
    t.service.stop();
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    assert.equal(again.service.list(SLUG, {}).inputs[0].firedCount, 1, "the delivery was recorded");
    await clock.advance(STARTUP_GRACE_MS);
    assert.equal(again.sessionInput.calls.length, 0, "nothing is due, so nothing is delivered again");
    again.service.stop();
  } finally { done(t); }
});

test("a daemon that stops while a delivery is in flight does not deliver it again on the next start", async function () {
  var t = setup({ behaviour: function () { return new Promise(function () {}); } });
  var clock = t.clock;
  try {
    once(t, 1 * MIN);
    await clock.advance(1 * MIN);
    assert.equal(t.sessionInput.calls.length, 1, "the delivery started and never reported back");
    t.service.stop();
    clock.timers = [];
    var again = setup({ dir: t.dir, clock: clock, sessions: [t.session] });
    await clock.advance(STARTUP_GRACE_MS + 60 * MIN);
    assert.equal(again.sessionInput.calls.length, 0, "recorded before it was delivered, so never delivered twice");
    again.service.stop();
  } finally { done(t); }
});

test("cancelling is refused, and the record kept, when the deletion cannot be saved", function () {
  var t = setup();
  try {
    var made = once(t, 60 * MIN);
    breakSaves(t);
    var res = t.service.remove(SLUG, made.record.id);
    assert.equal(res.ok, false);
    assert.equal(res.result, "error");
    assert.equal(armedList(t).length, 1, "it would otherwise come back after a restart and fire");
  } finally { done(t); }
});

test("a new input is refused when the list cannot be saved, and the failed one is not kept", function () {
  var t = setup();
  try {
    breakSaves(t);
    var res = once(t, 60 * MIN);
    assert.equal(res.ok, false);
    assert.equal(res.result, "error");
    assert.equal(t.service.list(SLUG, { state: "any" }).count, 0);
  } finally { done(t); }
});

test("an unreadable store that cannot be set aside is read-only: saves are refused, the file is never overwritten, the error is listed", async function () {
  var dir = fakes.tmpDir();
  var file = path.join(dir, "-work-proj.json");
  var original = "{ precious but not json";
  fs.writeFileSync(file, original);
  var project = fakes.makeProject("/work/proj", [fakes.makeSession(1, "vendor-aaa")]);
  var clock = fakes.makeClock();
  var real = fs.renameSync;
  var service;
  try {
    fs.renameSync = function (from) {
      if (from === file) throw new Error("EACCES: rename refused");
      return real.apply(fs, arguments);
    };
    service = createScheduledInputService({
      dir: dir, getProject: function () { return project; }, sessionInput: fakes.makeSessionInput(project),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    service.attachProject(SLUG);
  } finally { fs.renameSync = real; }
  try {
    var listed = service.list(SLUG, {});
    assert.equal(listed.store.state, "read-only");
    assert.match(listed.store.error, /could not be set aside/);
    var session = project.sm.sessions.get(1);
    var made = service.create(SLUG, { target: targets.targetOf(session), session: session, kind: "once", text: "x", createdBy: "t", at: clock.now() + MIN });
    assert.equal(made.ok, false, "creating is refused");
    assert.match(made.reason, /could not be set aside/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "the unreadable file is untouched");
    assert.deepEqual(fs.readdirSync(dir), ["-work-proj.json"], "no temporary file or replacement was written");
    assert.equal(clock.timers.length, 0, "a read-only store waits for nothing");
    var viaIpc = require("../lib/scheduled-input/ipc").handleScheduledInputCommand({ service: service, getProject: function () { return project; } }, { cmd: "schedule_input_list", projectSlug: SLUG });
    assert.equal(viaIpc.storeErrors[0].state, "read-only");
    assert.equal(viaIpc.storeErrors[0].project, SLUG);
  } finally {
    service.stop();
    fakes.removeDir(dir);
  }
});

test("resolveTarget accepts a live session by either id, rejects unsafe and unknown ids", async function () {
  var t = setup();
  try {
    var byVendor = await t.service.resolveTarget(SLUG, "vendor-aaa");
    assert.deepEqual(byVendor.target, { sessionId: "vendor-aaa", sessionIdKind: "vendor" });
    var byConsole = await t.service.resolveTarget(SLUG, "1");
    assert.equal(byConsole.target.sessionId, "vendor-aaa", "a console id is stored as the stable vendor id");
    assert.equal((await t.service.resolveTarget(SLUG, "../etc")).result, "refused");
    assert.equal((await t.service.resolveTarget("nope", "x")).result, "refused");
  } finally { done(t); }
});

// --- the rate-limit automatic continue: a once record with its own note and a
// buffer after the reset. The buffer belongs to that caller only, its guard is
// "no armed auto-continue", and it no longer blocks a person's own schedules. ---

var RL_SLUG = "p";

function rlSetup() {
  var dir = fakes.tmpDir();
  // Starts just past the real time: the processor stamps an overage resume with
  // Date.now(), which the arming must read as already reached.
  var clock = fakes.makeClock(Date.now() + 5000);
  var session = fakes.makeSession(1, "vendor-1", { history: [], onQueryComplete: function () {} });
  var project = fakes.makeProject("/work/p", [session]);
  var sessionInput = fakes.makeSessionInput(project);
  var service = createScheduledInputService({
    dir: dir, getProject: function (slug) { return slug === RL_SLUG ? project : null; }, sessionInput: sessionInput,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject(RL_SLUG);
  var resume = createRateLimitResume({ service: service, slug: RL_SLUG, now: clock.now });
  var noop = function () {};
  var sm = { sessions: project.sm.sessions, sendAndRecord: noop, sendToSession: noop, currentModel: "m" };
  var processor = attachMessageProcessor({
    sm: sm, send: noop, slug: RL_SLUG, cwd: "/work/p", pushModule: null, getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" }, onProcessingChanged: noop, onTurnDone: null, onAutoTitle: null,
    opts: { scheduleRateLimitResume: resume.schedule, hasRateLimitResume: resume.has },
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
  return {
    dir: dir, clock: clock, session: session, service: service, sessionInput: sessionInput, processor: processor,
    reject: function (resetsInMs, overage) {
      processor.processSDKMessage(session, {
        yokeType: "rate_limit",
        rateLimitInfo: { status: "rejected", resetsAt: Math.floor((clock.now() + resetsInMs) / 1000), rateLimitType: "five_hour", isUsingOverage: !!overage },
      });
    },
    armed: function () { return service.list(RL_SLUG, {}).inputs; },
    cleanup: function () { service.stop(); fakes.removeDir(dir); },
  };
}

test("the buffer arithmetic: a future reset gets the buffer, a past or missing one the short delay", function () {
  assert.equal(resumeAt(1000000 + 20 * MIN, 1000000), 1000000 + 20 * MIN + RESET_BUFFER_MS);
  assert.equal(RESET_BUFFER_MS, 60 * 1000);
  assert.equal(resumeAt(500, 1000000), 1000000 + IMMEDIATE_DELAY_MS);
  assert.equal(resumeAt(null, 1000000), 1000000 + IMMEDIATE_DELAY_MS);
});

test("a rejection without overage arms a once record at the reset plus the 60 s buffer, with its own note", function () {
  var t = rlSetup();
  try {
    t.reject(20 * MIN, false);
    var armed = t.armed();
    assert.equal(armed.length, 1);
    assert.equal(armed[0].kind, "once");
    assert.equal(armed[0].createdBy, "rate-limit");
    assert.equal(armed[0].preview, "continue");
    // Unix seconds on the wire: the reset is known to the second.
    var resetMs = Math.floor((t.clock.now() + 20 * MIN) / 1000) * 1000;
    assert.equal(armed[0].nextAt, resetMs + RESET_BUFFER_MS);
    assert.equal(t.session.rateLimitResetsAt, null);
  } finally { t.cleanup(); }
});

test("a rejection with overage arms the resume to go in a few seconds, with no reset buffer", function () {
  var t = rlSetup();
  try {
    t.reject(20 * MIN, true);
    var armed = t.armed();
    assert.equal(armed.length, 1);
    assert.equal(armed[0].nextAt, t.clock.now() + IMMEDIATE_DELAY_MS);
  } finally { t.cleanup(); }
});

test("the resume is delivered with its note, as a scheduled turn, when it comes due", async function () {
  var t = rlSetup();
  try {
    t.reject(20 * MIN, false);
    await t.clock.advance(20 * MIN);
    assert.equal(t.sessionInput.calls.length, 0, "not at the reset itself: the buffer follows");
    await t.clock.advance(RESET_BUFFER_MS);
    assert.equal(t.sessionInput.calls.length, 1);
    var call = t.sessionInput.calls[0];
    assert.equal(call.prompt, "continue");
    assert.equal(call.note, RATE_LIMIT_RESUME_NOTE);
    assert.equal(call.initiator, "scheduled");
    assert.equal(t.armed().length, 0);
  } finally { t.cleanup(); }
});

test("the resume skips a session that is mid-turn like every other record, then goes once it is idle", async function () {
  var t = rlSetup();
  try {
    t.reject(20 * MIN, true);
    t.session.isProcessing = true;
    await t.clock.advance(IMMEDIATE_DELAY_MS);
    assert.equal(t.armed().length, 1, "skipped, still armed");
    t.session.isProcessing = false;
    await t.clock.advance(30000);
    assert.equal(t.armed().length, 0);
    assert.equal(t.sessionInput.calls[t.sessionInput.calls.length - 1].prompt, "continue");
  } finally { t.cleanup(); }
});

test("a second rejection while a resume is armed adds nothing (the guard), and a late one moves it", function () {
  var t = rlSetup();
  try {
    t.reject(20 * MIN, false);
    var first = t.armed()[0];
    t.reject(30 * MIN, false);
    assert.equal(t.armed().length, 1);
    assert.equal(t.armed()[0].id, first.id);
    assert.equal(t.armed()[0].nextAt, first.nextAt, "the processor does not re-arm over an armed resume");
    // The bridge's own query-end path calls schedule directly and moves it.
    t.service.armResume(RL_SLUG, t.session, { at: t.clock.now() + 45 * MIN, text: "continue", note: RATE_LIMIT_RESUME_NOTE });
    assert.equal(t.armed().length, 1);
    assert.equal(t.armed()[0].nextAt, t.clock.now() + 45 * MIN);
  } finally { t.cleanup(); }
});

test("an armed resume does not block a person's own schedule, which goes at its own time with no buffer", async function () {
  var t = rlSetup();
  try {
    t.reject(60 * MIN, false);
    var made = t.service.create(RL_SLUG, {
      target: targets.targetOf(t.session), session: t.session, kind: "once", text: "mine", createdBy: "browser", at: t.clock.now() + 10 * MIN,
    });
    assert.equal(made.ok, true);
    assert.equal(t.armed().length, 2);
    await t.clock.advance(10 * MIN);
    var mine = t.sessionInput.calls.filter(function (c) { return c.prompt === "mine"; });
    assert.equal(mine.length, 1, "fired at 10 minutes, not 11");
    assert.equal(t.armed().length, 1);
    assert.equal(t.armed()[0].createdBy, "rate-limit");
  } finally { t.cleanup(); }
});

test("a person's schedule does not stop a rejection from arming the resume", function () {
  var t = rlSetup();
  try {
    t.service.create(RL_SLUG, {
      target: targets.targetOf(t.session), session: t.session, kind: "once", text: "mine", createdBy: "browser", at: t.clock.now() + 600 * MIN,
    });
    t.reject(20 * MIN, false);
    assert.equal(t.armed().length, 2);
    assert.equal(t.service.hasArmedResume(RL_SLUG, t.session), true);
  } finally { t.cleanup(); }
});

test("a rejection with auto-continue off arms nothing", function () {
  var t = rlSetup();
  try {
    t.session.onQueryComplete = null;
    t.reject(20 * MIN, false);
    assert.equal(t.armed().length, 0);
  } finally { t.cleanup(); }
});

test("a project with no scheduled-input service arms nothing and does not throw", function () {
  var resume = createRateLimitResume({ service: null, slug: RL_SLUG });
  resume.schedule({ localId: 1 }, Date.now() + MIN);
  assert.equal(resume.has({ localId: 1 }), false);
});
