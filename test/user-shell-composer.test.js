"use strict";
// The page side of the ! command line: how the composer routes a line, the chat
// queue that holds what is typed while a command runs, the Edit action on a
// refused command, the result card for every outcome and a history replay, and
// the settings controls. The real modules run over the hand-built DOM.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var dom = require("./fake-dom-prompt-cards");

var FakeElement = dom.FakeElement;

// dom-refs caches the first element it is given per id, so these are made once.
var els = {
  messages: new FakeElement("div"),
  "send-btn": new FakeElement("button"),
  "ss-user-shell-enabled": new FakeElement("input"),
  "ss-user-shell-timeout": new FakeElement("input"),
  "ss-user-shell-cap": new FakeElement("input"),
  "ss-user-shell-problem": new FakeElement("div"),
};

// Every test works in a session of its own, so the page-wide queue and pending
// state of one test cannot reach another.
var nextSession = 100;
var reloads = 0;

function sessionStorageStub() {
  var backing = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },
    setItem: function (k, v) { backing[k] = String(v); },
    removeItem: function (k) { delete backing[k]; },
  };
}

// addSystemMessage fills its div through innerHTML, which the hand-built DOM
// stores as text; this gives it the one span it builds.
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

async function setup(opts) {
  opts = opts || {};
  dom.setupGlobals();
  withSystemMessageSpans(global.document);
  global.document.documentElement = { style: { setProperty: function () {} } };
  global.document.getElementById = function (id) { return els[id] || null; };
  global.window.sessionStorage = sessionStorageStub();
  els.messages._children = [];
  els["ss-user-shell-problem"].textContent = "";

  var sid = nextSession++;
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({
    connected: true, activeSessionId: sid, currentSlug: "t", processing: false, replayingHistory: false,
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

function type(env, text) {
  env.ctx.inputEl.value = text;
  env.input.sendMessage();
}

function frames(env, kind) { return env.sent.filter(function (f) { return f.type === kind; }); }
function chatSent(env) { return frames(env, "message").map(function (f) { return f.text; }); }
function queuedTexts() { return els.messages.querySelectorAll(".shell-queued-text").map(function (e) { return e.textContent; }); }
function cards() { return els.messages.querySelectorAll(".shell-result"); }

function result(env, over) {
  var req = frames(env, "shell")[0];
  return Object.assign({ type: "shell_result", requestId: req.requestId, command: req.command, exitCode: 0, durationMs: 5, output: "", truncated: false, timedOut: false, interrupted: false }, over);
}

// ---------------------------------------------------------------- routing

test("a ! line is sent as a shell request with the tail exactly as typed", async function () {
  var env = await setup();
  var typed = "printf '<%s>\\n' foo\\ ";
  type(env, "!  " + typed);
  var shell = frames(env, "shell");
  assert.equal(shell.length, 1);
  assert.equal(shell[0].command, typed, "only the ! and the whitespace after it are removed; the trailing escaped space stays");
  assert.ok(shell[0].requestId);
  assert.equal(chatSent(env).length, 0);
  assert.equal(env.ctx.inputEl.value, "", "the composer is cleared once the request was sent");
  assert.equal(cards().length, 1, "the command shows as a running card");
  assert.equal(env.us.isShellPending(), true);

  var env2 = await setup();
  type(env2, "   !ls -la\t ");
  assert.equal(frames(env2, "shell")[0].command, "ls -la\t ", "whitespace before the ! is ignored; the tail is untouched");
});

test("chat trimming is unchanged", async function () {
  var env = await setup();
  type(env, "  hello there  \n");
  assert.deepEqual(chatSent(env), ["hello there"]);
  assert.equal(frames(env, "shell").length, 0);
});

test("a lone ! or ! with only blanks is ordinary chat", async function () {
  var env = await setup();
  type(env, "!");
  type(env, "!   ");
  assert.deepEqual(chatSent(env), ["!", "!"]);
  assert.equal(frames(env, "shell").length, 0);
});

test("with ! mode off any ! line is sent as ordinary text, and the composer follows the setting", async function () {
  var env = await setup();
  env.us.handleUserShellSettings({ userShellEnabled: false, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256 });
  assert.equal(env.us.isShellModeOn(), false);
  var long = "!" + "x".repeat(5000);
  type(env, "!ls -la");
  type(env, "!");
  type(env, long);
  assert.deepEqual(chatSent(env), ["!ls -la", "!", long]);
  assert.equal(frames(env, "shell").length, 0);

  env.us.handleUserShellSettings({ userShellEnabled: true, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256 });
  assert.equal(env.us.isShellModeOn(), true);
  type(env, "!ls");
  assert.equal(frames(env, "shell").length, 1, "turned back on, the same line is a command");
});

// ---------------------------------------------------------------- the queue

var OUTCOMES = {
  "a result": { exitCode: 0 },
  "a failing result": { exitCode: 2 },
  "a refusal": { refused: true, reason: "plan", message: "Not in plan mode.", exitCode: null },
  "a denial": { denied: true, reason: "denied", message: "Not approved.", exitCode: null },
  "an error": { error: true, output: "could not start", exitCode: null },
  "a timeout": { timedOut: true, exitCode: null },
  "a stop": { interrupted: true, exitCode: null },
};

Object.keys(OUTCOMES).forEach(function (name) {
  test("chat typed during a command is queued and sent in order after " + name, async function () {
    var env = await setup();
    type(env, "!sleep 5");
    type(env, "first");
    type(env, "second");
    assert.deepEqual(chatSent(env), [], "nothing is sent while the command runs");
    assert.deepEqual(queuedTexts(), ["first", "second"], "both show as queued");
    assert.equal(els.messages.querySelectorAll(".shell-queued-tag")[0].textContent, "Queued");
    assert.deepEqual(env.shown, [], "a queued message is not yet in the conversation");

    env.us.handleShellResult(result(env, OUTCOMES[name]));
    assert.deepEqual(chatSent(env), ["first", "second"], "sent in the order typed");
    assert.deepEqual(env.shown, ["first", "second"], "each is recorded once, when it was sent");
    assert.deepEqual(queuedTexts(), [], "the queued lines are gone");
    assert.equal(env.us.isShellPending(), false);
  });
});

test("a command's result does not release another session's queue, and a stale result releases nothing", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "waits");
  env.us.handleShellResult({ type: "shell_result", requestId: "someone-else", command: "x", exitCode: 0 });
  assert.deepEqual(chatSent(env), [], "a result for a command this page did not send changes nothing");
  assert.deepEqual(queuedTexts(), ["waits"]);
});

// ---------------------------------------------------------------- ! during a turn

function lastShell(env) { var f = frames(env, "shell"); return f[f.length - 1]; }
function finish(env, req, over) {
  env.us.handleShellResult(Object.assign({ type: "shell_result", requestId: req.requestId, command: req.command, exitCode: 0, durationMs: 5, output: "", truncated: false, timedOut: false, interrupted: false }, over || {}));
}
function endTurn(env) { env.store.set({ processing: false }); }

test("a ! line typed during a turn is queued, not sent, and runs with its result card when the turn ends", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!sleep 30");
  assert.equal(frames(env, "shell").length, 0, "nothing reaches the server while the turn runs");
  assert.deepEqual(queuedTexts(), ["!sleep 30"], "it shows as a queued ! entry");
  assert.equal(cards().length, 0);
  assert.equal(env.ctx.inputEl.value, "", "the composer is cleared");

  endTurn(env);
  assert.equal(frames(env, "shell").length, 1, "sent when the turn ends");
  assert.equal(lastShell(env).command, "sleep 30");
  assert.deepEqual(queuedTexts(), []);
  assert.equal(cards().length, 1, "it runs as a card");
  finish(env, lastShell(env), { output: "done\n" });
  assert.equal(cards()[0].querySelector(".shell-output").textContent, "done\n");
});

test("two queued ! commands run in order, the second only after the first's result", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!first");
  type(env, "!second");
  assert.deepEqual(queuedTexts(), ["!first", "!second"]);
  endTurn(env);
  assert.deepEqual(frames(env, "shell").map(function (f) { return f.command; }), ["first"], "one at a time");
  assert.deepEqual(queuedTexts(), ["!second"]);
  finish(env, lastShell(env));
  assert.deepEqual(frames(env, "shell").map(function (f) { return f.command; }), ["first", "second"]);
  assert.deepEqual(queuedTexts(), []);
});

test("a mixed queue of chat, !, chat keeps the typed order, the trailing chat after the command's result", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!mid");
  type(env, "after");
  assert.deepEqual(queuedTexts(), ["!mid", "after"], "chat typed behind a queued command waits behind it");
  assert.deepEqual(chatSent(env), []);
  endTurn(env);
  assert.equal(frames(env, "shell").length, 1);
  assert.deepEqual(chatSent(env), [], "the chat waits for the command's result");
  finish(env, lastShell(env));
  assert.deepEqual(chatSent(env), ["after"]);

  var env2 = await setup();
  type(env2, "!sleep 5");
  type(env2, "one");
  type(env2, "!two");
  type(env2, "three");
  assert.deepEqual(queuedTexts(), ["one", "!two", "three"]);
  finish(env2, lastShell(env2));
  assert.deepEqual(chatSent(env2), ["one"]);
  assert.equal(frames(env2, "shell").length, 2, "the command behind the chat goes next");
  finish(env2, lastShell(env2));
  assert.deepEqual(chatSent(env2), ["one", "three"]);
});

test("a reload restores queued ! entries, none lost and none doubled", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!sleep 30");
  type(env, "then chat");
  els.messages._children = [];
  reloads += 1;
  var fresh = await import(dom.moduleUrl("user-shell.js") + "?reload=" + reloads);
  var composerEl = new FakeElement("textarea");
  fresh.handleSessionShown(composerEl);
  assert.equal(composerEl.value, "", "a ! line is queued again as a command, not joined into the composer");
  assert.equal(fresh.hasQueuedChat(), true);
  fresh.handleHistoryReplayed();
  fresh.handleHistoryReplayed();
  assert.deepEqual(queuedTexts(), ["!sleep 30", "then chat"], "in typed order, each once");
  assert.equal(frames(env, "shell").length, 0);
});

test("Stop on the turn keeps the queued ! entry, which runs when the session goes idle", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!kept");
  env.ctx.processing = true;
  env.ctx.sendBtn.click();
  assert.deepEqual(frames(env, "stop").length, 1, "Stop was sent for the turn");
  assert.deepEqual(queuedTexts(), ["!kept"], "Stop does not drop it");
  endTurn(env);
  assert.equal(lastShell(env).command, "kept");
});

test("a flushed ! refused as busy returns to the head of the queue with no refusal card, and retries on the next idle", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!race");
  type(env, "behind");
  endTurn(env);
  assert.equal(frames(env, "shell").length, 1);
  env.store.set({ processing: true });
  finish(env, lastShell(env), { refused: true, reason: "busy", message: "The session is busy.", exitCode: null });
  assert.equal(cards().length, 0, "no refusal card, and the running card is gone");
  assert.deepEqual(queuedTexts(), ["!race", "behind"], "back at the head, in front of what was typed after it");
  assert.deepEqual(chatSent(env), []);
  endTurn(env);
  assert.equal(frames(env, "shell").length, 2, "retried on the next idle");
  finish(env, lastShell(env));
  assert.deepEqual(chatSent(env), ["behind"]);
});

test("a busy refusal while the page reads idle is retried on a timer, with no processing event, and runs once the server accepts", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!race");
  endTurn(env);
  assert.equal(frames(env, "shell").length, 1);
  finish(env, lastShell(env), { refused: true, reason: "busy", message: "The session is busy.", exitCode: null });
  assert.equal(cards().length, 0);
  assert.deepEqual(queuedTexts(), ["!race"]);
  t.mock.timers.tick(500);
  assert.equal(frames(env, "shell").length, 2, "retried without any processing change");
  assert.equal(lastShell(env).command, "race");
  finish(env, lastShell(env), { output: "ok\n" });
  assert.deepEqual(queuedTexts(), []);
  t.mock.timers.tick(60000);
  assert.equal(frames(env, "shell").length, 2, "sent once, never doubled");
});

test("repeated busy refusals back off, and the retry stops when the queue empties or the session switches", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var env = await setup();
  type(env, "!again");
  assert.equal(frames(env, "shell").length, 1);
  var delays = [500, 1000, 2000, 4000, 8000, 8000];
  var count = 1;
  delays.forEach(function (ms) {
    finish(env, lastShell(env), { refused: true, reason: "busy", message: "busy", exitCode: null });
    t.mock.timers.tick(ms - 1);
    assert.equal(frames(env, "shell").length, count, "not retried before " + ms + " ms");
    t.mock.timers.tick(1);
    count++;
    assert.equal(frames(env, "shell").length, count, "retried at " + ms + " ms");
  });

  // The session switches: the pending retry is cancelled and the entry is parked.
  finish(env, lastShell(env), { refused: true, reason: "busy", message: "busy", exitCode: null });
  env.store.set({ activeSessionId: env.sid + 5000 });
  env.us.handleSessionShown(new FakeElement("textarea"));
  t.mock.timers.tick(60000);
  assert.equal(frames(env, "shell").length, count, "no retry after the session switched");

  // The queue empties by another path: a later flush sends it and the timer is gone.
  var env2 = await setup();
  type(env2, "!once");
  finish(env2, lastShell(env2), { refused: true, reason: "busy", message: "busy", exitCode: null });
  env2.store.set({ processing: true });
  endTurn(env2);
  assert.equal(frames(env2, "shell").length, 2);
  finish(env2, lastShell(env2));
  t.mock.timers.tick(60000);
  assert.equal(frames(env2, "shell").length, 2, "an emptied queue is not retried");
});

["plan", "no_terminal", "unsupported", "denied"].forEach(function (reason) {
  test("a flushed ! refused as " + reason + " still shows its refusal card", async function () {
    var env = await setup();
    env.store.set({ processing: true });
    type(env, "!x");
    endTurn(env);
    finish(env, lastShell(env), { refused: true, reason: reason, message: "Refused: " + reason, exitCode: null });
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].className, "shell-result refused");
    assert.deepEqual(queuedTexts(), [], "not queued again");
  });
});

test("with ! mode off a ! line typed during a turn is sent as chat text, unchanged", async function () {
  var env = await setup();
  env.us.handleUserShellSettings({ userShellEnabled: false, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256 });
  env.store.set({ processing: true });
  type(env, "!ls");
  assert.deepEqual(chatSent(env), ["!ls"]);
  assert.equal(frames(env, "shell").length, 0);
});

// ---------------------------------------------------------------- failed sends

test("a shell request whose frame cannot be sent is not pending, stays in the composer, and does not hold later chat", async function () {
  var env = await setup();
  env.ctx.ws.readyState = 3;
  type(env, "!ls");
  assert.equal(frames(env, "shell").length, 0);
  assert.equal(env.us.isShellPending(), false, "nothing is marked pending for a request the server never saw");
  assert.equal(cards().length, 0, "no running card for a command that was not sent");
  assert.equal(env.ctx.inputEl.value, "!ls", "the line stays visible and unsent");
  assert.match(env.notes[0], /not sent/);

  env.ctx.ws.readyState = 1;
  type(env, "hello");
  assert.deepEqual(chatSent(env), ["hello"], "later chat is sent at once, not queued behind a command that never ran");
  assert.deepEqual(queuedTexts(), []);
});

test("a send that throws is treated as not sent", async function () {
  var env = await setup();
  env.ctx.ws.send = function () { throw new Error("socket closed"); };
  type(env, "!ls");
  assert.equal(env.us.isShellPending(), false);
  assert.equal(env.ctx.inputEl.value, "!ls");
  type(env, "hello");
  assert.equal(env.ctx.inputEl.value, "hello", "an ordinary message that cannot be sent stays in the composer");
  assert.deepEqual(env.shown, [], "and is not recorded as sent");
});

test("a queued message whose send fails stays queued and unsent, is never drawn twice, and a retry sends each once in order", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "a");
  type(env, "b");
  env.ctx.ws.readyState = 3;
  env.us.handleShellResult(result(env, {}));
  assert.deepEqual(chatSent(env), []);
  assert.deepEqual(queuedTexts(), ["a", "b"], "both stay visible");
  var tags = els.messages.querySelectorAll(".shell-queued-tag").map(function (e) { return e.textContent; });
  assert.deepEqual(tags, ["Not sent", "Queued"], "the one that failed says so");
  assert.deepEqual(env.shown, [], "a message that was not sent is not in the conversation");
  assert.equal(env.us.isShellPending(), false, "the queue does not wait on a finished command");

  env.ctx.ws.readyState = 1;
  type(env, "c");
  assert.deepEqual(chatSent(env), ["a", "b", "c"], "later chat is not wedged and keeps the order typed");
  assert.deepEqual(env.shown, ["a", "b", "c"], "each is rendered exactly once");
  assert.deepEqual(queuedTexts(), []);
});

test("a retried flush after a failure draws nothing a second time", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "only");
  env.ctx.ws.readyState = 3;
  env.us.handleShellResult(result(env, {}));
  env.us.flushQueuedChat();
  env.us.flushQueuedChat();
  assert.deepEqual(queuedTexts(), ["only"], "still one queued line");
  env.ctx.ws.readyState = 1;
  env.us.flushQueuedChat();
  env.us.flushQueuedChat();
  assert.deepEqual(chatSent(env), ["only"]);
  assert.deepEqual(env.shown, ["only"]);
});

test("a reconnect resumes the queue: the transcript is rebuilt with the running card and queued lines, and sends when the command is done", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "later");
  // The page wipes the transcript when the session is shown again.
  els.messages._children = [];
  var composerEl = new FakeElement("textarea");
  env.us.handleSessionShown(composerEl);
  assert.equal(composerEl.value, "", "queued chat of the session on screen is not moved to the composer");
  env.us.handleHistoryReplayed();
  assert.equal(cards().length, 1, "the running command is drawn again");
  assert.deepEqual(queuedTexts(), ["later"], "the queued line is drawn again, once");
  env.us.handleHistoryReplayed();
  assert.deepEqual(queuedTexts(), ["later"], "a second replay does not draw it twice");
  assert.deepEqual(chatSent(env), []);

  // The command ended while the page was away: its result comes with the replay.
  els.messages._children = [];
  env.us.handleSessionShown(composerEl);
  env.store.set({ replayingHistory: true });
  env.us.handleShellResult(result(env, { output: "done\n" }));
  assert.deepEqual(chatSent(env), [], "nothing is sent in the middle of a replay");
  env.store.set({ replayingHistory: false });
  env.us.handleHistoryReplayed();
  assert.deepEqual(chatSent(env), ["later"], "the queue resumes once the replay is over");
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].querySelector(".shell-output").textContent, "done\n");
  assert.deepEqual(queuedTexts(), []);
});

// ---------------------------------------------------------------- reload and switch

test("a session switch parks queued chat and restores it to that session's composer in front of its draft", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "one");
  type(env, "two");
  var first = env.sid;

  var other = nextSession++;
  env.store.set({ activeSessionId: other });
  var elsewhere = new FakeElement("textarea");
  elsewhere.value = "draft of the other session";
  env.us.handleSessionShown(elsewhere);
  assert.equal(elsewhere.value, "draft of the other session", "another session's composer is left alone");
  assert.equal(env.us.isShellPending(), false, "its command's result does not come to this page now");

  env.store.set({ activeSessionId: first });
  var back = new FakeElement("textarea");
  back.value = "my draft";
  env.us.handleSessionShown(back);
  assert.equal(back.value, "one\n\ntwo\n\nmy draft", "nothing dropped: the queued messages are back in the composer, in order, before the draft");
  var again = new FakeElement("textarea");
  env.us.handleSessionShown(again);
  assert.equal(again.value, "", "they are restored once");
});

test("a reload restores queued chat from the saved queue to the composer", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  type(env, "kept one");
  type(env, "kept two");

  // A new page: the module starts empty and reads what the old one saved.
  reloads += 1;
  var fresh = await import(dom.moduleUrl("user-shell.js") + "?reload=" + reloads);
  var composerEl = new FakeElement("textarea");
  composerEl.value = "";
  fresh.handleSessionShown(composerEl);
  assert.equal(composerEl.value, "kept one\n\nkept two");
  assert.equal(fresh.hasQueuedChat(), false, "nothing is left queued in the new page");
});

test("an image attachment of a queued message is named in the restored text, not silently lost", async function () {
  var env = await setup();
  type(env, "!sleep 5");
  env.us.queueChatMessage({ text: "see", images: [{ mediaType: "image/png", data: "AAAA" }], pastes: ["pasted"], steerNow: false });
  var other = nextSession++;
  var first = env.sid;
  env.store.set({ activeSessionId: other });
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.store.set({ activeSessionId: first });
  var back = new FakeElement("textarea");
  env.us.handleSessionShown(back);
  assert.match(back.value, /^see\n\npasted\n\[an image attachment of this message was not restored/);
});

// ---------------------------------------------------------------- queued ! controls, keys

function press(env, evt) {
  var ev = Object.assign({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, prevented: false }, evt);
  ev.preventDefault = function () { ev.prevented = true; };
  (env.ctx.inputEl._listeners.keydown || []).forEach(function (fn) { fn(ev); });
  return ev;
}
function queuedEls() { return els.messages.querySelectorAll(".shell-queued"); }
function btn(el, cls) { return el.querySelector("." + cls); }
var CAN_STEER = { steering: true };

test("a queued ! entry shows Send now, Edit and Cancel, labelled in words", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!sleep 30");
  var q = queuedEls()[0];
  ["shell-queued-send-now", "shell-queued-edit", "shell-queued-cancel"].forEach(function (cls, i) {
    assert.ok(btn(q, cls), cls);
    assert.equal(btn(q, cls).textContent, ["Send now", "Edit", "Cancel"][i]);
    assert.equal(btn(q, cls).getAttribute("aria-label"), ["Send now", "Edit", "Cancel"][i]);
  });
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "user-shell.css"), "utf8");
  assert.match(css, /\.shell-queued \.shell-queued-btn \{[^}]*min-height: 36px/, "as tall as the send button");
});

test("during a turn a queued ! entry's Send now is disabled with the reason, and follows the turn", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!sleep 30");
  var send = btn(queuedEls()[0], "shell-queued-send-now");
  assert.equal(send.getAttribute("aria-disabled"), "true");
  assert.match(send.title, /a command runs after the turn/);
  send.click();
  assert.equal(frames(env, "shell").length, 0, "nothing runs during the turn");
  assert.match(els.messages.querySelectorAll(".sys-text")[0].textContent, /a command runs after the turn/, "a tap says why");
  assert.deepEqual(queuedTexts(), ["!sleep 30"]);

  // Idle again with a command running: the entry waits behind it and Send now is usable.
  env.store.set({ processing: false });
  type(env, "!held");
  env.store.set({ processing: true });
  env.store.set({ processing: false });
  var queued = queuedEls();
  assert.equal(btn(queued[queued.length - 1], "shell-queued-send-now").getAttribute("aria-disabled"), "false");
});

test("Send now on a queued ! entry while idle with others ahead runs it next", async function () {
  var env = await setup();
  type(env, "!running");
  type(env, "!one");
  type(env, "!two");
  assert.deepEqual(queuedTexts(), ["!one", "!two"]);
  btn(queuedEls()[1], "shell-queued-send-now").click();
  assert.deepEqual(queuedTexts(), ["!two", "!one"], "it moved to the head, on screen too");
  finish(env, lastShell(env));
  assert.equal(lastShell(env).command, "two", "it runs next");
  finish(env, lastShell(env));
  assert.equal(lastShell(env).command, "one");
});

test("Cancel removes a queued ! entry; Edit removes it and puts the command in the composer", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!keep");
  type(env, "!drop");
  type(env, "!fix me");
  btn(queuedEls()[1], "shell-queued-cancel").click();
  assert.deepEqual(queuedTexts(), ["!keep", "!fix me"]);
  btn(queuedEls()[1], "shell-queued-edit").click();
  assert.deepEqual(queuedTexts(), ["!keep"]);
  assert.equal(env.ctx.inputEl.value, "!fix me");
  endTurn(env);
  assert.deepEqual(frames(env, "shell").map(function (f) { return f.command; }), ["keep"], "neither removed entry ran");

  els.messages._children = [];
  reloads += 1;
  var fresh = await import(dom.moduleUrl("user-shell.js") + "?reload=" + reloads);
  var composerEl = new FakeElement("textarea");
  fresh.handleSessionShown(composerEl);
  assert.equal(composerEl.value, "", "a removed entry is not restored after a reload");
});

test("Ctrl+Enter during a turn sends the draft into the turn at once and sets queued ! entries to run next", async function () {
  var env = await setup();
  env.store.set({ processing: true, vendorCapabilities: CAN_STEER });
  type(env, "!later");
  env.ctx.inputEl.value = "change course";
  var ev = press(env, { key: "Enter", ctrlKey: true });
  assert.equal(ev.prevented, true);
  assert.deepEqual(frames(env, "message").map(function (f) { return [f.text, f.sendNow]; }), [["change course", true]], "sent now, not queued behind the ! entry");
  assert.equal(frames(env, "shell").length, 0, "the command still waits for the turn to end");
  assert.deepEqual(queuedTexts(), ["!later"]);
  endTurn(env);
  assert.equal(lastShell(env).command, "later");
});

test("Ctrl+Enter keeps the unchanged refusal when the agent cannot take a message into a turn", async function () {
  var env = await setup();
  env.store.set({ processing: true, vendorCapabilities: {} });
  type(env, "!later");
  env.ctx.inputEl.value = "change course";
  press(env, { key: "Enter", ctrlKey: true });
  assert.equal(frames(env, "message").length, 0);
  assert.equal(env.ctx.inputEl.value, "change course", "the draft stays in the composer");
  assert.match(env.notes[0], /^Send now is unavailable: .* Use send to queue it for the next turn\.$/);
});

test("Ctrl+Enter puts queued ! entries ahead of queued chat, with no draft needed", async function () {
  var env = await setup();
  type(env, "!running");
  type(env, "chat first");
  type(env, "!cmd");
  assert.deepEqual(queuedTexts(), ["chat first", "!cmd"]);
  press(env, { key: "Enter", ctrlKey: true });
  assert.deepEqual(queuedTexts(), ["!cmd", "chat first"]);
  assert.equal(env.notes.length, 0, "an empty draft is not a refusal");
  finish(env, lastShell(env));
  assert.equal(lastShell(env).command, "cmd");
});

test("Up from an empty composer takes back queued ! entries when nothing else is queued", async function () {
  var env = await setup();
  env.store.set({ processing: true });
  type(env, "!one");
  type(env, "!two");
  var ev = press(env, { key: "ArrowUp" });
  assert.equal(ev.prevented, true);
  assert.equal(env.ctx.inputEl.value, "!one\n!two");
  assert.deepEqual(queuedTexts(), []);
  endTurn(env);
  assert.equal(frames(env, "shell").length, 0, "taken back, so nothing runs");
});

test("Up keeps its current behaviour with a draft, queued chat, or nothing queued", async function () {
  var env = await setup();
  var ev = press(env, { key: "ArrowUp" });
  assert.equal(ev.prevented, false, "nothing queued");

  type(env, "!running");
  type(env, "chat");
  type(env, "!cmd");
  ev = press(env, { key: "ArrowUp" });
  assert.equal(ev.prevented, false, "chat is queued too");
  assert.deepEqual(queuedTexts(), ["chat", "!cmd"]);
  assert.equal(env.ctx.inputEl.value, "");

  var env2 = await setup();
  env2.store.set({ processing: true });
  type(env2, "!one");
  env2.ctx.inputEl.value = "draft";
  ev = press(env2, { key: "ArrowUp" });
  assert.equal(ev.prevented, false, "the composer is not empty");
  assert.deepEqual(queuedTexts(), ["!one"]);
  assert.equal(env2.ctx.inputEl.value, "draft");
});

test("Enter is unchanged: it queues a ! line during a turn and does not send now", async function () {
  var env = await setup();
  env.store.set({ processing: true, vendorCapabilities: CAN_STEER });
  env.ctx.inputEl.value = "hello";
  press(env, { key: "Enter" });
  assert.equal(frames(env, "message").length, 1);
  assert.equal(frames(env, "message")[0].sendNow, undefined, "an ordinary send, not send-now");
});

test("one capability table defines Send now per kind, chat and !", async function () {
  var m = await import(dom.moduleUrl("send-now.js"));
  assert.deepEqual(Object.keys(m.SEND_NOW_BY_KIND).sort(), ["chat", "shell"]);
  var can = { enabled: true, reason: "" };
  var cannot = { enabled: false, reason: "no steering here" };
  assert.deepEqual(m.sendNowForKind("chat", true, can), { mode: "steer", reason: "" });
  assert.deepEqual(m.sendNowForKind("chat", true, cannot), { mode: "disabled", reason: "no steering here" });
  assert.equal(m.sendNowForKind("chat", false, cannot).mode, "send");
  assert.equal(m.sendNowForKind("shell", true, can).mode, "disabled", "a ! command never goes into a turn, whatever the agent can do");
  assert.equal(m.sendNowForKind("shell", true, can).reason, "a command runs after the turn");
  assert.equal(m.sendNowForKind("shell", false, null).mode, "run-next");
  assert.equal(m.sendNowState(true, can).mode, "steer", "the chat helper reads the same table");
});

test("touch: a long press of the send button with a draft ready during a turn sends it now, and its click does not also send", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var env = await setup();
  env.store.set({ processing: true, vendorCapabilities: CAN_STEER });
  env.ctx.processing = true;
  env.ctx.inputEl.value = "hold to send now";
  var b = env.ctx.sendBtn;
  function fire(name, e) { (b._listeners[name] || []).slice().forEach(function (fn) { fn(Object.assign({ preventDefault: function () {}, stopImmediatePropagation: function () {} }, e)); }); }
  fire("pointerdown", { pointerType: "touch" });
  t.mock.timers.tick(499);
  assert.equal(frames(env, "message").length, 0, "a short press is not long");
  t.mock.timers.tick(1);
  assert.deepEqual(frames(env, "message").map(function (f) { return f.sendNow; }), [true]);

  // A quick tap sends nothing extra when released early.
  env.ctx.inputEl.value = "second";
  fire("pointerdown", { pointerType: "touch" });
  fire("pointerup", {});
  t.mock.timers.tick(1000);
  assert.equal(frames(env, "message").length, 1);
  // A mouse press is never a long press.
  fire("pointerdown", { pointerType: "mouse" });
  t.mock.timers.tick(1000);
  assert.equal(frames(env, "message").length, 1);
});

// ---------------------------------------------------------------- refused command: Edit

function refusal(command) {
  return { type: "shell_result", requestId: "refused-1", command: command, refused: true, reason: "plan", message: "Not in plan mode.", exitCode: null };
}

test("a refused command's card offers Edit, which restores the command to an empty composer", async function () {
  var env = await setup();
  env.us.handleShellResult(refusal("rm -rf build/ "));
  var card = cards()[0];
  assert.equal(card.className, "shell-result refused");
  assert.equal(card.querySelector(".shell-status").textContent, "Not in plan mode.");
  card.querySelector(".shell-edit").click();
  assert.equal(env.ctx.inputEl.value, "!rm -rf build/ ", "the command comes back as typed");
  type(env, env.ctx.inputEl.value);
  assert.equal(frames(env, "shell")[0].command, "rm -rf build/ ");
});

test("Edit on a refused command keeps a draft already in the composer and returns it after the send", async function () {
  var env = await setup();
  env.ctx.inputEl.value = "a long half-written message";
  env.us.handleShellResult(refusal("ls"));
  cards()[0].querySelector(".shell-edit").click();
  assert.equal(env.ctx.inputEl.value, "!ls", "the command is in the composer");
  assert.ok(env.ctx.inputEl.value.indexOf("half-written") === -1, "the draft is never placed behind the ! where it would run as part of the command");
  assert.match(els.messages.querySelectorAll(".sys-text")[0].textContent, /draft was set aside/);

  type(env, env.ctx.inputEl.value);
  assert.equal(frames(env, "shell")[0].command, "ls");
  assert.equal(env.ctx.inputEl.value, "a long half-written message", "the draft is back, not lost");
});

test("a draft set aside goes to its own session's composer when the page leaves that session", async function () {
  var env = await setup();
  env.ctx.inputEl.value = "unfinished";
  env.us.handleShellResult(refusal("ls"));
  cards()[0].querySelector(".shell-edit").click();
  var first = env.sid;
  env.store.set({ activeSessionId: nextSession++ });
  env.us.handleSessionShown(new FakeElement("textarea"));
  env.store.set({ activeSessionId: first });
  var back = new FakeElement("textarea");
  env.us.handleSessionShown(back);
  assert.equal(back.value, "unfinished");
});

// ---------------------------------------------------------------- cards and replay

test("the result card shows command, output and status for every outcome", async function () {
  var env = await setup();
  var shape = {
    "a result": [{ exitCode: 0, durationMs: 1500, output: "hi\n" }, "ok", /^exit 0 · 1\.5 s$/],
    "a failure": [{ exitCode: 3, durationMs: 40 }, "failed", /^exit 3 · 40 ms$/],
    "truncated": [{ exitCode: 0, durationMs: 5, truncated: true, output: "x" }, "ok", /exit 0 .*output cut at the size limit/],
    "timed out": [{ exitCode: null, timedOut: true, durationMs: 600000 }, "failed", /timed out and was stopped · 10 min 0 s/],
    "interrupted": [{ exitCode: null, interrupted: true, durationMs: 3 }, "failed", /^interrupted/],
    "refused": [{ refused: true, reason: "os_users", message: "Off with OS-user isolation.", exitCode: null }, "refused", /^Off with OS-user isolation\.$/],
    "denied": [{ denied: true, reason: "denied", message: "Not approved.", exitCode: null }, "denied", /^Not approved\.$/],
    "an error": [{ error: true, output: "spawn failed", exitCode: null }, "error", /could not run/],
  };
  Object.keys(shape).forEach(function (name) {
    els.messages._children = [];
    env.us.handleShellResult(Object.assign({ type: "shell_result", requestId: "id-" + name, command: "echo hi" }, shape[name][0]));
    var card = cards()[0];
    assert.equal(card.className, "shell-result " + shape[name][1], name);
    assert.equal(card.querySelector(".shell-cmd").textContent, "!echo hi", name);
    assert.match(card.querySelector(".shell-status").textContent, shape[name][2], name);
    if (shape[name][0].output) assert.equal(card.querySelector(".shell-output").textContent, shape[name][0].output, name);
  });
});

test("output is shown as text, never as markup", async function () {
  var env = await setup();
  var hostile = "<img src=x onerror=alert(1)>\n</pre><script>1</script>";
  env.us.handleShellResult({ type: "shell_result", requestId: "h", command: "cat x", exitCode: 0, durationMs: 1, output: hostile });
  var out = cards()[0].querySelector(".shell-output");
  assert.equal(out.textContent, hostile);
  assert.equal(out.children.length, 0);
});

test("a replayed result renders its card without touching the queue or the send button", async function () {
  var env = await setup();
  env.store.set({ replayingHistory: true });
  env.us.handleShellResult({ type: "shell_result", requestId: "old", command: "make", exitCode: 1, durationMs: 90, output: "boom\n" });
  env.us.handleShellResult({ type: "shell_result", requestId: "old2", command: "make", refused: true, reason: "busy", message: "Busy.", exitCode: null });
  assert.equal(cards().length, 2);
  assert.equal(cards()[0].className, "shell-result failed");
  assert.equal(cards()[0].querySelector(".shell-output").textContent, "boom\n");
  assert.ok(cards()[1].querySelector(".shell-edit"), "a replayed refusal can still be edited");
  assert.equal(env.sent.length, 0);
});

// ---------------------------------------------------------------- settings controls

function fire(el, value) {
  el.value = value;
  el.onchange();
}

test("the settings controls send set_user_shell_settings and follow what the server sends", async function () {
  var env = await setup();
  var controls = await import(dom.moduleUrl("shell-settings-controls.js"));
  var out = [];
  env.us.handleUserShellSettings({ userShellEnabled: true, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256 });
  controls.renderUserShellSettings(function (type, data) { out.push(Object.assign({ type: type }, data)); });
  assert.equal(els["ss-user-shell-timeout"].value, "10");
  assert.equal(els["ss-user-shell-cap"].value, "256");
  assert.equal(els["ss-user-shell-enabled"].checked, true);

  els["ss-user-shell-enabled"].checked = false;
  els["ss-user-shell-enabled"].onchange();
  fire(els["ss-user-shell-timeout"], "30");
  fire(els["ss-user-shell-cap"], "512");
  assert.deepEqual(out, [
    { type: "set_user_shell_settings", userShellEnabled: false },
    { type: "set_user_shell_settings", userShellTimeoutMinutes: 30 },
    { type: "set_user_shell_settings", userShellMaxOutputKiB: 512 },
  ]);

  out.length = 0;
  ["0", "1441", "1.5", "abc", ""].forEach(function (bad) { fire(els["ss-user-shell-timeout"], bad); });
  ["0", "4097", "-3"].forEach(function (bad) { fire(els["ss-user-shell-cap"], bad); });
  assert.deepEqual(out, [], "a value the server would refuse is not sent");
  assert.match(els["ss-user-shell-problem"].textContent, /output limit must be a whole number from 1 to 4096/);
  assert.equal(els["ss-user-shell-cap"].value, "256", "the control goes back to the value in force");

  env.us.handleUserShellSettings({ userShellEnabled: false, userShellTimeoutMinutes: 45, userShellMaxOutputKiB: 64 });
  assert.equal(els["ss-user-shell-enabled"].checked, false);
  assert.equal(els["ss-user-shell-timeout"].value, "45");
  assert.equal(els["ss-user-shell-cap"].value, "64");
  assert.equal(env.us.isShellModeOn(), false, "the composer follows");
});

test("the settings card is on the server settings page for admins only, and the page wires it", function () {
  var base = path.join(__dirname, "..", "lib", "public");
  var html = fs.readFileSync(path.join(base, "index.html"), "utf8");
  var card = html.slice(html.lastIndexOf('<div class="settings-card', html.indexOf('id="ss-user-shell-enabled"')), html.indexOf('id="ss-user-shell-problem"'));
  assert.match(card, /settings-admin-only/);
  ["ss-user-shell-enabled", "ss-user-shell-timeout", "ss-user-shell-cap"].forEach(function (id) {
    assert.ok(card.indexOf('id="' + id + '"') !== -1, id);
  });
  var settings = fs.readFileSync(path.join(base, "modules", "server-settings.js"), "utf8");
  assert.match(settings, /renderUserShellSettings\(ssSendMsg\)/);
  var messages = fs.readFileSync(path.join(base, "modules", "app-messages.js"), "utf8");
  assert.match(messages, /shell_result: handleShellResult/);
  assert.match(messages, /user_shell_settings: handleUserShellSettings/);
  assert.match(messages, /inputEl\.value = draft;\s*[^\n]*\n[^\n]*\n\s*handleSessionShown\(inputEl\)/);
  assert.match(messages, /history_done: function \(msg\) \{\s*handleHistoryDone\(msg\);\s*handleHistoryReplayed\(\);/);
  assert.match(fs.readFileSync(path.join(base, "style.css"), "utf8"), /css\/user-shell\.css/);
});

// ---------------------------------------------------------------- pure rules

test("parseShellLine drops only the ! and the whitespace after it", async function () {
  var m = await import(dom.moduleUrl("shell-line.js"));
  assert.equal(m.parseShellLine("!ls -la"), "ls -la");
  assert.equal(m.parseShellLine("!   git status  "), "git status  ");
  assert.equal(m.parseShellLine("  !ls"), "ls");
  assert.equal(m.parseShellLine("!!"), "!");
  assert.equal(m.parseShellLine("!echo a\n  b\n"), "echo a\n  b\n");
  ["!", "!   ", "!\n", "ls", "hello !", "", null, undefined, 5].forEach(function (line) {
    assert.equal(m.parseShellLine(line), null, JSON.stringify(line));
  });
});
