"use strict";
// Armed scheduled inputs are drawn in the composer's outbox, beside the queued
// chat and ! items, with Fire now and Cancel. The scheduled-input service is the
// store and the scheduler: the page draws the list the server sends and sends
// run-now and cancel back. Over the fake DOM, driving the client's own modules.

var test = require("node:test");
var assert = require("node:assert/strict");

var dom = require("./fake-dom-prompt-cards");

// The page's message list is looked up once by the rendering module, so every
// test draws into the same element, emptied between tests.
var sharedMessages = null;

async function boot() {
  if (!sharedMessages) {
    dom.setupGlobals();
    document.removeEventListener = function () {};
    sharedMessages = new dom.FakeElement("div");
    document.getElementById = function (id) { return id === "messages" ? sharedMessages : null; };
  }
  var messages = sharedMessages;
  messages._children = [];
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, activeSessionId: "A", currentVendor: "claude", replayingHistory: false, processing: false, myUserId: "me", cachedAllUsers: [] });
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  var frames = [];
  wsRef.setWs({ readyState: 1, send: function (body) { frames.push(JSON.parse(body)); } });
  var rl = await import(dom.moduleUrl("app-rate-limit.js"));
  return { messages: messages, store: storeMod.store, frames: frames, rl: rl, wsRef: wsRef };
}

function done(env) {
  env.rl.resetRateLimitState();
  env.wsRef.setWs(null);
}

function list(localId, inputs) {
  return { type: "scheduled_input_list", localId: localId, limit: 5, inputs: inputs };
}

function once(id, text, ms) {
  return { id: id, kind: "once", createdBy: "browser", text: text, nextAt: Date.now() + (ms || 60000), firedCount: 0 };
}

function rows(env) { return env.messages.querySelectorAll(".scheduled-queued"); }

// The page mints a requestId per request; the tests that name the frame's other
// fields compare without it, and the ones about the id read it from the frame.
function noRequestId(frame) {
  var copy = Object.assign({}, frame);
  assert.equal(typeof copy.requestId, "string", "every outbox request carries a requestId");
  delete copy.requestId;
  return copy;
}

function recurring(id, text, ms) {
  return { id: id, kind: "recurring", every: 60000, createdBy: "browser", text: text, nextAt: Date.now() + (ms || 60000), firedCount: 0 };
}

test("an armed schedule is an outbox item with its fire time, Fire now and Cancel sized like the queued controls", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "wake up", 90000)]));
    var items = rows(env);
    assert.equal(items.length, 1);
    assert.ok(items[0].classList.contains("shell-queued"), "drawn as a queued outbox item");
    assert.match(items[0].querySelector(".scheduled-queued-time").textContent, /^Sends at .* \(1m \d+s\)$/, "its fire time");
    assert.equal(items[0].querySelector(".shell-queued-text").textContent, "wake up");
    var fire = items[0].querySelector(".scheduled-queued-fire");
    var cancel = items[0].querySelector(".scheduled-queued-cancel");
    assert.equal(fire.textContent, "Fire now");
    assert.equal(cancel.textContent, "Cancel");
    assert.ok(fire.classList.contains("shell-queued-btn") && cancel.classList.contains("shell-queued-btn"), "the queued controls' size class");
    assert.equal(items[0].querySelectorAll(".shell-queued-edit").length, 0, "a schedule has no Edit here");
  } finally { done(env); }
});

test("one rendering per schedule: the pending card is replaced by the outbox item", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "a"), once("si_2", "b")]));
    assert.equal(rows(env).length, 2);
    assert.equal(env.messages.querySelectorAll(".scheduled-msg-wrap").length, 0, "no second card");
  } finally { done(env); }
});

test("Fire now sends run-now for that schedule once; Cancel sends cancel for it", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first"), once("si_2", "second")]));
    var items = rows(env);
    items[1].querySelector(".scheduled-queued-fire").click();
    items[0].querySelector(".scheduled-queued-cancel").click();
    assert.deepEqual(env.frames.map(noRequestId), [
      { type: "send_scheduled_now", id: "si_2" },
      { type: "cancel_scheduled_message", id: "si_1" },
    ]);
    assert.notEqual(env.frames[0].requestId, env.frames[1].requestId, "each request has its own id");
  } finally { done(env); }
});

test("Fire now stays available while a turn runs; the server delivers it as a person's message", async function () {
  var env = await boot();
  try {
    env.store.set({ processing: true });
    env.rl.applyScheduledInputList(list("A", [once("si_1", "now")]));
    var fire = rows(env)[0].querySelector(".scheduled-queued-fire");
    assert.equal(fire.getAttribute("aria-disabled"), "false");
    fire.click();
    assert.deepEqual(env.frames.map(noRequestId), [{ type: "send_scheduled_now", id: "si_1" }]);
  } finally { done(env); }
});

test("the outbox follows the service's list: a fired or cancelled schedule leaves, a list for another session is not drawn", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "one"), once("si_2", "two")]));
    assert.equal(rows(env).length, 2);
    env.rl.applyScheduledInputList(list("A", [once("si_2", "two")]));
    var left = rows(env);
    assert.equal(left.length, 1);
    assert.equal(left[0].getAttribute("data-id"), "si_2");
    env.rl.applyScheduledInputList(list("B", [once("si_9", "elsewhere")]));
    assert.equal(rows(env).length, 1);
    assert.equal(env.messages.textContent.indexOf("elsewhere"), -1);
    env.rl.applyScheduledInputList(list("A", []));
    assert.equal(rows(env).length, 0);
    assert.equal(env.rl.getScheduledMsgEl(), null);
  } finally { done(env); }
});

test("switching away and back draws exactly the session's list and asks the service for the current one", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "one")]));
    env.rl.applyScheduledInputList(list("B", [once("si_9", "other"), once("si_8", "other two")]));
    env.store.set({ activeSessionId: "B" });
    env.rl.resetRateLimitState();
    env.rl.restoreRateLimitStateForSession("B");
    assert.deepEqual(rows(env).map(function (r) { return r.getAttribute("data-id"); }), ["si_9", "si_8"]);
    env.store.set({ activeSessionId: "A" });
    env.rl.resetRateLimitState();
    env.rl.restoreRateLimitStateForSession("A");
    assert.deepEqual(rows(env).map(function (r) { return r.getAttribute("data-id"); }), ["si_1"]);
    assert.equal(env.frames.filter(function (f) { return f.type === "scheduled_input_list_request"; }).length, 2);
  } finally { done(env); }
});

test("the schedules stay after the queued items of the message list", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "one")]));
    var rendering = await import(dom.moduleUrl("app-rendering.js"));
    var queued = new dom.FakeElement("div");
    rendering.addToMessages(queued);
    var kids = env.messages.children;
    assert.equal(kids[kids.length - 1], env.rl.getScheduledMsgEl(), "the schedules are last");
    assert.equal(kids[kids.length - 2], queued);
  } finally { done(env); }
});

test("queued in-flight messages stay at the bottom in queue order, below new turn output, until each leaves", async function () {
  var env = await boot();
  try {
    var rendering = await import(dom.moduleUrl("app-rendering.js"));
    var first = new dom.FakeElement("div");
    var second = new dom.FakeElement("div");
    var output1 = new dom.FakeElement("div");
    var output2 = new dom.FakeElement("div");
    rendering.keepAtBottom(first);
    rendering.addToMessages(first);
    rendering.addToMessages(output1);
    rendering.keepAtBottom(second);
    rendering.addToMessages(second);
    rendering.addToMessages(output2);
    assert.deepEqual(env.messages.children, [output1, output2, first, second]);

    rendering.releaseFromBottom(first);
    first.remove();
    var output3 = new dom.FakeElement("div");
    rendering.addToMessages(output3);
    assert.deepEqual(env.messages.children, [output1, output2, output3, second]);
    rendering.releaseFromBottom(second);
  } finally { done(env); }
});

test("the capability table has one entry per kind, and the scheduled Send now is Fire now", async function () {
  var sn = await import(dom.moduleUrl("send-now.js"));
  assert.deepEqual(Object.keys(sn.SEND_NOW_BY_KIND).sort(), ["chat", "scheduled", "shell"]);
  assert.deepEqual(Object.keys(sn.QUEUED_CONTROLS_BY_KIND).sort(), ["chat", "scheduled", "shell"]);
  assert.equal(sn.sendNowLabel("scheduled"), "Fire now");
  assert.equal(sn.sendNowLabel("shell"), "Send now");
  assert.equal(sn.sendNowForKind("scheduled", false, null).mode, "fire");
  assert.equal(sn.sendNowForKind("scheduled", true, null).mode, "fire", "the service delivers it into a running turn");
  assert.equal(sn.sendNowForKind("shell", true, null).mode, "disabled", "a ! item still waits for the turn");
  assert.equal(sn.queuedControlsForKind("scheduled", null).cancel.enabled, true);
});

test("a double click on Fire now sends one send_scheduled_now; the row is busy until the server's list drops it", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first"), once("si_2", "second")]));
    var row = rows(env)[0];
    var fire = row.querySelector(".scheduled-queued-fire");
    var cancel = row.querySelector(".scheduled-queued-cancel");
    fire.click();
    fire.click();
    cancel.click();
    assert.deepEqual(env.frames.map(noRequestId), [{ type: "send_scheduled_now", id: "si_1" }]);
    assert.equal(fire.disabled, true);
    assert.equal(cancel.disabled, true);
    var other = rows(env)[1];
    assert.equal(other.querySelector(".scheduled-queued-fire").disabled, false, "other rows are not held");
    // A list push that still has the row keeps it held, redrawn.
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first"), once("si_2", "second")]));
    assert.equal(rows(env)[0].querySelector(".scheduled-queued-fire").disabled, true);
    // The row leaves only through the server's list.
    env.rl.applyScheduledInputList(list("A", [once("si_2", "second")]));
    assert.equal(rows(env).length, 1);
  } finally { done(env); }
});

test("a refused send frees the row and shows the failure", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first")]));
    env.wsRef.setWs({ readyState: 3, send: function () {} });
    var row = rows(env)[0];
    row.querySelector(".scheduled-queued-fire").click();
    assert.equal(row.querySelector(".scheduled-queued-fire").disabled, false);
    assert.equal(row.querySelector(".scheduled-queued-cancel").disabled, false);
    assert.match(row.querySelector(".scheduled-queued-error").textContent, /connection is not open/);
    assert.equal(rows(env).length, 1, "the row stays");
  } finally { done(env); }
});

test("a server error reply frees the row, shows the failure, and the row stays", async function () {
  var env = await boot();
  try {
    var ob = await import(dom.moduleUrl("scheduled-outbox.js"));
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first")]));
    var row = rows(env)[0];
    row.querySelector(".scheduled-queued-cancel").click();
    assert.equal(row.querySelector(".scheduled-queued-cancel").disabled, true);
    ob.failScheduledRequests("Clagentic: Console could not cancel that: busy", env.frames[0].requestId);
    assert.equal(row.querySelector(".scheduled-queued-fire").disabled, false);
    assert.equal(row.querySelector(".scheduled-queued-cancel").disabled, false);
    assert.match(row.querySelector(".scheduled-queued-error").textContent, /could not cancel that/);
    assert.equal(rows(env).length, 1);
    row.querySelector(".scheduled-queued-cancel").click();
    assert.equal(env.frames.length, 2, "a retry is allowed after the failure");
  } finally { done(env); }
});

// Frames go through the app's real message handler, as the socket delivers them.
async function handler() {
  // The fake DOM does not parse innerHTML, so a system message's text span is
  // absent; a stub stands in so the real error handler can run to its end.
  var find = dom.FakeElement.prototype.querySelector;
  if (!find._scheduledOutboxStub) {
    var patched = function (sel) { return find.call(this, sel) || (sel === ".sys-text" ? {} : null); };
    patched._scheduledOutboxStub = true;
    dom.FakeElement.prototype.querySelector = patched;
  }
  return await import(dom.moduleUrl("app-messages.js"));
}

test("an error frame through the app's handler: another request's id or none frees no row, the row's own id frees it with the failure", async function () {
  var env = await boot();
  try {
    var app = await handler();
    env.rl.applyScheduledInputList(list("A", [once("si_1", "first"), once("si_2", "second")]));
    var items = rows(env);
    items[0].querySelector(".scheduled-queued-cancel").click();
    items[1].querySelector(".scheduled-queued-fire").click();
    var own = env.frames[0].requestId;
    app.processMessage({ type: "error", text: "Clagentic: Console could not schedule that: unrelated" });
    app.processMessage({ type: "error", text: "another request", requestId: "sr_other" });
    [0, 1].forEach(function (i) {
      assert.equal(items[i].querySelector(".scheduled-queued-cancel").disabled, true, "row " + i + " still waits");
      assert.equal(items[i].querySelector(".scheduled-queued-error").textContent, "", "no false failure on row " + i);
    });
    app.processMessage({ type: "error", text: "Clagentic: Console could not cancel that: busy", requestId: own });
    assert.equal(items[0].querySelector(".scheduled-queued-cancel").disabled, false);
    assert.match(items[0].querySelector(".scheduled-queued-error").textContent, /could not cancel that: busy/);
    assert.equal(items[1].querySelector(".scheduled-queued-fire").disabled, true, "the other row is still waiting");
    assert.equal(items[1].querySelector(".scheduled-queued-error").textContent, "");
  } finally { done(env); }
});

test("a recurring schedule stays listed after Fire now; the server's answer enables its controls again", async function () {
  var env = await boot();
  try {
    var app = await handler();
    env.rl.applyScheduledInputList(list("A", [recurring("si_r", "every minute")]));
    var fire = rows(env)[0].querySelector(".scheduled-queued-fire");
    fire.click();
    assert.equal(fire.disabled, true);
    var requestId = env.frames[0].requestId;
    // The server's list after the fire still has the record, with a new next time.
    env.rl.applyScheduledInputList(list("A", [recurring("si_r", "every minute", 120000)]));
    app.processMessage({ type: "scheduled_request_result", requestId: requestId, id: "si_r", ok: true });
    var row = rows(env)[0];
    assert.equal(row.querySelector(".scheduled-queued-fire").disabled, false);
    assert.equal(row.querySelector(".scheduled-queued-cancel").disabled, false);
    assert.equal(row.querySelector(".scheduled-queued-error").textContent, "");
    assert.equal(rows(env).length, 1, "the row stays listed");
    assert.match(row.querySelector(".scheduled-queued-time").textContent, /\(1m \d+s\)|\(2m/, "with its next fire time");
    row.querySelector(".scheduled-queued-fire").click();
    assert.equal(env.frames.length, 2, "Fire now can be used again");
  } finally { done(env); }
});

test("an answer for another request frees no row", async function () {
  var env = await boot();
  try {
    var app = await handler();
    env.rl.applyScheduledInputList(list("A", [recurring("si_r", "x")]));
    var fire = rows(env)[0].querySelector(".scheduled-queued-fire");
    fire.click();
    app.processMessage({ type: "scheduled_request_result", requestId: "sr_other", id: "si_r", ok: true });
    app.processMessage({ type: "scheduled_request_result", id: "si_r", ok: true });
    assert.equal(fire.disabled, true);
  } finally { done(env); }
});

test("a reconnect with a request in flight frees the row and the list redraws it", async function () {
  var env = await boot();
  try {
    var ob = await import(dom.moduleUrl("scheduled-outbox.js"));
    env.rl.applyScheduledInputList(list("A", [recurring("si_r", "x")]));
    var row = rows(env)[0];
    row.querySelector(".scheduled-queued-fire").click();
    assert.equal(row.querySelector(".scheduled-queued-fire").disabled, true);
    // The connection drops after the send: no list push and no error ever comes.
    ob.clearScheduledOutboxOnReconnect();
    assert.equal(row.querySelector(".scheduled-queued-fire").disabled, false);
    assert.equal(row.querySelector(".scheduled-queued-cancel").disabled, false);
    env.rl.applyScheduledInputList(list("A", [recurring("si_r", "x")]));
    var redrawn = rows(env)[0];
    assert.equal(redrawn.querySelector(".scheduled-queued-fire").disabled, false, "not left disabled after the redraw");
    redrawn.querySelector(".scheduled-queued-fire").click();
    assert.equal(env.frames.length, 2);
  } finally { done(env); }
});

test("a timer fire, seen as a list push without that id, removes the row live and frees nothing stale", async function () {
  var env = await boot();
  try {
    env.rl.applyScheduledInputList(list("A", [once("si_1", "due", 1000), once("si_2", "later")]));
    assert.equal(rows(env).length, 2);
    env.rl.applyScheduledInputList(list("A", [once("si_2", "later")]));
    assert.deepEqual(rows(env).map(function (r) { return r.getAttribute("data-id"); }), ["si_2"]);
    env.rl.applyScheduledInputList(list("A", []));
    assert.equal(rows(env).length, 0);
  } finally { done(env); }
});
