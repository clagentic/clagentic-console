"use strict";
// Chat sent into a running Claude turn: the agent reports which messages it has
// taken in (user_message_uuids), the console turns that into message_delivered
// exactly once, and a message not yet taken can be withdrawn (cancel_async_message).
// Cancel racing delivery never produces both. Codex and other agents without the
// capability keep the old behaviour.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var queuedChat = require("../lib/queued-chat");
var claudeAdapter = require("../lib/yoke/adapters/claude");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var { codexCapabilities } = require("../lib/yoke/adapters/codex-capabilities");
var { resolveCapabilities } = require("../lib/yoke/capabilities");

var ID_A = "11111111-1111-4111-8111-111111111111";
var ID_B = "22222222-2222-4222-8222-222222222222";

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

// ------------------------------------------------------------ the SDK it relies on

test("the installed Claude SDK carries consumed message uuids and a queued-message cancel", function () {
  var dir = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk");
  var types = fs.readFileSync(path.join(dir, "sdk.d.ts"), "utf8");
  var runtime = fs.readFileSync(path.join(dir, "sdk.mjs"), "utf8");
  assert.ok(types.indexOf("user_message_uuids?: string[]") !== -1, "frames name the consumed user messages");
  assert.ok(types.indexOf("subtype: 'cancel_async_message'") !== -1, "the control request exists");
  assert.ok(runtime.indexOf("async cancelAsyncMessage(") !== -1, "the Query method exists at run time");
});

test("the SDK keeps a message the CLI has not consumed and runs it as a later turn; it is not discarded at a turn's result", function () {
  var dir = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk");
  var types = fs.readFileSync(path.join(dir, "sdk.d.ts"), "utf8");
  assert.ok(types.indexOf("These WILL run") !== -1, "queued async messages survive an interrupt and run");
  assert.ok(types.indexOf("Survivors that ride any later turn run normally") !== -1, "they ride a later turn");
  assert.ok(types.indexOf("the drain loop, which starts the next queued turn immediately") !== -1 ||
    types.indexOf("the drain loop starts the next queued turn immediately") !== -1, "the next queued turn starts at once");
});

test("a message is dropped only when the query closes: the bridge calls dropAll in one place, the query's close, never at a turn's result", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "sdk-bridge.js"), "utf8");
  var calls = src.split("queuedChat.dropAll(").length - 1;
  assert.equal(calls, 1);
  var at = src.indexOf("queuedChat.dropAll(");
  var before = src.slice(Math.max(0, at - 900), at);
  assert.ok(/session\.queryInstance === myQueryInstance/.test(before), "inside the query-close cleanup");
  assert.ok(/finally/.test(src.slice(0, at).split("\n").slice(-60).join("\n")), "in the stream's finally block");
});

// ------------------------------------------------------------ the adapter

test("flattenEvent passes the consumed uuids through, and falls back to the single uuid", function () {
  var flat = claudeAdapter._test_flattenEvent({
    type: "assistant", uuid: "u1", session_id: "s", message: { content: [] },
    user_message_uuid: ID_B, user_message_uuids: [ID_A, ID_B],
  });
  assert.deepEqual(flat.userMessageUuids, [ID_A, ID_B]);

  var stream = claudeAdapter._test_flattenEvent({
    type: "stream_event", event: { type: "message_start", message: {} }, user_message_uuids: [ID_A],
  });
  assert.equal(stream.yokeType, "turn_start");
  assert.deepEqual(stream.userMessageUuids, [ID_A]);

  var older = claudeAdapter._test_flattenEvent({ type: "result", subtype: "success", user_message_uuid: ID_A });
  assert.deepEqual(older.userMessageUuids, [ID_A]);

  var none = claudeAdapter._test_flattenEvent({ type: "assistant", message: { content: [] } });
  assert.equal("userMessageUuids" in none, false);
  var junk = claudeAdapter._test_flattenEvent({ type: "assistant", message: { content: [] }, user_message_uuids: [3, "", null] });
  assert.equal("userMessageUuids" in junk, false, "only string ids count");
});

test("the in-process handle cancels through the SDK and says whether the message was still queued", async function () {
  var asked = [];
  var queue = { push: function () {}, end: function () {} };
  var handle = claudeAdapter._test_createQueryHandle({
    cancelAsyncMessage: function (id) { asked.push(id); return Promise.resolve(id === ID_A); },
  }, queue, null);
  assert.equal(await handle.cancelQueuedMessage(ID_A), true);
  assert.equal(await handle.cancelQueuedMessage(ID_B), false, "already taken or unknown");
  assert.deepEqual(asked, [ID_A, ID_B]);

  var bare = claudeAdapter._test_createQueryHandle({}, queue, null);
  await assert.rejects(bare.cancelQueuedMessage(ID_A), /cannot cancel a queued message/);
});

test("the worker handle sends the cancel to the worker and settles on its answer", async function () {
  var worker = { sent: [], handler: null, process: null, exitPromise: null };
  worker.onMessage = function (fn) { worker.handler = fn; };
  worker.send = function (msg) { worker.sent.push(msg); };
  var handle = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);

  var yes = handle.cancelQueuedMessage(ID_A);
  var no = handle.cancelQueuedMessage(ID_B);
  var failing = handle.cancelQueuedMessage(ID_A);
  var cancels = worker.sent.filter(function (m) { return m.type === "cancel_message"; });
  assert.deepEqual(cancels.map(function (m) { return m.messageId; }), [ID_A, ID_B, ID_A]);
  worker.handler({ type: "cancel_message_response", requestId: cancels[0].requestId, cancelled: true });
  worker.handler({ type: "cancel_message_response", requestId: cancels[1].requestId, cancelled: false });
  worker.handler({ type: "cancel_message_response", requestId: cancels[2].requestId, error: "no such query" });
  assert.equal(await yes, true);
  assert.equal(await no, false);
  await assert.rejects(failing, /no such query/);

  var pending = handle.cancelQueuedMessage(ID_B);
  worker.handler({ type: "query_done" });
  await assert.rejects(pending, /query ended/, "a query that ends leaves no cancel waiting");
});

test("only Claude declares the capability; Codex and the resolved sets report it absent", function () {
  assert.equal(claudeCapabilities().queuedMessageCancel, true);
  assert.equal(codexCapabilities().queuedMessageCancel, false);
  var yoke = require("../lib/yoke");
  assert.equal(yoke.registry.declaredCapabilities("codex").queuedMessageCancel, false);
  assert.equal(yoke.registry.declaredCapabilities("claude").queuedMessageCancel, true);
  var claudeResolved = resolveCapabilities({ capabilities: claudeCapabilities() }, null, null);
  var codexResolved = resolveCapabilities({ capabilities: codexCapabilities() }, null, null);
  assert.equal(claudeResolved.queuedMessageCancel, true, "resolved Claude set: present");
  assert.equal(codexResolved.queuedMessageCancel, false, "resolved Codex set: absent");
  var narrowed = resolveCapabilities({ capabilities: claudeCapabilities() }, null, { queuedMessageCancel: false });
  assert.equal(narrowed.queuedMessageCancel, false, "a session that reports it false turns it off");
});

// ------------------------------------------------------------ the tracker

function tracker() {
  var seen = { delivered: [], dropped: [] };
  var session = {};
  function track(id) {
    queuedChat.register(session, id, {
      onDelivered: function () { seen.delivered.push(id); },
      onDropped: function () { seen.dropped.push(id); },
    });
  }
  return { session: session, seen: seen, track: track };
}

test("a tracked message is delivered once, by id, and unknown ids are ignored", function () {
  var t = tracker();
  t.track(ID_A);
  assert.deepEqual(queuedChat.consume(t.session, ["other", ID_A]), [ID_A]);
  assert.deepEqual(queuedChat.consume(t.session, [ID_A]), [], "a second report of the same id changes nothing");
  assert.deepEqual(t.seen.delivered, [ID_A]);
  assert.equal(queuedChat.has(t.session, ID_A), false);
});

test("cancel before delivery drops the message for good; a later report of it delivers nothing", async function () {
  var t = tracker();
  t.track(ID_A);
  var result = await queuedChat.cancel(t.session, ID_A, function () { return Promise.resolve(true); });
  assert.equal(result, "cancelled");
  assert.deepEqual(queuedChat.consume(t.session, [ID_A]), []);
  assert.deepEqual(t.seen, { delivered: [], dropped: [] });
});

test("cancel after delivery is already_delivered and never asks the agent", async function () {
  var t = tracker();
  t.track(ID_A);
  queuedChat.consume(t.session, [ID_A]);
  var asked = 0;
  var result = await queuedChat.cancel(t.session, ID_A, function () { asked++; return Promise.resolve(true); });
  assert.equal(result, "already_delivered");
  assert.equal(asked, 0);
});

test("a cancel that races delivery yields delivery alone, whatever the agent answers", async function () {
  var t = tracker();
  t.track(ID_A);
  var release;
  var pending = queuedChat.cancel(t.session, ID_A, function () { return new Promise(function (resolve) { release = resolve; }); });
  await tick();
  queuedChat.consume(t.session, [ID_A]);
  release(true);
  assert.equal(await pending, "already_delivered");
  assert.deepEqual(t.seen.delivered, [ID_A], "delivered once");

  var t2 = tracker();
  t2.track(ID_A);
  var result = await queuedChat.cancel(t2.session, ID_A, function () { return Promise.resolve(false); });
  assert.equal(result, "already_delivered", "the agent had taken it");
  assert.equal(queuedChat.has(t2.session, ID_A), true, "its delivery report is still to come");
  queuedChat.consume(t2.session, [ID_A]);
  assert.deepEqual(t2.seen.delivered, [ID_A]);
});

test("two cancels of one message ask the agent once; a failed ask leaves the message tracked", async function () {
  var t = tracker();
  t.track(ID_A);
  var asked = 0;
  function ask() { asked++; return Promise.resolve(true); }
  var both = await Promise.all([queuedChat.cancel(t.session, ID_A, ask), queuedChat.cancel(t.session, ID_A, ask)]);
  assert.deepEqual(both, ["cancelled", "cancelled"]);
  assert.equal(asked, 1);

  var t2 = tracker();
  t2.track(ID_B);
  await assert.rejects(queuedChat.cancel(t2.session, ID_B, function () { return Promise.reject(new Error("no answer")); }), /no answer/);
  assert.equal(queuedChat.has(t2.session, ID_B), true);
  assert.equal(await queuedChat.cancel(t2.session, ID_B, function () { return Promise.resolve(true); }), "cancelled", "it can be asked again");
});

test("messages never taken when the query closes are dropped once each", function () {
  var t = tracker();
  t.track(ID_A);
  t.track(ID_B);
  queuedChat.consume(t.session, [ID_A]);
  assert.deepEqual(queuedChat.dropAll(t.session), [ID_B]);
  assert.deepEqual(queuedChat.dropAll(t.session), []);
  assert.deepEqual(t.seen, { delivered: [ID_A], dropped: [ID_B] });
});

test("a turn's result frame (no consumed uuids) neither delivers nor drops a tracked message", function () {
  var t = tracker();
  t.track(ID_A);
  assert.deepEqual(queuedChat.consume(t.session, undefined), []);
  assert.deepEqual(queuedChat.consume(t.session, []), []);
  assert.equal(queuedChat.has(t.session, ID_A), true, "still tracked for the next turn");
  assert.deepEqual(t.seen, { delivered: [], dropped: [] });
  assert.deepEqual(queuedChat.consume(t.session, [ID_A]), [ID_A], "the next turn takes it");
});

test("only a uuid is accepted as a message id", function () {
  assert.equal(queuedChat.isMessageId(ID_A), true);
  ["", "abc", 5, null, undefined, {}, ID_A + "x", "../" + ID_A].forEach(function (v) {
    assert.equal(queuedChat.isMessageId(v), false, String(v));
  });
});

// ------------------------------------------------------------ the message handler

// Runs the real user-message handler over a real session manager with a fake agent.
async function harness(sdkOver) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "queued-chat-"));
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var reload = ["../lib/config", "../lib/sessions", "../lib/utils"];
  reload.forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var noop = function () {};
  var sm = require("../lib/sessions").createSessionManager({ cwd: tmpHome, send: noop, sendTo: noop, sendEach: noop });
  var session = sm.createSessionRaw({});
  session.cliSessionId = "queued-chat-1";
  session.vendor = "claude";
  session.title = "t";
  session.isProcessing = true;
  sm.saveSessionFile(session);
  var out = { toSender: [], toSession: [], toOthers: [], pushed: [], cancelled: [] };
  var ws = { id: "sender" };
  var sdk = Object.assign({
    canSteer: function () { return true; },
    steerMessage: function () { return Promise.resolve({ steered: true }); },
    canCancelQueued: function () { return true; },
    cancelQueuedMessage: function (s, id) { out.cancelled.push(id); return Promise.resolve(true); },
    pushMessage: function (s, text, images, initiator, messageId) { out.pushed.push({ text: text, messageId: messageId }); },
    startQuery: noop,
  }, sdkOver || {});
  var handler = require("../lib/project-user-message").attachUserMessage({
    cwd: tmpHome, slug: "p", osUsers: false, sm: sm, sdk: sdk, nm: {}, tm: {},
    send: noop,
    sendTo: function (to, obj) { out.toSender.push(obj); },
    sendToSession: function (id, obj) { out.toSession.push(obj); },
    sendToSessionOthers: function (w, id, obj) { out.toOthers.push(obj); },
    clients: new Set(), opts: {}, usersModule: {},
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: noop, hydrateImageRefs: function (m) { return m; }, saveImageFile: noop, imagesDir: tmpHome,
    onProcessingChanged: noop,
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: { _browserTabList: {} },
    scheduledInput: {},
    loadContextSources: function () { return []; }, saveContextSources: noop,
    adapter: { renameSession: function () { return Promise.resolve(); } },
  });
  return {
    out: out, session: session, ws: ws,
    send: function (msg) { handler.handleUserMessage(ws, msg); },
    records: function () { return session.history.filter(function (h) { return h.type === "user_message"; }); },
    delivered: function () { return out.toSession.filter(function (m) { return m.type === "message_delivered"; }); },
    replies: function () { return out.toSender.filter(function (m) { return m.type === "queued_message_cancelled"; }); },
    done: function () {
      if (origHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origHome;
      reload.forEach(function (m) { delete require.cache[require.resolve(m)]; });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

test("chat pushed into a running turn is held as queued: pushed at once with its id, recorded only when delivered", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "queued one", messageId: ID_A });
    await tick();
    assert.deepEqual(h.out.pushed, [{ text: "queued one", messageId: ID_A }], "pushed at once, no client hold, the page's id is the message uuid");
    assert.equal(h.records().length, 0, "not in the conversation yet");
    assert.equal(h.delivered().length, 0);
    assert.equal(h.out.toOthers.length, 0);

    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.records().length, 1);
    assert.equal(h.records()[0].messageId, ID_A);
    assert.equal(h.delivered().length, 1, "message_delivered once");
    assert.deepEqual(h.delivered()[0], { type: "message_delivered", messageId: ID_A });
    assert.equal(h.out.toOthers.length, 1, "other viewers get the message once");

    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.records().length, 1);
    assert.equal(h.delivered().length, 1, "never twice");
  } finally { h.done(); }
});

test("cancel before delivery withdraws the message at the agent and it is never recorded or delivered", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "take me back", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    assert.deepEqual(h.out.cancelled, [ID_A]);
    assert.deepEqual(h.replies(), [{ type: "queued_message_cancelled", messageId: ID_A, result: "cancelled", text: "take me back", pastes: [], imageCount: 0 }]);
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.records().length, 0);
    assert.equal(h.delivered().length, 0);
  } finally { h.done(); }
});

test("cancel after delivery replies already_delivered and nothing is lost or doubled", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "too late", messageId: ID_A });
    queuedChat.consume(h.session, [ID_A]);
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    assert.equal(h.out.cancelled.length, 0, "the agent is not asked about a message it already took");
    assert.deepEqual(h.replies(), [{ type: "queued_message_cancelled", messageId: ID_A, result: "already_delivered" }]);
    assert.equal(h.records().length, 1);
    assert.equal(h.delivered().length, 1);
  } finally { h.done(); }
});

test("a cancel racing delivery gives delivery alone, never a cancel and a delivery", async function () {
  var release;
  var h = await harness({
    cancelQueuedMessage: function () { return new Promise(function (resolve) { release = resolve; }); },
  });
  try {
    h.send({ type: "message", text: "photo finish", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    queuedChat.consume(h.session, [ID_A]);
    release(true);
    await tick();
    assert.deepEqual(h.replies().map(function (r) { return r.result; }), ["already_delivered"]);
    assert.equal(h.records().length, 1);
    assert.equal(h.delivered().length, 1);
  } finally { h.done(); }
});

test("a cancel the agent cannot answer is reported, and the message stays queued", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.reject(new Error("worker gone")); } });
  try {
    h.send({ type: "message", text: "stuck", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    var reply = h.replies()[0];
    assert.equal(reply.result, "error");
    assert.match(reply.message, /worker gone/);
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.records().length, 1, "it is still delivered when the agent takes it");
  } finally { h.done(); }
});

test("an agent without the capability: recorded at once, announced delivered at once, cancel unsupported", async function () {
  var h = await harness({ canCancelQueued: function () { return false; } });
  try {
    h.send({ type: "message", text: "codex-like", messageId: ID_A });
    await tick();
    assert.equal(h.records().length, 1, "recorded when sent, as on main");
    assert.deepEqual(h.out.toSender.filter(function (m) { return m.type === "message_delivered"; }), [{ type: "message_delivered", messageId: ID_A }]);
    assert.equal(queuedChat.has(h.session, ID_A), false);
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    assert.equal(h.replies()[0].result, "unsupported");
    assert.equal(h.out.cancelled.length, 0);
  } finally { h.done(); }
});

test("a message sent without an id behaves exactly as before: recorded at once, nothing announced", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "plain" });
    h.send({ type: "message", text: "bad id", messageId: "not-a-uuid" });
    await tick();
    assert.equal(h.records().length, 2);
    assert.equal(h.out.pushed.length, 2);
    assert.equal(h.out.toSender.filter(function (m) { return m.type === "message_delivered"; }).length, 0);
    assert.equal(queuedChat.has(h.session, "not-a-uuid"), false);
  } finally { h.done(); }
});

test("send now is never held as queued: it is recorded after its steer outcome, with no second push", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "steer me", sendNow: true });
    await tick(); await tick();
    assert.equal(h.records().length, 1);
    assert.equal(h.records()[0].sentMidTurn, true);
    assert.equal(h.out.pushed.length, 0, "the steer path pushed nothing else");
    assert.equal(h.delivered().length, 0);
  } finally { h.done(); }
});

test("a query that closes with the message never taken drops it: not recorded, and the page is told", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "orphan", messageId: ID_A });
    queuedChat.dropAll(h.session);
    assert.equal(h.records().length, 0);
    assert.deepEqual(h.out.toSession.filter(function (m) { return m.type === "queued_message_cancelled"; }),
      [{ type: "queued_message_cancelled", messageId: ID_A, result: "dropped", text: "orphan", pastes: [], imageCount: 0 }]);
  } finally { h.done(); }
});

test("a message sent after the turn already ended is recorded at once and announced delivered", async function () {
  var h = await harness();
  try {
    h.session.isProcessing = false;
    h.send({ type: "message", text: "idle send", messageId: ID_A });
    await tick();
    assert.equal(h.records().length, 1);
    assert.equal(h.out.toSender.filter(function (m) { return m.type === "message_delivered"; }).length, 1);
    assert.equal(queuedChat.has(h.session, ID_A), false);
  } finally { h.done(); }
});

test("a dropped reply carries the message text, pastes and image count so the page can restore it", async function () {
  var t = await harness();
  t.send({ type: "message", text: "wait for me", pastes: ["a paste"], images: [{ mediaType: "image/png", data: "AA==" }], messageId: ID_A });
  assert.equal(queuedChat.dropAll(t.session).length, 1);
  var dropped = t.out.toSession.filter(function (m) { return m.type === "queued_message_cancelled"; });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].result, "dropped");
  assert.equal(dropped[0].text, "wait for me");
  assert.deepEqual(dropped[0].pastes, ["a paste"]);
  assert.equal(dropped[0].imageCount, 1);
  t.done();
});

test("a cancelled reply carries the message text; other answers do not", async function () {
  var t = await harness();
  t.send({ type: "message", text: "take it back", messageId: ID_A });
  t.send({ type: "cancel_queued_message", messageId: ID_A });
  await tick(); await tick();
  var r = t.replies();
  assert.equal(r.length, 1);
  assert.equal(r[0].result, "cancelled");
  assert.equal(r[0].text, "take it back");
  t.send({ type: "cancel_queued_message", messageId: ID_A });
  await tick(); await tick();
  assert.equal(t.replies()[1].result, "already_delivered");
  assert.equal("text" in t.replies()[1], false);
  t.done();
});
