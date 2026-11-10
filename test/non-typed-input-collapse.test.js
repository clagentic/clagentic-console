"use strict";
// Input pushed into a session (trigger send-input, loop, scheduled,
// scheduled-now) renders collapsed to about three lines with Expand, through the
// one shared collapsible-text component, live and on history replay. The
// operator's typed input and the session agent's replies never collapse. No
// browser: the real renderer and outbox run over the hand-built DOM.

var test = require("node:test");
var assert = require("node:assert/strict");

var dom = require("./fake-dom-prompt-cards");

var LONG = Array.from({ length: 10 }, function (_, i) { return "line " + (i + 1) + " of the pushed text"; }).join("\n");
var LONG_ONE_LINE = "x".repeat(400);
var SHORT = "a short pushed message";
var THREE = "one\ntwo\nthree";

function press(el) { el._listeners.click.forEach(function (fn) { fn({ stopPropagation: function () {} }); }); }

// The wire record of a user_message, as the server sends it live and in replay.
function record(initiator, extra) {
  return Object.assign({ entryFormat: 1, initiator: initiator }, extra || {});
}

var PUSHED = [
  { kind: "trigger", msg: record("trigger", { senderKind: "extracted", fromName: "lane@proj", contextNote: "report" }) },
  { kind: "loop", msg: record("loop", { senderKind: "automation", fromName: "loop" }) },
  { kind: "scheduled", msg: record("scheduled", { senderKind: "automation", fromName: "scheduler" }) },
  { kind: "scheduled-now", msg: record("scheduled-now", { senderKind: "automation", fromName: "scheduler" }) },
];

var sharedMessages = new dom.FakeElement("div");
var rendering = null;
var label = null;

async function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  sharedMessages._children = [];
  document.getElementById = function (id) { return id === "messages" ? sharedMessages : null; };
  var realQuery = dom.FakeElement.prototype.querySelector;
  dom.FakeElement.prototype.querySelector = function (sel) {
    return realQuery.call(this, sel) || (/^\.msg-action-/.test(sel) ? new dom.FakeElement("button") : null);
  };
  t.after(function () { dom.FakeElement.prototype.querySelector = realQuery; });
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, myUserId: "me", cachedAllUsers: [{ id: "me", username: "me" }] });
  rendering = await import(dom.moduleUrl("app-rendering.js") + "?collapse=non-typed");
  label = await import(dom.moduleUrl("injected-label.js"));
}

function lastRow() {
  var rows = sharedMessages.querySelectorAll(".msg-user");
  return rows[rows.length - 1];
}

PUSHED.forEach(function (p) {
  test("a long " + p.kind + " message collapses to a three-line preview with Expand; the full text stays whole", async function (t) {
    await setup(t);
    rendering.addUserMessage(LONG, null, null, undefined, undefined, label.injectedFromMessage(p.msg));
    var row = lastRow();
    var text = row.querySelector(".collapsible-text");
    assert.ok(text, "collapses");
    assert.ok(text.classList.contains("is-collapsed"));
    assert.equal(row.querySelector(".collapsible-preview").textContent, "line 1 of the pushed text\nline 2 of the pushed text\nline 3 of the pushed text");
    assert.equal(row.querySelector(".collapsible-full").textContent, LONG, "the full text is in the DOM, uncut");
    var toggle = row.querySelector(".collapsible-toggle");
    assert.equal(toggle.textContent, "Expand");
    press(toggle);
    assert.equal(text.classList.contains("is-collapsed"), false);
    assert.equal(toggle.textContent, "Collapse");
    press(toggle);
    assert.ok(text.classList.contains("is-collapsed"));
  });

  test("a long single-line " + p.kind + " message collapses and keeps its whole text", async function (t) {
    await setup(t);
    rendering.addUserMessage(LONG_ONE_LINE, null, null, undefined, undefined, label.injectedFromMessage(p.msg));
    var row = lastRow();
    assert.ok(row.querySelector(".collapsible-toggle"));
    assert.equal(row.querySelector(".collapsible-preview").textContent, LONG_ONE_LINE);
  });

  test("a short " + p.kind + " message and a three-line one render in full with no Expand", async function (t) {
    await setup(t);
    rendering.addUserMessage(SHORT, null, null, undefined, undefined, label.injectedFromMessage(p.msg));
    assert.equal(lastRow().querySelector(".collapsible-toggle"), null);
    assert.equal(lastRow().querySelector(".bubble").textContent, SHORT);
    rendering.addUserMessage(THREE, null, null, undefined, undefined, label.injectedFromMessage(p.msg));
    assert.equal(lastRow().querySelector(".collapsible-toggle"), null, "three lines is not more than three");
  });
});

test("a long message the operator typed never collapses", async function (t) {
  await setup(t);
  rendering.addUserMessage(LONG, null, null, "me", "Me");
  var row = lastRow();
  assert.equal(row.querySelector(".collapsible-text"), null);
  assert.equal(row.querySelector(".collapsible-toggle"), null);
  assert.equal(row.querySelector(".bubble").textContent, LONG);
  // The same entry as the server records it for the browser composer.
  var typed = label.injectedFromMessage(record("human"));
  assert.equal(typed, null, "a human-initiated entry is not injected");
  rendering.addUserMessage(LONG_ONE_LINE, null, null, undefined, undefined, typed);
  assert.equal(lastRow().querySelector(".collapsible-toggle"), null);
});

test("a long reply from the session's agent never collapses", async function (t) {
  await setup(t);
  var assistantStore = await import(dom.moduleUrl("store.js"));
  assistantStore.store.set({ currentMsgEl: null });
  rendering.ensureAssistantBlock();
  rendering.appendDelta(LONG);
  rendering.flushStreamBuffer();
  var reply = sharedMessages.querySelectorAll(".msg-assistant")[0];
  assert.ok(reply, "the reply block is drawn");
  assert.equal(reply.querySelector(".collapsible-text"), null);
  assert.equal(reply.querySelector(".collapsible-toggle"), null);
});

test("the outbox row of a long armed schedule uses the three-line rule and Expand", async function (t) {
  dom.setupGlobals();
  document.removeEventListener = function () {};
  var messages = new dom.FakeElement("div");
  document.getElementById = function (id) { return id === "messages" ? messages : null; };
  var ob = await import(dom.moduleUrl("scheduled-outbox.js") + "?collapse=outbox");
  try {
    ob.renderScheduledOutbox([
      { id: "si_l", kind: "once", text: LONG, nextAt: Date.now() + 60000 },
      { id: "si_3", kind: "once", text: THREE, nextAt: Date.now() + 60000 },
    ]);
    var rows = messages.querySelectorAll(".scheduled-queued");
    assert.equal(rows[0].querySelector(".collapsible-preview").textContent, "line 1 of the pushed text\nline 2 of the pushed text\nline 3 of the pushed text");
    assert.equal(rows[0].querySelector(".collapsible-full").textContent, LONG);
    assert.equal(rows[0].querySelector(".collapsible-toggle").textContent, "Expand");
    assert.equal(rows[1].querySelector(".collapsible-toggle"), null, "three lines renders in full");
  } finally { ob.removeScheduledOutbox(); }
});

test("one predicate: pushed-in descriptors collapse, a typed one and none do not", async function () {
  var m = await import(dom.moduleUrl("collapsible-text.js"));
  var lbl = await import(dom.moduleUrl("injected-label.js"));
  PUSHED.forEach(function (p) {
    assert.equal(m.isNonTypedInput(lbl.injectedFromMessage(p.msg)), true, p.kind);
  });
  assert.equal(m.isNonTypedInput(null), false);
  assert.equal(m.isNonTypedInput(undefined), false);
  assert.equal(m.needsCollapse("a\nb\nc"), false);
  assert.equal(m.needsCollapse("a\nb\nc\nd"), true);
  assert.equal(m.needsCollapse("a\nb\nc\n"), false, "a trailing newline is not a line");
  assert.equal(m.needsCollapse("x".repeat(m.COLLAPSE_CHAR_LIMIT)), false);
  assert.equal(m.needsCollapse("x".repeat(m.COLLAPSE_CHAR_LIMIT + 1)), true);
});
