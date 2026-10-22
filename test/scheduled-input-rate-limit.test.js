"use strict";
// The rate-limit auto-continue is a once record with its own note and a buffer
// after the reset; the buffer belongs to that caller only, its guard is "no
// armed auto-continue", and it no longer blocks a person's own schedules.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createRateLimitResume, resumeAt, RATE_LIMIT_RESUME_NOTE, RESET_BUFFER_MS, IMMEDIATE_DELAY_MS } = require("../lib/scheduled-input/rate-limit-resume");
var targets = require("../lib/scheduled-input/target");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;
var SLUG = "p";

function setup() {
  var dir = fakes.tmpDir();
  // Starts just past the real time: the processor stamps an overage resume with
  // Date.now(), which the arming must read as already reached.
  var clock = fakes.makeClock(Date.now() + 5000);
  var session = fakes.makeSession(1, "vendor-1", { history: [], onQueryComplete: function () {} });
  var project = fakes.makeProject("/work/p", [session]);
  var sessionInput = fakes.makeSessionInput(project);
  var service = createScheduledInputService({
    dir: dir, getProject: function (slug) { return slug === SLUG ? project : null; }, sessionInput: sessionInput,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject(SLUG);
  var resume = createRateLimitResume({ service: service, slug: SLUG, now: clock.now });
  var noop = function () {};
  var sm = { sessions: project.sm.sessions, sendAndRecord: noop, sendToSession: noop, currentModel: "m" };
  var processor = attachMessageProcessor({
    sm: sm, send: noop, slug: SLUG, cwd: "/work/p", pushModule: null, getNotificationsModule: function () { return null; },
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
    armed: function () { return service.list(SLUG, {}).inputs; },
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
  var t = setup();
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
  var t = setup();
  try {
    t.reject(20 * MIN, true);
    var armed = t.armed();
    assert.equal(armed.length, 1);
    assert.equal(armed[0].nextAt, t.clock.now() + IMMEDIATE_DELAY_MS);
  } finally { t.cleanup(); }
});

test("the resume is delivered with its note, as a scheduled turn, when it comes due", async function () {
  var t = setup();
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
  var t = setup();
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
  var t = setup();
  try {
    t.reject(20 * MIN, false);
    var first = t.armed()[0];
    t.reject(30 * MIN, false);
    assert.equal(t.armed().length, 1);
    assert.equal(t.armed()[0].id, first.id);
    assert.equal(t.armed()[0].nextAt, first.nextAt, "the processor does not re-arm over an armed resume");
    // The bridge's own query-end path calls schedule directly and moves it.
    t.service.armResume(SLUG, t.session, { at: t.clock.now() + 45 * MIN, text: "continue", note: RATE_LIMIT_RESUME_NOTE });
    assert.equal(t.armed().length, 1);
    assert.equal(t.armed()[0].nextAt, t.clock.now() + 45 * MIN);
  } finally { t.cleanup(); }
});

test("an armed resume does not block a person's own schedule, which goes at its own time with no buffer", async function () {
  var t = setup();
  try {
    t.reject(60 * MIN, false);
    var made = t.service.create(SLUG, {
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
  var t = setup();
  try {
    t.service.create(SLUG, {
      target: targets.targetOf(t.session), session: t.session, kind: "once", text: "mine", createdBy: "browser", at: t.clock.now() + 600 * MIN,
    });
    t.reject(20 * MIN, false);
    assert.equal(t.armed().length, 2);
    assert.equal(t.service.hasArmedResume(SLUG, t.session), true);
  } finally { t.cleanup(); }
});

test("a rejection with auto-continue off arms nothing", function () {
  var t = setup();
  try {
    t.session.onQueryComplete = null;
    t.reject(20 * MIN, false);
    assert.equal(t.armed().length, 0);
  } finally { t.cleanup(); }
});

test("a project with no scheduled-input service arms nothing and does not throw", function () {
  var resume = createRateLimitResume({ service: null, slug: SLUG });
  resume.schedule({ localId: 1 }, Date.now() + MIN);
  assert.equal(resume.has({ localId: 1 }), false);
});
