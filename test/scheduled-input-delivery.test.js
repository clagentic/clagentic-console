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
