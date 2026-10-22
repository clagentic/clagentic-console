"use strict";
// The browser's messages for scheduled input, over the real service: the clock
// button creates, the bubble and the panel send now and cancel, and a browser
// that still sends the original message shapes is understood.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createWsHandlers } = require("../lib/scheduled-input/ws-handlers");
var targets = require("../lib/scheduled-input/target");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;
var SLUG = "p";

function setup(extraSessions) {
  var dir = fakes.tmpDir();
  var clock = fakes.makeClock();
  var onScreen = fakes.makeSession(1, "vendor-1");
  var project = fakes.makeProject("/work/p", [onScreen].concat(extraSessions || []));
  var sessionInput = fakes.makeSessionInput(project);
  var service = createScheduledInputService({
    dir: dir, getProject: function (slug) { return slug === SLUG ? project : null; }, sessionInput: sessionInput,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject(SLUG);
  var sentToWs = [];
  var ws = { _clagenticUser: { id: "u1", username: "andy" } };
  var handlers = createWsHandlers({
    slug: SLUG, service: service,
    getSessionForWs: function () { return onScreen; },
    sendTo: function (target, obj) { sentToWs.push(obj); },
  });
  return {
    dir: dir, clock: clock, session: onScreen, project: project, service: service, sessionInput: sessionInput,
    sent: sentToWs, ws: ws, handlers: handlers,
    handle: function (msg) { return handlers.handle(ws, msg); },
    armed: function () { return service.list(SLUG, {}).inputs; },
    cleanup: function () { service.stop(); fakes.removeDir(dir); },
  };
}

test("only the scheduled-input messages are taken; others fall through", function () {
  var t = setup();
  try {
    assert.equal(t.handle({ type: "message", text: "hi" }), false);
    assert.equal(t.handle({ type: "schedule_message", text: "hi", resetsAt: t.clock.now() + MIN }), true);
  } finally { t.cleanup(); }
});

test("schedule_message in its original shape arms a once input that fires at exactly its time", async function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "in ten", resetsAt: t.clock.now() + 10 * MIN });
    var rec = t.armed()[0];
    assert.equal(rec.kind, "once");
    assert.equal(rec.nextAt, t.clock.now() + 10 * MIN, "no buffer is added to a person's time");
    assert.equal(rec.createdBy, "browser:andy");
    await t.clock.advance(10 * MIN);
    var call = t.sessionInput.calls[0];
    assert.equal(call.prompt, "in ten");
    assert.equal(call.note, "scheduled message");
    assert.equal(call.initiator, "scheduled");
    assert.equal(t.sent.length, 0, "no error was sent");
  } finally { t.cleanup(); }
});

test("schedule_message with kind recurring arms a repeat with its end, labelled as a repeat", async function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "wake", kind: "recurring", every: 10 * MIN, count: 2 });
    var rec = t.armed()[0];
    assert.equal(rec.kind, "recurring");
    assert.equal(rec.count, 2);
    await t.clock.advance(10 * MIN);
    assert.equal(t.sessionInput.calls[0].note, "scheduled repeat");
    t.handle({ type: "schedule_message", text: "until", kind: "recurring", every: 10 * MIN, until: t.clock.now() + 60 * MIN });
    assert.equal(t.armed().length, 2);
  } finally { t.cleanup(); }
});

test("a bad request is answered to that browser with a plain error and arms nothing", function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "x", kind: "recurring", every: 10 * MIN });
    t.handle({ type: "schedule_message", text: "x", kind: "recurring", every: 30 * 1000, count: 2 });
    t.handle({ type: "schedule_message", text: "x", kind: "weekly", resetsAt: t.clock.now() + MIN });
    t.handle({ type: "schedule_message", text: "", resetsAt: t.clock.now() + MIN });
    t.handle({ type: "schedule_message", text: "x", resetsAt: "tomorrow" });
    assert.equal(t.armed().length, 0);
    assert.equal(t.sent.length, 5);
    t.sent.forEach(function (m) {
      assert.equal(m.type, "error");
      assert.match(m.text, /^Clagentic: Console could not schedule that: /);
    });
  } finally { t.cleanup(); }
});

test("the sixth input on the session on screen is refused with the limit named", function () {
  var t = setup();
  try {
    for (var i = 0; i < 5; i++) t.handle({ type: "schedule_message", text: "m" + i, resetsAt: t.clock.now() + (i + 1) * MIN });
    assert.equal(t.sent.length, 0);
    t.handle({ type: "schedule_message", text: "m5", resetsAt: t.clock.now() + 9 * MIN });
    assert.equal(t.armed().length, 5);
    assert.match(t.sent[0].text, /limit/);
  } finally { t.cleanup(); }
});

test("cancel by id deletes that input only; without an id (an older browser) the one that fires first", function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "late", resetsAt: t.clock.now() + 30 * MIN });
    t.handle({ type: "schedule_message", text: "soon", resetsAt: t.clock.now() + 5 * MIN });
    t.handle({ type: "schedule_message", text: "mid", resetsAt: t.clock.now() + 15 * MIN });
    var mid = t.armed().filter(function (r) { return r.preview === "mid"; })[0];
    t.handle({ type: "cancel_scheduled_message", id: mid.id });
    assert.deepEqual(t.armed().map(function (r) { return r.preview; }).sort(), ["late", "soon"]);
    t.handle({ type: "cancel_scheduled_message" });
    assert.deepEqual(t.armed().map(function (r) { return r.preview; }), ["late"]);
  } finally { t.cleanup(); }
});

test("send now by id, and without an id, delivers as scheduled-now even into a running turn", async function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "a", resetsAt: t.clock.now() + 60 * MIN });
    t.handle({ type: "schedule_message", text: "b", resetsAt: t.clock.now() + 90 * MIN });
    t.session.isProcessing = true;
    var b = t.armed().filter(function (r) { return r.preview === "b"; })[0];
    t.handle({ type: "send_scheduled_now", id: b.id });
    await fakes.flush();
    t.handle({ type: "send_scheduled_now" });
    await fakes.flush();
    assert.deepEqual(t.sessionInput.calls.map(function (c) { return c.prompt + ":" + c.initiator + ":" + c.force; }),
      ["b:scheduled-now:true", "a:scheduled-now:true"]);
    assert.equal(t.armed().length, 0);
  } finally { t.cleanup(); }
});

test("a browser cannot cancel or send another session's input", async function () {
  var other = fakes.makeSession(2, "vendor-2");
  var t = setup([other]);
  try {
    var made = t.service.create(SLUG, { target: targets.targetOf(other), session: other, kind: "once", text: "theirs", createdBy: "cli", at: t.clock.now() + 60 * MIN });
    t.handle({ type: "cancel_scheduled_message", id: made.record.id });
    t.handle({ type: "send_scheduled_now", id: made.record.id });
    await fakes.flush();
    assert.equal(t.service.list(SLUG, {}).count, 1);
    assert.equal(t.sessionInput.calls.length, 0);
  } finally { t.cleanup(); }
});

test("the list request answers the session on screen with its inputs and the limit; records made elsewhere show in it", function () {
  var t = setup();
  try {
    t.handle({ type: "schedule_message", text: "from the browser", resetsAt: t.clock.now() + 10 * MIN });
    // Made the way the CLI makes one: through the service, not the browser.
    t.service.create(SLUG, { target: targets.targetOf(t.session), session: t.session, kind: "recurring", text: "from the cli", createdBy: "cli:agent", every: 10 * MIN, count: 3 });
    t.handle({ type: "scheduled_input_list_request" });
    var list = t.sent[0];
    assert.equal(list.type, "scheduled_input_list");
    assert.equal(list.localId, 1);
    assert.equal(list.limit, 5);
    assert.deepEqual(list.inputs.map(function (r) { return r.text; }).sort(), ["from the browser", "from the cli"]);
    assert.deepEqual(list.inputs.map(function (r) { return r.createdBy; }).sort(), ["browser:andy", "cli:agent"]);
  } finally { t.cleanup(); }
});

test("a context built without the service answers an error rather than throwing", function () {
  var sent = [];
  var handlers = createWsHandlers({ slug: SLUG, service: null, getSessionForWs: function () { return {}; }, sendTo: function (w, o) { sent.push(o); } });
  assert.equal(handlers.handle({}, { type: "schedule_message", text: "x", resetsAt: 1 }), true);
  assert.equal(sent[0].type, "error");
});
