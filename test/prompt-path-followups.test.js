"use strict";
// Three corners of the prompt path found in review of the prompt registry:
// a tool-use id that two sessions share must not take over the other
// session's request index entry; a recorded AskUserQuestion skip is an answer,
// not an ending nobody chose; and a send that throws is not "Not connected".

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");
var { createPromptRegistry } = require("../lib/prompt-registry");

var QUESTIONS = { questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] };

function twoSessionRegistry() {
  var sessions = { 1: { localId: 1, queryInstance: null }, 2: { localId: 2, queryInstance: null } };
  var index = Object.create(null);
  var registry = createPromptRegistry({
    index: index,
    getSession: function (localId) { return sessions[localId] || null; },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
  });
  return { sessions: sessions, index: index, registry: registry };
}

test("a tool-use id two sessions share is the request id of only the first; the other session's prompt gets its own", async function () {
  var w = twoSessionRegistry();
  var a = w.registry.open(w.sessions[1], "ask_user", { input: QUESTIONS }, { toolUseId: "tu-same" });
  var b = w.registry.open(w.sessions[2], "ask_user", { input: QUESTIONS }, { toolUseId: "tu-same" });

  assert.equal(a.requestId, "tu-same", "the first session's AskUserQuestion card and prompt are one request");
  assert.notEqual(b.requestId, "tu-same", "the second session's does not take that id over");
  assert.equal(w.index["tu-same"], 1, "the index still routes the id to the session that holds it");

  var wrong = w.registry.respond("tu-same", { decision: "skip" });
  assert.equal(wrong.status, "resolved");
  assert.equal(wrong.session.localId, 1, "an answer for the shared id reaches the first session's prompt");
  assert.equal(w.registry.lookup(b.requestId).session.localId, 2, "the second session's prompt is still pending, under its own id");

  var other = w.registry.respond(b.requestId, { decision: "skip" });
  assert.equal(other.status, "resolved");
  assert.equal(other.session.localId, 2);
  assert.equal((await a.answer).behavior, "deny");
  assert.equal((await b.answer).behavior, "deny");
});

test("once the first session's prompt has settled, its tool-use id is free to name another session's", async function () {
  var w = twoSessionRegistry();
  var a = w.registry.open(w.sessions[1], "ask_user", { input: QUESTIONS }, { toolUseId: "tu-reuse" });
  w.registry.respond(a.requestId, { decision: "skip" });
  var b = w.registry.open(w.sessions[2], "ask_user", { input: QUESTIONS }, { toolUseId: "tu-reuse" });
  assert.equal(b.requestId, "tu-reuse");
});

function askHistory(ended) {
  return [{ type: "tool_executing", name: "AskUserQuestion", id: "q1", input: QUESTIONS }, ended];
}

test("a recorded AskUserQuestion skip replays as skipped, an ending with no answer as cancelled, on the server", function () {
  var w = twoSessionRegistry();
  var session = w.sessions[1];
  var skipped = askHistory({ type: "ask_user_answered", toolId: "q1", answers: {}, skipped: true });
  assert.deepEqual(w.registry.replayAnnotator(session, skipped, 0)(skipped[0]).promptState, { state: "resolved", skipped: true });

  var answered = askHistory({ type: "ask_user_answered", toolId: "q1", answers: { 0: "a" } });
  assert.deepEqual(w.registry.replayAnnotator(session, answered, 0)(answered[0]).promptState, { state: "resolved", answers: { 0: "a" } });

  var ended = askHistory({ type: "ask_user_answered", toolId: "q1" });
  assert.deepEqual(w.registry.replayAnnotator(session, ended, 0)(ended[0]).promptState, { state: "cancelled", reason: null });
});

test("the client reads the same three recorded endings the same way", async function () {
  dom.setupGlobals();
  var { normalizePromptMessage } = await import(dom.moduleUrl("prompt-state.js"));
  var skipped = normalizePromptMessage({ type: "ask_user_answered", toolId: "q1", answers: {}, skipped: true });
  assert.equal(skipped.phase, "resolved");
  assert.deepEqual(skipped.fields, { skipped: true });
  assert.equal(normalizePromptMessage({ type: "ask_user_answered", toolId: "q1", answers: { 0: "a" } }).phase, "resolved");
  assert.equal(normalizePromptMessage({ type: "ask_user_answered", toolId: "q1" }).phase, "cancel");
  assert.equal(normalizePromptMessage({ type: "ask_user_answered", toolId: "q1", skipped: "yes" }).phase, "cancel", "only a real true is a skip");
});

test("a send that throws is reported as what it is, not as a dropped connection, and the card stays answerable", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var card = await import(dom.moduleUrl("prompt-card.js"));
  var logged = [];
  var original = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    var container = new dom.FakeElement("div");
    var actions = container.appendChild(new dom.FakeElement("div"));
    actions.className = "permission-actions";
    var button = actions.appendChild(new dom.FakeElement("button"));

    var sent = card.submitPromptResponse(container, function () { throw new Error("socket write failed"); });
    assert.equal(sent, false);
    assert.match(container.textContent, /Could not send the answer \(socket write failed\)/);
    assert.doesNotMatch(container.textContent, /Not connected/);
    assert.equal(container.classList.contains("sending"), false);
    assert.equal(button.disabled, false, "the operator can choose again");
    assert.equal(logged.length, 1, "and the failure is logged, not swallowed");

    assert.equal(card.submitPromptResponse(container, function () { return false; }), false);
    assert.match(container.textContent, /Not connected/, "a socket that is not usable still says so");
  } finally {
    console.error = original;
  }
});
