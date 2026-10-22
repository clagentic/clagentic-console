"use strict";
// A session that is closed or deleted ends its scheduled inputs; one whose
// runtime was reaped does not. Run over the real session manager.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createPublisher } = require("../lib/scheduled-input/publisher");
var targets = require("../lib/scheduled-input/target");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;

function world(extraSmOpts) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-lifecycle-"));
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var sessionsModule = require("../lib/sessions");
  var noop = function () {};
  var service = null;
  var project = { cwd: home };
  var sm = sessionsModule.createSessionManager(Object.assign({
    cwd: home, send: noop, sendTo: noop, sendEach: noop,
    onSessionRemoved: function (session) { if (service) service.sessionEnded("p", session); },
  }, extraSmOpts));
  project.sm = sm;
  var clock = fakes.makeClock();
  service = createScheduledInputService({
    dir: path.join(home, "scheduled-input"),
    getProject: function (slug) { return slug === "p" ? project : null; },
    sessionInput: { fireScheduled: function () { return { ok: true, result: "delivered" }; } },
    publish: createPublisher({
      getProject: function (slug) { return slug === "p" ? project : null; },
      listFor: function (slug, session) { return service.armedForSession(slug, session); },
    }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject("p");
  return {
    home: home, sm: sm, service: service, clock: clock,
    arm: function (session, extra) {
      return service.create("p", Object.assign({
        target: targets.targetOf(session), session: session, kind: "once", text: "go", createdBy: "t", at: clock.now() + 60 * MIN,
      }, extra));
    },
    cleanup: function () {
      service.stop();
      if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
      ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("the session manager tells a listener which session was removed, on both delete paths", function () {
  var seen = [];
  var w = world({ onSessionRemoved: function (s) { seen.push(s.cliSessionId); } });
  try {
    var a = w.sm.createSessionRaw({});
    a.cliSessionId = "vendor-a";
    var b = w.sm.createSessionRaw({});
    b.cliSessionId = "vendor-b";
    var c = w.sm.createSessionRaw({});
    c.cliSessionId = "vendor-c";
    w.sm.deleteSession(a.localId, null);
    w.sm.deleteSessionsBulk([b.localId, c.localId], null);
    assert.deepEqual(seen.sort(), ["vendor-a", "vendor-b", "vendor-c"]);
  } finally { w.cleanup(); }
});

test("deleting a session ends its armed inputs and leaves another session's alone", function () {
  var w = world();
  try {
    var doomed = w.sm.createSessionRaw({});
    doomed.cliSessionId = "vendor-doomed";
    var kept = w.sm.createSessionRaw({});
    kept.cliSessionId = "vendor-kept";
    w.arm(doomed);
    w.arm(doomed, { kind: "recurring", at: undefined, every: 10 * MIN, count: 3 });
    w.arm(kept);
    w.sm.deleteSession(doomed.localId, null);
    var ended = w.service.list("p", { state: "ended" });
    assert.equal(ended.count, 2);
    assert.match(ended.inputs[0].endReason, /closed or deleted/);
    assert.equal(w.service.list("p", {}).count, 1);
    assert.equal(w.service.list("p", {}).inputs[0].sessionId, "vendor-kept");
  } finally { w.cleanup(); }
});

test("ending the inputs of a deleted session writes nothing into the session it removed", function () {
  var w = world();
  try {
    var doomed = w.sm.createSessionRaw({});
    doomed.cliSessionId = "vendor-file";
    w.sm.saveSessionFile(doomed);
    var file = path.join(w.sm.sessionsDir, "vendor-file.jsonl");
    w.arm(doomed);
    assert.equal(fs.existsSync(file), true);
    w.sm.deleteSession(doomed.localId, null);
    // The buffered writes are drained on exit; none may have been queued for the
    // deleted session by the end event.
    assert.equal(fs.existsSync(file), false, "the deleted session's file stays deleted");
    assert.equal(doomed.history.filter(function (e) { return /^scheduled_message_/.test(e.type); }).length, 1, "only the queued event from before the delete");
  } finally { w.cleanup(); }
});

test("a session whose runtime is reaped keeps its inputs: it is still in the manager and still addressed", function () {
  var w = world();
  try {
    var s = w.sm.createSessionRaw({});
    s.cliSessionId = "vendor-reaped";
    var made = w.arm(s);
    s.queryInstance = null;
    s.isProcessing = false;
    assert.equal(w.service.list("p", {}).count, 1);
    assert.equal(w.service.armedForSession("p", s)[0].id, made.record.id);
  } finally { w.cleanup(); }
});
