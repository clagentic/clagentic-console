"use strict";
// Every open-session and send-input request leaves one journal line naming the
// project, the console session and the result, whichever caller made it, and a
// refusal says why. The prompt is never in it.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSessionInput } = require("../lib/session-input");
var { handleSessionCommand } = require("../lib/session-input-ipc");

var SECRET = "SECRET-PROMPT-TEXT-do-not-log";

function makeProject(opts) {
  opts = opts || {};
  var nextId = 7;
  var sm = {
    sessions: new Map(),
    sessionsDir: opts.sessionsDir,
    defaultVendor: "claude",
    createSession: function (o) {
      var s = { localId: nextId++, history: [], vendor: o.vendor || null, agentName: o.agentName || null, cliSessionId: null };
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function () {},
    appendToSessionFile: function () {},
    deleteSession: function (id) { sm.sessions.delete(id); },
    resumeSession: function () { return null; },
  };
  (opts.existing || []).forEach(function (s) { sm.sessions.set(s.localId, s); });
  return {
    cwd: "/unused",
    sm: sm,
    sdk: {
      startQuery: opts.startQuery || function () {},
      pushMessage: function () {},
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

function makeInput(project) {
  return createSessionInput({
    getProject: function (slug) { return slug === "alpha" ? project : null; },
    agentCatalog: function () { return [{ name: "holden" }]; },
  });
}

function captureLog(t) {
  var lines = [];
  t.mock.method(console, "log", function () { lines.push(Array.prototype.join.call(arguments, " ")); });
  return {
    all: lines,
    inputLines: function () { return lines.filter(function (l) { return l.indexOf("[session-input]") === 0; }); },
  };
}

function live(localId, extra) {
  return Object.assign({ localId: localId, cliSessionId: "cli-" + localId, history: [], isProcessing: false, queryInstance: {} }, extra || {});
}

test("a send to a live session logs project, console session id and the result", function (t) {
  var log = captureLog(t);
  var project = makeProject({ existing: [live(100)] });
  var r = makeInput(project).sendInput({ projectSlug: "alpha", sessionId: "cli-100", prompt: SECRET });
  assert.equal(r.result, "delivered");
  assert.deepEqual(log.inputLines(), ["[session-input] send_session_input: project=alpha session=100 result=delivered"]);
});

test("a send that has to start the session's runtime again logs resumed-and-delivered", function (t) {
  var log = captureLog(t);
  var project = makeProject({ existing: [live(101, { queryInstance: null })] });
  var r = makeInput(project).sendInput({ projectSlug: "alpha", sessionId: "101", prompt: SECRET });
  assert.equal(r.result, "resumed-and-delivered");
  assert.deepEqual(log.inputLines(), ["[session-input] send_session_input: project=alpha session=101 result=resumed-and-delivered"]);
});

test("an open logs the new console session id and the opened result", function (t) {
  var log = captureLog(t);
  var project = makeProject({});
  var r = makeInput(project).openSession({ projectSlug: "alpha", prompt: SECRET });
  assert.equal(r.result, "opened");
  assert.deepEqual(log.inputLines(), ["[session-input] open_session: project=alpha session=7 result=opened"]);
});

test("not-found is logged with the id the caller asked for", async function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-sil-"));
  try {
    var log = captureLog(t);
    var r = await makeInput(makeProject({ sessionsDir: dir })).sendInput({ projectSlug: "alpha", sessionId: "gone", prompt: SECRET });
    assert.equal(r.result, "not-found");
    var lines = log.inputLines();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[session-input\] send_session_input: project=alpha session=gone result=not-found reason=no session "gone"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a start that fails is logged as an error with its reason, retryable", async function (t) {
  var log = captureLog(t);
  t.mock.method(console, "error", function () {});
  var project = makeProject({
    existing: [live(102, { queryInstance: null })],
    startQuery: function () { return Promise.reject(new Error("vendor down")); },
  });
  var r = await makeInput(project).sendInput({ projectSlug: "alpha", sessionId: "102", prompt: SECRET });
  assert.equal(r.result, "error");
  assert.deepEqual(log.inputLines(), ["[session-input] send_session_input: project=alpha session=102 result=error retryable=true reason=turn start failed: vendor down"]);
});

test("each refusal is logged once, with its reason, and never with the prompt", async function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-sil-"));
  try {
    var log = captureLog(t);
    var input = makeInput(makeProject({ sessionsDir: dir, existing: [live(100)] }));
    var cases = [
      [function () { return input.sendInput({ projectSlug: "alpha", sessionId: "cli-100", prompt: SECRET, initiator: "human" }); }, /initiator "human" refused/],
      [function () { return input.sendInput({ projectSlug: "alpha", sessionId: "../../etc/passwd", prompt: SECRET }); }, /unsafe session id/],
      [function () { return input.openSession({ projectSlug: "alpha", prompt: SECRET, vendor: "nonesuch" }); }, /unknown vendor "nonesuch"/],
      [function () { return input.openSession({ projectSlug: "alpha", prompt: SECRET, agentName: "nobody" }); }, /unknown agent "nobody"/],
      [function () { return input.openSession({ projectSlug: "elsewhere", prompt: SECRET }); }, /unknown project "elsewhere"/],
    ];
    for (var i = 0; i < cases.length; i++) {
      var before = log.inputLines().length;
      var r = await cases[i][0]();
      assert.equal(r.result, "refused");
      var added = log.inputLines().slice(before);
      assert.equal(added.length, 1, "exactly one line for refusal " + i);
      assert.match(added[0], /result=refused reason=/);
      assert.match(added[0], cases[i][1]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reason that carries a newline stays on one line", function (t) {
  var log = captureLog(t);
  var input = makeInput(makeProject({}));
  input.openSession({ projectSlug: "alpha", prompt: SECRET, agentName: "a\nFORGED [daemon] line" });
  var lines = log.all.filter(function (l) { return l.indexOf("FORGED") !== -1; });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].indexOf("\n"), -1);
});

test("the IPC verbs are logged through the same path and the prompt appears in no line", async function (t) {
  var log = captureLog(t);
  var input = makeInput(makeProject({ existing: [live(100)] }));
  await handleSessionCommand(input, { cmd: "send_session_input", projectSlug: "alpha", sessionId: "cli-100", prompt: SECRET, contextNote: SECRET });
  await handleSessionCommand(input, { cmd: "open_session", projectSlug: "alpha", prompt: SECRET, contextNote: SECRET });
  assert.equal(log.inputLines().length, 2);
  log.all.forEach(function (l) { assert.equal(l.indexOf(SECRET), -1, "no line carries the prompt: " + l); });
});
