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
  assert.equal(result, "pending", "false does not say the agent runs it: it is not reported already_delivered");
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

// ------------------------------------------------------------ cancelled:false (SDK 0.3.318 notes)
// A fake agent answers false to every cancel below, as the SDK does for a
// coalesced-batch member, the batch representative and a held-back uuid.

var ID_C = "33333333-3333-4333-8333-333333333333";
var ID_D = "44444444-4444-4444-8444-444444444444";
function frameOf(h, isResult) { queuedChat.settleTurn(h.session, isResult); }
function droppedReplies(h) { return h.out.toSession.filter(function (m) { return m.type === "queued_message_cancelled" && m.result === "dropped"; }); }
function answers(h) { return h.replies().map(function (r) { return r.result; }); }

test("a non-representative batch member: false, it still runs, stays tracked, becomes a normal message, nothing is dropped", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "member one", messageId: ID_A });
    h.send({ type: "message", text: "member two", messageId: ID_B });
    h.send({ type: "cancel_queued_message", messageId: ID_B });
    await tick(); await tick();
    assert.deepEqual(answers(h), ["pending"], "never already_delivered");
    frameOf(h, false);
    queuedChat.consume(h.session, [ID_A, ID_B]);
    frameOf(h, true);
    assert.equal(h.records().length, 2, "both are normal messages");
    assert.equal(h.delivered().length, 2);
    assert.equal(droppedReplies(h).length, 0);
  } finally { h.done(); }
});

test("the batch representative: false, the whole batch never runs, every member is reported dropped with its text", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "first", messageId: ID_A });
    h.send({ type: "message", text: "second", messageId: ID_B });
    frameOf(h, true); // the turn they were queued during ends; they wait for the next turn's batch
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.deepEqual(answers(h), ["pending"]);
    h.send({ type: "message", text: "later turn", messageId: ID_C });
    frameOf(h, false); // the next turn runs without the dropped batch
    queuedChat.consume(h.session, [ID_C]);
    frameOf(h, true);
    assert.deepEqual(droppedReplies(h).map(function (m) { return [m.messageId, m.text]; }), [[ID_A, "first"], [ID_B, "second"]]);
    assert.equal(h.records().length, 1, "only the message that ran is recorded");
    assert.deepEqual(h.delivered().map(function (m) { return m.messageId; }), [ID_C], "the later message was not caught up in it");
  } finally { h.done(); }
});

test("a held-back uuid: false with a pending-cancel mark, dropped by the drain; reported dropped with its text, not already_delivered", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "held", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.deepEqual(answers(h), ["pending"]);
    frameOf(h, false); // the running turn continues
    assert.equal(droppedReplies(h).length, 0, "not decided mid-turn: a fold-in could still take it");
    frameOf(h, true); // it ends and the drain drops the message: no frame ever names it
    var dropped = droppedReplies(h);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].text, "held");
    assert.equal(h.records().length, 0);
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.delivered().length, 0, "never shown as delivered");
    frameOf(h, true);
    assert.equal(droppedReplies(h).length, 1, "reported once");
  } finally { h.done(); }
});

test("a held-back uuid the running turn folds in is delivered, not dropped", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "folded", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    frameOf(h, false);
    queuedChat.consume(h.session, [ID_A]);
    frameOf(h, true);
    assert.equal(h.delivered().length, 1);
    assert.equal(droppedReplies(h).length, 0);
  } finally { h.done(); }
});

test("no turn runs after a false cancel: the idle settle reports the message dropped with its text; a running turn is left to its result", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "idle drop", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.equal(queuedChat.hasUnconfirmed(h.session), true);
    assert.deepEqual(queuedChat.settleIdle(h.session, true), [], "a turn is running: its result settles it");
    assert.deepEqual(queuedChat.settleIdle(h.session, false), [ID_A]);
    assert.equal(droppedReplies(h)[0].text, "idle drop");
    assert.equal(queuedChat.hasUnconfirmed(h.session), false);
  } finally { h.done(); }
});

test("the grace timer after a false cancel settles an idle session", async function () {
  var timers = require("node:test").mock.timers;
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "timer", messageId: ID_A });
    timers.enable({ apis: ["setTimeout"] });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    h.session.isProcessing = false;
    timers.tick(10000);
    assert.equal(droppedReplies(h).length, 1);
  } finally { timers.reset(); h.done(); }
});

test("a plain message already consumed: cancel is already_delivered and it is delivered once (unchanged)", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "running", messageId: ID_A });
    queuedChat.consume(h.session, [ID_A]);
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick();
    assert.deepEqual(answers(h), ["already_delivered"]);
    frameOf(h, true);
    assert.equal(h.delivered().length, 1);
    assert.equal(droppedReplies(h).length, 0);
  } finally { h.done(); }
});

test("a cancel of one message that puts a waiting sibling in doubt tells the sibling's page, and the sibling's own cancel still reaches the agent", async function () {
  var asked = [];
  var h = await harness({ cancelQueuedMessage: function (s, id) { asked.push(id); return Promise.resolve(id === ID_B); } });
  try {
    h.send({ type: "message", text: "first", messageId: ID_A });
    h.send({ type: "message", text: "second", messageId: ID_B });
    frameOf(h, true);
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    var told = h.out.toSession.filter(function (m) { return m.type === "queued_message_cancelled" && m.result === "pending"; });
    assert.deepEqual(told.map(function (m) { return m.messageId; }), [ID_B], "the sibling's page is told it is in doubt");
    h.send({ type: "cancel_queued_message", messageId: ID_B });
    await tick(); await tick();
    assert.deepEqual(asked, [ID_A, ID_B], "the sibling's cancel reached the agent");
    assert.deepEqual(h.replies().map(function (r) { return [r.messageId, r.result]; }), [[ID_A, "pending"], [ID_B, "cancelled"]]);
    assert.equal(h.replies()[1].text, "second", "restored once");
    assert.equal(queuedChat.has(h.session, ID_B), false);
    queuedChat.consume(h.session, [ID_B]);
    assert.equal(h.delivered().length, 0, "a withdrawn message never runs as delivered");
  } finally { h.done(); }
});

test("a dropped reply names its cause: not taken by the turn, or the query closed", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "one", messageId: ID_A });
    h.send({ type: "message", text: "two", messageId: ID_B });
    frameOf(h, true);
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    frameOf(h, false);
    frameOf(h, true);
    assert.deepEqual(droppedReplies(h).map(function (m) { return [m.messageId, m.cause]; }), [[ID_A, "not_taken"], [ID_B, "not_taken"]]);
    h.send({ type: "message", text: "three", messageId: ID_C });
    queuedChat.dropAll(h.session);
    assert.equal(droppedReplies(h)[2].cause, "closed");
  } finally { h.done(); }
});

test("a representative cancel drops the batch dequeued for the running turn; a message pushed during that turn is not in it and stays queued", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "first", messageId: ID_A });
    h.send({ type: "message", text: "second", messageId: ID_B });
    frameOf(h, true); // the turn they were queued in ends: they are the next turn's batch
    h.send({ type: "message", text: "pushed during the batch's turn", messageId: ID_C });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    var pendingTold = h.out.toSession.filter(function (m) { return m.result === "pending"; }).map(function (m) { return m.messageId; });
    assert.deepEqual(pendingTold, [ID_B], "the batch mate is in doubt; the later message is not");
    frameOf(h, false);
    queuedChat.consume(h.session, [ID_C]); // folded into the running turn
    frameOf(h, true);
    assert.deepEqual(droppedReplies(h).map(function (m) { return m.messageId; }), [ID_A, ID_B]);
    assert.deepEqual(h.delivered().map(function (m) { return m.messageId; }), [ID_C]);
  } finally { h.done(); }
});

test("the message processor delivers a message named on a frame before it settles the turn: through the frame path, consume then settle", function () {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor.js");
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null, currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function () {}, sendToSession: function () {}, saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  var processor = attachMessageProcessor({
    sm: sm, send: function () {}, slug: "t", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; }, adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; }, discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; }, mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
  var session = {
    localId: "s1", cliSessionId: null, vendor: "claude", history: [], messageUUIDs: [], blocks: {}, sentToolResults: {},
    pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {}, activeTaskToolIds: {}, taskIdMap: {},
    streamedText: false, responsePreview: "", isProcessing: true, loop: null, lastActivityAt: 0,
  };
  var events = [];
  function hooks(id) {
    return { onDelivered: function () { events.push(["delivered", id]); }, onDropped: function (cause) { events.push(["dropped", id, cause]); } };
  }
  queuedChat.register(session, ID_A, hooks(ID_A));
  queuedChat.register(session, ID_B, hooks(ID_B));
  queuedChat.register(session, ID_C, hooks(ID_C));
  queuedChat.register(session, ID_D, hooks(ID_D));
  queuedChat.cancel(session, ID_A, function () { return Promise.resolve(false); });
  queuedChat.cancel(session, ID_D, function () { return Promise.resolve(false); });
  return tick().then(function () {
    processor.processSDKMessage(session, { yokeType: "status", status: null });
    assert.deepEqual(events, [], "nothing is settled mid-turn");
    processor.processSDKMessage(session, { yokeType: "result", userMessageUuids: [ID_A] });
    assert.deepEqual(events, [["delivered", ID_A], ["dropped", ID_D, "not_taken"]], "named on the result frame: delivered; not named: dropped after it");
    assert.equal(queuedChat.has(session, ID_B), true, "a message never in doubt keeps waiting");
    assert.equal(queuedChat.has(session, ID_C), true);
  });
});
