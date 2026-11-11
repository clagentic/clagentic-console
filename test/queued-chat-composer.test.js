"use strict";
// The page side of queued chat: a message typed during a Claude turn is sent at
// once with an id and drawn as queued until message_delivered turns it into the
// normal message; Cancel, Edit and Up withdraw it at the server and only a
// confirmed cancel hands the text back; after delivery the controls are disabled
// with the reason; Send now never sends a second copy; an agent without the
// capability sees no queued item at all. The real modules run over the
// hand-built DOM.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");

var FakeElement = dom.FakeElement;

var els = {
  messages: new FakeElement("div"),
  "send-btn": new FakeElement("button"),
  "ss-user-shell-enabled": new FakeElement("input"),
  "ss-user-shell-timeout": new FakeElement("input"),
  "ss-user-shell-cap": new FakeElement("input"),
  "ss-user-shell-problem": new FakeElement("div"),
};

var nextSession = 700;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var CAN_CANCEL = { steering: true, queuedMessageCancel: true };
var CODEX_LIKE = { steering: true, queuedMessageCancel: false };

function sessionStorageStub() {
  var backing = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },
    setItem: function (k, v) { backing[k] = String(v); },
    removeItem: function (k) { delete backing[k]; },
  };
}

function withSystemMessageSpans(doc) {
  var create = doc.createElement;
  doc.createElement = function (tag) {
    var el = create(tag);
    if (tag === "div") {
      Object.defineProperty(el, "innerHTML", {
        configurable: true,
        get: function () { return ""; },
        set: function (v) {
          el._children = [];
          var m = /<span class="([^"]+)"><\/span>/.exec(String(v));
          if (m) { var s = create("span"); s.className = m[1]; el.appendChild(s); }
        },
      });
    }
    return el;
  };
}

async function setup(caps) {
  dom.setupGlobals();
  withSystemMessageSpans(global.document);
  global.document.documentElement = { style: { setProperty: function () {} } };
  global.document.getElementById = function (id) { return els[id] || null; };
  global.window.sessionStorage = sessionStorageStub();
  global.window.crypto = require("crypto").webcrypto;
  els.messages._children = [];
  var sid = nextSession++;
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({
    connected: true, activeSessionId: sid, currentSlug: "t", processing: true, replayingHistory: false,
    vendorCapabilities: caps,
  });
  var input = await import(dom.moduleUrl("input.js"));
  var us = await import(dom.moduleUrl("user-shell.js"));
  var env = { sid: sid, sent: [], shown: [], notes: [], store: storeMod.store, us: us, input: input };
  env.ctx = {
    ws: { readyState: 1, send: function (b) { env.sent.push(JSON.parse(b)); } },
    connected: true,
    inputEl: new FakeElement("textarea"),
    sendBtn: new FakeElement("button"),
    slashMenu: new FakeElement("div"),
    imagePreviewBar: new FakeElement("div"),
    addSystemMessage: function (text) { env.notes.push(text); },
    addUserMessage: function (text) { env.shown.push(text); },
    messageUuidMap: function () { return []; },
  };
  input.initInput(env.ctx);
  return env;
}

function type(env, text) { env.ctx.inputEl.value = text; env.input.sendMessage(); }
function frames(env, kind) { return env.sent.filter(function (f) { return f.type === kind; }); }
function chat(env) { return frames(env, "message"); }
function queuedEls() { return els.messages.querySelectorAll(".shell-queued"); }
function queuedTexts() { return els.messages.querySelectorAll(".shell-queued-text").map(function (e) { return e.textContent; }); }
function btn(el, cls) { return el.querySelector("." + cls); }
function sysText() { return els.messages.querySelectorAll(".sys-text").map(function (e) { return e.textContent; }); }
function press(env, evt) {
  var ev = Object.assign({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, prevented: false }, evt);
  ev.preventDefault = function () { ev.prevented = true; };
  (env.ctx.inputEl._listeners.keydown || []).forEach(function (fn) { fn(ev); });
  return ev;
}
function delivered(env, id) { env.us.handleMessageDelivered({ type: "message_delivered", messageId: id }); }
function answer(env, id, result, extra) { env.us.handleQueuedMessageCancelled(Object.assign({ type: "queued_message_cancelled", messageId: id, result: result }, extra || {})); }

test("chat typed during a turn is sent at once with a uuid and drawn as queued, not as a message", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "while you work");
  assert.equal(chat(env).length, 1, "sent at once: no client hold");
  assert.match(chat(env)[0].messageId, UUID);
  assert.equal(chat(env)[0].sendNow, undefined);
  assert.deepEqual(queuedTexts(), ["while you work"]);
  assert.equal(els.messages.querySelectorAll(".shell-queued-tag")[0].textContent, "Queued");
  assert.deepEqual(env.shown, [], "not in the conversation yet");
  assert.equal(env.ctx.inputEl.value, "", "the composer is cleared");
  ["shell-queued-send-now", "shell-queued-edit", "shell-queued-cancel"].forEach(function (cls) { assert.ok(btn(queuedEls()[0], cls), cls); });
});

test("message_delivered turns the queued item into the normal message, once", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "hello");
  var id = chat(env)[0].messageId;
  delivered(env, id);
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, ["hello"]);
  delivered(env, id);
  assert.deepEqual(env.shown, ["hello"], "a second event changes nothing");
  delivered(env, "someone-elses-message");
  assert.deepEqual(env.shown, ["hello"], "an unknown id changes nothing");
});

test("Cancel withdraws it at the server; only a confirmed cancel removes it, and nothing is shown or resent", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "never mind");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  assert.deepEqual(frames(env, "cancel_queued_message"), [{ type: "cancel_queued_message", messageId: id }]);
  assert.deepEqual(queuedTexts(), ["never mind"], "still queued until the server confirms");
  answer(env, id, "cancelled");
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, []);
  assert.equal(env.ctx.inputEl.value, "", "Cancel does not put the text back");
  delivered(env, id);
  assert.deepEqual(env.shown, [], "a cancelled message is never shown as delivered");
  assert.equal(chat(env).length, 1, "never sent again");
});

test("Edit withdraws it and puts its text in the composer as one entry; a draft typed meanwhile is set aside", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "fix me");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-edit").click();
  assert.equal(env.ctx.inputEl.value, "", "nothing in the composer before the server confirms");
  env.ctx.inputEl.value = "typed meanwhile";
  answer(env, id, "cancelled");
  assert.equal(env.ctx.inputEl.value, "fix me");
  assert.ok(sysText().some(function (t) { return /draft was set aside/.test(t); }));
  assert.deepEqual(queuedTexts(), []);
});

test("Up from an empty composer takes back ONE queued chat per press, the newest first", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "first");
  type(env, "second");
  var ids = chat(env).map(function (f) { return f.messageId; });
  var ev = press(env, { key: "ArrowUp" });
  assert.equal(ev.prevented, true);
  assert.deepEqual(frames(env, "cancel_queued_message").map(function (f) { return f.messageId; }), [ids[1]], "the newest only");
  answer(env, ids[1], "cancelled");
  assert.equal(env.ctx.inputEl.value, "second", "one entry, never joined");
  assert.deepEqual(queuedTexts(), ["first"]);
  env.ctx.inputEl.value = "";
  press(env, { key: "ArrowUp" });
  answer(env, ids[0], "cancelled");
  assert.equal(env.ctx.inputEl.value, "first");
  assert.deepEqual(queuedTexts(), []);
  assert.equal(press(env, { key: "ArrowUp" }).prevented, false, "nothing left to take back");
});

test("after delivery the controls are disabled with the reason, and a late cancel keeps the message", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "racing");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  answer(env, id, "already_delivered");
  var q = queuedEls()[0];
  ["shell-queued-cancel", "shell-queued-edit", "shell-queued-send-now"].forEach(function (cls) {
    assert.equal(btn(q, cls).getAttribute("aria-disabled"), "true", cls);
    assert.match(btn(q, cls).title, /Already delivered/, cls);
  });
  assert.equal(env.ctx.inputEl.value, "", "nothing is handed back");
  btn(q, "shell-queued-edit").click();
  assert.equal(frames(env, "cancel_queued_message").length, 1, "a disabled control sends nothing");
  assert.ok(sysText().some(function (t) { return /Edit is unavailable: Already delivered/.test(t); }), "a tap says why");
  delivered(env, id);
  assert.deepEqual(env.shown, ["racing"], "the message arrives once");
  assert.deepEqual(queuedTexts(), []);
});

test("delivery that arrives before the already_delivered answer leaves one message and no queued item", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "both orders");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  delivered(env, id);
  answer(env, id, "already_delivered");
  assert.deepEqual(env.shown, ["both orders"]);
  assert.deepEqual(queuedTexts(), []);
  assert.equal(env.ctx.inputEl.value, "");
});

test("Send now on a queued chat never sends a second copy", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "already there");
  var send = btn(queuedEls()[0], "shell-queued-send-now");
  assert.equal(send.getAttribute("aria-disabled"), "false", "available while the agent can take a message into the turn");
  send.click();
  assert.equal(chat(env).length, 1, "no second send");
  assert.equal(frames(env, "cancel_queued_message").length, 0, "and no cancel");
  assert.ok(sysText().some(function (t) { return /already with the agent/.test(t); }));
  assert.deepEqual(queuedTexts(), ["already there"]);
});

test("a query that closes with the message untaken hands its text back", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "lost turn");
  var id = chat(env)[0].messageId;
  answer(env, id, "dropped");
  assert.deepEqual(queuedTexts(), []);
  assert.equal(env.ctx.inputEl.value, "lost turn");
  assert.ok(sysText().some(function (t) { return /session ended before this message was delivered/.test(t); }));
});

test("a cancel the server could not answer leaves the item queued with a stated reason", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "stuck");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  answer(env, id, "error", { message: "worker gone" });
  assert.deepEqual(queuedTexts(), ["stuck"]);
  assert.ok(sysText().some(function (t) { return /worker gone/.test(t); }));
  assert.equal(btn(queuedEls()[0], "shell-queued-cancel").getAttribute("aria-disabled"), "false", "it can be tried again");
});

test("a send that did not go out is neither queued nor shown", async function () {
  var env = await setup(CAN_CANCEL);
  env.ctx.ws.readyState = 3;
  type(env, "offline");
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, []);
  assert.equal(env.ctx.inputEl.value, "offline", "it stays in the composer");
});

test("Codex and other agents without the capability: chat is shown as sent, with no id, as on main", async function () {
  var env = await setup(CODEX_LIKE);
  type(env, "plain old send");
  assert.equal(chat(env).length, 1);
  assert.equal(chat(env)[0].messageId, undefined);
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, ["plain old send"]);
  assert.equal(press(env, { key: "ArrowUp" }).prevented, false, "Up keeps its behaviour");
});

test("send now into the turn is not queued: no id, shown as sent", async function () {
  var env = await setup(CAN_CANCEL);
  env.ctx.inputEl.value = "change course";
  press(env, { key: "Enter", ctrlKey: true });
  assert.equal(chat(env).length, 1);
  assert.equal(chat(env)[0].sendNow, true);
  assert.equal(chat(env)[0].messageId, undefined);
  assert.deepEqual(env.shown, ["change course"]);
  assert.deepEqual(queuedTexts(), []);
});

test("no turn running: chat is shown as sent at once, with no id", async function () {
  var env = await setup(CAN_CANCEL);
  env.store.set({ processing: false });
  type(env, "idle send");
  assert.equal(chat(env)[0].messageId, undefined);
  assert.deepEqual(env.shown, ["idle send"]);
  assert.deepEqual(queuedTexts(), []);
});

test("the capability table marks queued-chat Cancel and Edit unavailable, with a reason, for an agent without it", async function () {
  var m = await import(dom.moduleUrl("send-now.js"));
  assert.deepEqual(Object.keys(m.QUEUED_CONTROLS_BY_KIND).sort(), ["chat", "scheduled", "shell"]);
  var cannot = m.queuedControlsForKind("chat", { enabled: false, reason: "no cancel here" });
  assert.deepEqual(cannot, { cancel: { enabled: false, reason: "no cancel here" }, edit: { enabled: false, reason: "no cancel here" } });
  assert.equal(m.queuedControlsForKind("chat", { enabled: true, reason: "" }).cancel.enabled, true);
  assert.match(m.queuedControlsForKind("chat", null).cancel.reason, /cannot withdraw a message/, "a reason even with no gate");
  assert.equal(m.queuedControlsForKind("shell", null).edit.enabled, true, "a ! entry is held on the page: always withdrawable");

  await setup(CODEX_LIKE);
  var live = m.currentQueuedControls("chat");
  assert.equal(live.cancel.enabled, false);
  assert.ok(live.cancel.reason.length > 0);
  await setup(CAN_CANCEL);
  assert.equal(m.currentQueuedControls("chat").cancel.enabled, true);
});

test("a queued ! entry and queued chat share the controls: Up takes the ! entry first, then the chat", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "chat first");
  type(env, "!cmd");
  var id = chat(env)[0].messageId;
  assert.deepEqual(queuedTexts(), ["chat first", "!cmd"]);
  press(env, { key: "ArrowUp" });
  assert.equal(env.ctx.inputEl.value, "!cmd", "the newest entry, one line");
  assert.equal(frames(env, "cancel_queued_message").length, 0, "a ! entry is held on the page: no server round trip");
  env.ctx.inputEl.value = "";
  press(env, { key: "ArrowUp" });
  answer(env, id, "cancelled");
  assert.equal(env.ctx.inputEl.value, "chat first");
});

test("showing a session again drops the queued chat items: the history has what the agent took in, the rest arrives on delivery", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "pending");
  var id = chat(env)[0].messageId;
  els.messages._children = [];
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  assert.deepEqual(queuedTexts(), [], "not drawn again");
  delivered(env, id);
  assert.deepEqual(env.shown, [], "no duplicate of a message the history will carry");
});

test("a dropped or cancelled reply with no queued item on the page (session switched and back) puts the text in the composer as one entry", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "pending");
  var id = chat(env)[0].messageId;
  els.messages._children = [];
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  env.ctx.inputEl.value = "";
  env.us.handleSessionShown(env.ctx.inputEl);
  answer(env, id, "dropped", { text: "pending", pastes: ["pasted"], imageCount: 0 });
  assert.equal(env.ctx.inputEl.value, "pending\n\npasted", "one entry, text and paste together");
  assert.ok(sysText().some(function (t) { return /not delivered/.test(t); }));

  var env2 = await setup(CAN_CANCEL);
  type(env2, "second");
  var id2 = chat(env2)[0].messageId;
  env2.us.handleSessionShown(new FakeElement("textarea"));
  answer(env2, id2, "cancelled", { text: "second", pastes: [], imageCount: 1 });
  assert.match(env2.ctx.inputEl.value, /^second\n\[an image attachment/, "an image is noted, not lost silently");
});

test("a reply with no queued item and no text changes nothing", async function () {
  var env = await setup(CAN_CANCEL);
  env.ctx.inputEl.value = "my draft";
  answer(env, "7e57ed00-0000-4000-8000-000000000000", "dropped");
  answer(env, "7e57ed00-0000-4000-8000-000000000000", "already_delivered", { text: "x" });
  assert.equal(env.ctx.inputEl.value, "my draft");
});

test("a pending answer keeps the item queued with its controls disabled; delivery then shows the message once, a drop hands the text back", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "maybe running");
  var id = chat(env)[0].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  answer(env, id, "pending");
  assert.deepEqual(queuedTexts(), ["maybe running"], "still queued");
  var q = queuedEls()[0];
  assert.equal(btn(q, "shell-queued-cancel").getAttribute("aria-disabled"), "true");
  assert.doesNotMatch(btn(q, "shell-queued-cancel").title, /Already delivered/);
  assert.equal(env.ctx.inputEl.value, "", "nothing handed back yet");
  delivered(env, id);
  assert.deepEqual(env.shown, ["maybe running"]);

  type(env, "never ran");
  var id2 = chat(env)[1].messageId;
  btn(queuedEls()[0], "shell-queued-cancel").click();
  answer(env, id2, "pending");
  answer(env, id2, "dropped", { text: "never ran" });
  assert.deepEqual(queuedTexts(), []);
  assert.equal(env.ctx.inputEl.value, "never ran");
});

test("a dropped reply is worded by its cause: a turn that did not take it, or the closed session; a sibling put in doubt unasked has its controls disabled", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "sibling");
  var id = chat(env)[0].messageId;
  answer(env, id, "pending");
  var q = queuedEls()[0];
  assert.equal(btn(q, "shell-queued-cancel").getAttribute("aria-disabled"), "true", "disabled though this page never asked");
  assert.ok(sysText().some(function (t) { return /Withdrawing another message may have dropped this one/.test(t); }));
  answer(env, id, "dropped", { text: "sibling", cause: "not_taken" });
  assert.ok(sysText().some(function (t) { return /agent did not run this message/.test(t); }));

  type(env, "turn passed it by");
  var id2 = chat(env)[1].messageId;
  answer(env, id2, "dropped", { text: "turn passed it by", cause: "not_taken" });
  assert.equal(sysText().filter(function (t) { return /session ended/.test(t); }).length, 0, "the session is alive: it is not said to have ended");
  assert.equal(sysText().filter(function (t) { return /agent did not run this message/.test(t); }).length, 2);

  type(env, "query closed");
  var id3 = chat(env)[2].messageId;
  answer(env, id3, "dropped", { text: "query closed", cause: "closed" });
  assert.ok(sysText().some(function (t) { return /session ended before this message was delivered/.test(t); }));
});

var TRACKED_ID = "5e1f5e1f-0000-4000-8000-000000000001";
function tracked(env, extra) {
  env.us.handleQueuedMessageTracked(Object.assign({ type: "queued_message_tracked", messageId: TRACKED_ID, text: "from before the reload", pastes: [], imageCount: 0, unconfirmed: false }, extra || {}));
}

test("after a reload the server's tracked frame draws the waiting message as queued, with working controls", async function () {
  var env = await setup(CAN_CANCEL);
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  assert.deepEqual(queuedTexts(), []);
  tracked(env);
  assert.deepEqual(queuedTexts(), ["from before the reload"]);
  tracked(env);
  assert.equal(queuedEls().length, 1, "a second frame for the same id draws nothing more");
  btn(queuedEls()[0], "shell-queued-cancel").click();
  assert.deepEqual(frames(env, "cancel_queued_message"), [{ type: "cancel_queued_message", messageId: TRACKED_ID }]);
  answer(env, TRACKED_ID, "cancelled", { text: "from before the reload", pastes: [], imageCount: 0 });
  assert.deepEqual(queuedTexts(), []);
});

test("a redrawn item turns into nothing on delivery: the transcript already gets the message from the server, so it is not shown twice", async function () {
  var env = await setup(CAN_CANCEL);
  tracked(env);
  delivered(env, TRACKED_ID);
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, [], "the message arrives as the session's own user message, not from the item");
});

test("a redrawn item that was dropped hands its text to the composer, and one withdrawn on another page just goes", async function () {
  var env = await setup(CAN_CANCEL);
  tracked(env);
  answer(env, TRACKED_ID, "dropped", { text: "from before the reload", cause: "closed" });
  assert.deepEqual(queuedTexts(), []);
  assert.equal(env.ctx.inputEl.value, "from before the reload");

  var env2 = await setup(CAN_CANCEL);
  tracked(env2);
  answer(env2, TRACKED_ID, "cancelled");
  assert.deepEqual(queuedTexts(), [], "withdrawn elsewhere: the item is dropped");
  assert.equal(env2.ctx.inputEl.value, "", "no text came with it, so nothing lands in this composer");
});

test("a tracked frame in doubt is drawn with its controls disabled", async function () {
  var env = await setup(CAN_CANCEL);
  tracked(env, { unconfirmed: true });
  assert.equal(btn(queuedEls()[0], "shell-queued-cancel").getAttribute("aria-disabled"), "true");
});

// The server echoes a delivered message to every socket but the sender's. Each row
// counts the transcript's copies: the item's own render plus the echo it receives.
function copiesInTranscript(env, echoReachesPage) {
  return env.shown.length + (echoReachesPage ? 1 : 0);
}

test("the sending socket switches session away and back while the chat is queued: delivery shows the message once", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "across a switch");
  var id = chat(env)[0].messageId;
  els.messages._children = [];
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  tracked(env, { messageId: id, text: "across a switch" });
  assert.deepEqual(queuedTexts(), ["across a switch"]);
  delivered(env, id);
  assert.deepEqual(queuedTexts(), []);
  assert.deepEqual(env.shown, ["across a switch"], "this socket gets no echo, so its item draws the message");
  assert.equal(copiesInTranscript(env, false), 1);
});

test("a reloaded page (a new socket) shows the delivered message once, from the server's echo", async function () {
  var env = await setup(CAN_CANCEL);
  type(env, "across a reload");
  var id = chat(env)[0].messageId;
  els.messages._children = [];
  env.ctx.ws = { readyState: 1, send: function () {} };
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  tracked(env, { messageId: id, text: "across a reload" });
  delivered(env, id);
  assert.deepEqual(env.shown, [], "the item draws nothing: the echo does");
  assert.equal(copiesInTranscript(env, true), 1);
});

test("a second tab shows the delivered message once, from the server's echo", async function () {
  var env = await setup(CAN_CANCEL);
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.us.handleHistoryReplayed();
  tracked(env, { messageId: "5e1f5e1f-0000-4000-8000-000000000002", text: "typed in the other tab" });
  delivered(env, "5e1f5e1f-0000-4000-8000-000000000002");
  assert.deepEqual(env.shown, []);
  assert.equal(copiesInTranscript(env, true), 1);
});

// A message that ends while the page shows another session leaves no sender record
// behind: seen through a later tracked frame for the same id, which is drawn as
// redrawn (the echo shows the message) only when no record of this socket's send remains.
test("a delivery or a final answer for a message with no item leaves no sender record", async function () {
  var ends = [
    function (env, id) { delivered(env, id); },
    function (env, id) { answer(env, id, "cancelled"); },
    function (env, id) { answer(env, id, "dropped", { text: "x", cause: "closed" }); },
  ];
  for (var i = 0; i < ends.length; i++) {
    var env = await setup(CAN_CANCEL);
    type(env, "ended elsewhere " + i);
    var id = chat(env)[0].messageId;
    env.us.handleSessionShown(new FakeElement("textarea"));
    env.us.handleHistoryReplayed();
    ends[i](env, id);
    els.messages._children = [];
    env.shown.length = 0;
    tracked(env, { messageId: id, text: "same id again" });
    delivered(env, id);
    assert.deepEqual(env.shown, [], "row " + i + ": no record of the earlier send, so the item is a redrawn one");
  }
});
