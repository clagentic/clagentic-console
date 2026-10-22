"use strict";
// The scheduled firing over the real session-input: it goes through deliver(),
// the path send-input uses, and leaves that path's other callers unchanged.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createSessionInput } = require("../lib/session-input");
var { INITIATORS } = require("../lib/turn-initiator");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createPublisher } = require("../lib/scheduled-input/ws");
var records = require("../lib/scheduled-input/records");
var fakes = require("./scheduled-input-fakes");

function makeWorld(sessions, extra) {
  var started = [];
  var pushed = [];
  var live = [];
  var processingChanges = 0;
  var map = new Map();
  sessions.forEach(function (s) { map.set(s.localId, Object.assign({ history: [], sentToolResults: {} }, s)); });
  var storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-delivery-"));
  var sm = Object.assign({
    sessions: map,
    sessionsDir: storeDir,
    recordHistoryEntry: function (s, e) { s.history.push(e); },
    appendToSessionFile: function () {},
    sendToSession: function (s, obj) { live.push(obj); },
    broadcastSessionList: function () {},
    resumeSession: function (id) {
      var s = { localId: 100 + map.size, cliSessionId: id, history: [], isProcessing: false, sentToolResults: {} };
      map.set(s.localId, s);
      return s;
    },
  }, extra && extra.sm);
  var project = {
    cwd: os.tmpdir(),
    sm: sm,
    sdk: {
      startQuery: function (s, text, images, user, initiator, messageId) { started.push({ text: text, initiator: initiator, user: user, messageId: messageId }); },
      pushMessage: function (s, text, images, initiator, messageId) { pushed.push({ text: text, initiator: initiator, messageId: messageId }); },
    },
    onProcessingChanged: function () { processingChanges++; },
    getLinuxUserForSession: function () { return "plain-user"; },
    ensureProjectAccessForSession: function () { return "granted-user"; },
  };
  var input = createSessionInput({ getProject: function (slug) { return slug === "p" ? project : null; } });
  return {
    input: input, project: project, sm: sm, started: started, pushed: pushed, live: live,
    processingChanges: function () { return processingChanges; },
    session: function (id) { return map.get(id); },
    cleanup: function () { fs.rmSync(storeDir, { recursive: true, force: true }); },
  };
}

function fire(w, extra) {
  return w.input.fireScheduled(Object.assign({ projectSlug: "p", sessionId: "vendor-1", prompt: "go", note: "scheduled message" }, extra));
}

test("an idle session with a live query takes the input as the next turn, recorded as the automation", function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: false, queryInstance: {} }]);
  try {
    var out = fire(w);
    assert.equal(out.ok, true);
    assert.equal(out.result, "delivered");
    assert.equal(w.pushed.length, 1);
    assert.equal(w.pushed[0].initiator, INITIATORS.SCHEDULED);
    var entry = w.session(1).history[0];
    assert.equal(entry.initiator, INITIATORS.SCHEDULED);
    assert.equal(entry.senderKind, "automation");
    assert.equal(entry.fromName, "Scheduled message");
    assert.equal(entry.contextNote, "scheduled message");
    assert.equal("source" in entry, false, "not the external-trigger shape");
    assert.equal(entry.messageId, w.pushed[0].messageId, "the vendor and the history name one message");
    assert.equal(w.sm.sessions.size, 1, "no session is made");
  } finally { w.cleanup(); }
});

test("a session without a runtime (reaped) is started on the same session and answered resumed-and-delivered", function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: false }]);
  try {
    var out = fire(w);
    assert.equal(out.result, "resumed-and-delivered");
    assert.equal(w.started.length, 1);
    assert.equal(w.started[0].text, "go");
    assert.equal(w.started[0].user, "granted-user", "a console automation also grants the project access, as the scheduled turn did");
    assert.equal(w.session(1).isProcessing, true);
    assert.deepEqual(w.live.map(function (m) { return m.type; }), ["user_message", "status"]);
    assert.equal(w.live[1].status, "processing");
    assert.equal(w.sm.sessions.size, 1);
  } finally { w.cleanup(); }
});

test("a session the store holds but memory does not is resumed by id and delivered", async function () {
  var w = makeWorld([]);
  try {
    fs.writeFileSync(path.join(w.sm.sessionsDir, "vendor-stored.jsonl"), JSON.stringify({ type: "meta", cliSessionId: "vendor-stored", title: "t" }) + "\n");
    var out = await fire(w, { sessionId: "vendor-stored" });
    assert.equal(out.result, "resumed-and-delivered");
    assert.equal(w.started.length, 1);
  } finally { w.cleanup(); }
});

test("a session nobody holds is not-found", async function () {
  var w = makeWorld([]);
  try {
    var out = await fire(w, { sessionId: "vendor-gone" });
    assert.equal(out.ok, false);
    assert.equal(out.result, "not-found");
    assert.equal(w.started.length + w.pushed.length, 0);
  } finally { w.cleanup(); }
});

test("a session that is mid-turn is skipped: nothing is delivered and the answer is busy and retryable", function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: true, queryInstance: {} }]);
  try {
    var out = fire(w);
    assert.equal(out.ok, false);
    assert.equal(out.result, "busy");
    assert.equal(out.retryable, true);
    assert.equal(w.pushed.length + w.started.length, 0);
    assert.equal(w.session(1).history.length, 0);
  } finally { w.cleanup(); }
});

test("send now (force) into a mid-turn session pushes the input into the running turn as scheduled-now", function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: true, queryInstance: {} }]);
  try {
    var out = fire(w, { force: true, initiator: INITIATORS.SCHEDULED_NOW });
    assert.equal(out.ok, true);
    assert.equal(w.pushed.length, 1);
    assert.equal(w.pushed[0].initiator, INITIATORS.SCHEDULED_NOW);
    assert.equal(w.session(1).history[0].initiator, INITIATORS.SCHEDULED_NOW);
    assert.equal(w.live.some(function (m) { return m.type === "status"; }), false, "the turn was already running; nothing new to announce");
  } finally { w.cleanup(); }
});

test("the console id names the session as well as the vendor id", function () {
  var w = makeWorld([{ localId: 5, cliSessionId: "vendor-5", isProcessing: false, queryInstance: {} }]);
  try {
    assert.equal(fire(w, { sessionId: "5" }).ok, true);
  } finally { w.cleanup(); }
});

test("only a scheduled initiator, a prompt and a safe session id are accepted", async function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: false, queryInstance: {} }]);
  try {
    assert.equal(fire(w, { initiator: INITIATORS.HUMAN }).result, "refused");
    assert.equal(fire(w, { initiator: INITIATORS.TRIGGER }).result, "refused");
    assert.equal(fire(w, { prompt: "" }).result, "refused");
    assert.equal(fire(w, { sessionId: "../x" }).result, "refused");
    assert.equal(fire(w, { projectSlug: "nope" }).result, "refused");
    assert.equal(w.pushed.length + w.started.length, 0);
  } finally { w.cleanup(); }
});

test("send-input is unchanged: it still records the external-trigger shape, and a caller cannot ask for the automation shape", async function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: false, queryInstance: {} }]);
  try {
    var out = await w.input.sendInput({
      projectSlug: "p", sessionId: "vendor-1", prompt: "hello", from: "ops-bot",
      automation: { note: "pretending to be the console" },
    });
    assert.equal(out.result, "delivered");
    var entry = w.session(1).history[0];
    assert.equal(entry.source, "external-trigger");
    assert.equal(entry.initiator, INITIATORS.TRIGGER);
    assert.equal(entry.senderKind, "declared");
    assert.equal(entry.fromName, "ops-bot");
    assert.equal("contextNote" in entry, false);
    assert.equal(w.pushed[0].initiator, INITIATORS.TRIGGER);
  } finally { w.cleanup(); }
});

test("send-input to a reaped session still starts the query as the plain OS user, with no status announcement", async function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: false }]);
  try {
    var out = await w.input.sendInput({ projectSlug: "p", sessionId: "vendor-1", prompt: "hello" });
    assert.equal(out.result, "resumed-and-delivered");
    assert.equal(w.started[0].user, "plain-user");
    assert.equal(w.live.some(function (m) { return m.type === "status"; }), false);
  } finally { w.cleanup(); }
});

test("a mid-turn send-input is still not skipped: it joins the running turn", async function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: true, queryInstance: {} }]);
  try {
    var out = await w.input.sendInput({ projectSlug: "p", sessionId: "vendor-1", prompt: "hello" });
    assert.equal(out.result, "delivered");
    assert.equal(w.pushed.length, 1);
  } finally { w.cleanup(); }
});

test("the busy answer is not logged on every retry, a delivery is", function () {
  var w = makeWorld([{ localId: 1, cliSessionId: "vendor-1", isProcessing: true, queryInstance: {} }]);
  var lines = [];
  var realLog = console.log;
  console.log = function (line) { lines.push(String(line)); };
  try {
    fire(w);
    w.session(1).isProcessing = false;
    fire(w);
  } finally {
    console.log = realLog;
    w.cleanup();
  }
  var mine = lines.filter(function (l) { return l.indexOf("fire_scheduled_input") !== -1; });
  assert.equal(mine.length, 1);
  assert.match(mine[0], /result=delivered/);
});

// --- lifecycle: a session closed or deleted ends its inputs; a reaped one does not ---
// Run over the real session manager.

var MIN = 60000;

function realWorld(extraSmOpts) {
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
        target: records.targetOf(session), session: session, kind: "once", text: "go", createdBy: "t", at: clock.now() + 60 * MIN,
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
  var w = realWorld({ onSessionRemoved: function (s) { seen.push(s.cliSessionId); } });
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
  var w = realWorld();
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
  var w = realWorld();
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
  var w = realWorld();
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
