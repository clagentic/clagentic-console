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

// A query the bridge can run over: frames are fed in by the test, then the stream
// closes (finish) or breaks (fail), as a worker that dies does.
function fakeQuery() {
  var inbox = [];
  var waiting = null;
  function deliver(item) {
    if (waiting) { var w = waiting; waiting = null; if (item.error) w.reject(item.error); else w.resolve(item.result); }
    else inbox.push(item);
  }
  var q = {
    _adapterState: null,
    pushed: [],
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (inbox.length) { var item = inbox.shift(); return item.error ? Promise.reject(item.error) : Promise.resolve(item.result); }
          return new Promise(function (resolve, reject) { waiting = { resolve: resolve, reject: reject }; });
        },
      };
    },
    pushMessage: function (text, images, initiator, messageId) { q.pushed.push(messageId); },
    endInput: function () {},
    close: function () { deliver({ result: { value: undefined, done: true } }); },
    abort: function () { deliver({ result: { value: undefined, done: true } }); },
    emit: function (frame) { deliver({ result: { value: frame, done: false } }); },
    finish: function () { deliver({ result: { value: undefined, done: true } }); },
    fail: function (err) { deliver({ error: err }); },
  };
  return q;
}

// The real bridge over the harness's real session manager, with the agent's queries
// supplied by the test. The handler pushes through the bridge, as in the daemon.
function bridgeFor(h, queries) {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var next = 0;
  var adapter = {
    vendor: "claude",
    createQuery: function () { return Promise.resolve(queries[next++]); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null, renameSession: null, forkSession: null,
  };
  return createSDKBridge({
    cwd: h.tmpHome, slug: "p", sessionManager: h.sm, send: function () {},
    adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {}, getConfig: null,
  });
}

async function settle() { for (var i = 0; i < 6; i++) await tick(); }

test("a message is dropped only when the query closes: a turn's result frame drops nothing, the stream's close drops it once", async function () {
  var query = fakeQuery();
  var bridge = null;
  var h = await harness({ pushMessage: function () { return bridge.pushMessage.apply(null, arguments); } });
  try {
    bridge = bridgeFor(h, [query]);
    await bridge.startQuery(h.session, "first", null, null);
    h.session.isProcessing = true;
    h.send({ type: "message", text: "waits for a later turn", messageId: ID_A });
    assert.deepEqual(query.pushed.slice(-1), [ID_A], "pushed into the live query");
    query.emit({ yokeType: "result" });
    await settle();
    assert.equal(droppedReplies(h).length, 0, "a turn's result frame drops nothing");
    assert.equal(queuedChat.has(h.session, ID_A), true);
    query.finish();
    await settle();
    assert.deepEqual(droppedReplies(h).map(function (m) { return [m.messageId, m.cause, m.text]; }), [[ID_A, "closed", "waits for a later turn"]]);
    assert.equal(queuedChat.has(h.session, ID_A), false);
  } finally { h.done(); }
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
  var out = { toSender: [], toSession: [], toOthers: [], pushed: [], cancelled: [], toWs: [] };
  // Every frame the session manager sends to one socket (a session shown), by socket.
  function recordTo(to, obj) { out.toWs.push({ ws: to, obj: obj }); }
  var sm = require("../lib/sessions").createSessionManager({ cwd: tmpHome, send: noop, sendTo: recordTo, sendEach: noop });
  var session = sm.createSessionRaw({});
  session.cliSessionId = "queued-chat-1";
  session.vendor = "claude";
  session.title = "t";
  session.isProcessing = true;
  sm.saveSessionFile(session);
  var ws = { id: "sender" };
  var clients = new Set([ws]);
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
    clients: clients, opts: {}, usersModule: {},
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
    out: out, session: session, ws: ws, sm: sm, clients: clients, tmpHome: tmpHome,
    // A second tab on the same session: its own socket, shown the session, viewing it.
    sendFrom: function (from, msg) { handler.handleUserMessage(from, msg); },
    send: function (msg) { handler.handleUserMessage(ws, msg); },
    // The daemon restarted: a new session manager reads the same session files.
    restart: function () {
      reload.forEach(function (m) { delete require.cache[require.resolve(m)]; });
      var shown = [];
      var rsm = require("../lib/sessions").createSessionManager({ cwd: tmpHome, send: noop, sendTo: function (to, obj) { shown.push({ ws: to, obj: obj }); }, sendEach: noop });
      var again = null;
      rsm.sessions.forEach(function (s) { if (s.cliSessionId === session.cliSessionId) again = s; });
      return { sm: rsm, session: again, shown: shown };
    },
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
      [{ type: "queued_message_cancelled", messageId: ID_A, result: "dropped", cause: "closed", text: "orphan", pastes: [], imageCount: 0 }]);
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
  try {
    t.send({ type: "message", text: "wait for me", pastes: ["a paste"], images: [{ mediaType: "image/png", data: "AA==" }], messageId: ID_A });
    assert.equal(queuedChat.dropAll(t.session).length, 1);
    var dropped = t.out.toSession.filter(function (m) { return m.type === "queued_message_cancelled"; });
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].result, "dropped");
    assert.equal(dropped[0].text, "wait for me");
    assert.deepEqual(dropped[0].pastes, ["a paste"]);
    assert.equal(dropped[0].imageCount, 1);
  } finally { t.done(); }
});

test("a cancelled reply carries the message text; other answers do not", async function () {
  var t = await harness();
  try {
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
  } finally { t.done(); }
});

// ------------------------------------------------------------ cancelled:false (SDK 0.3.318 notes)
// A fake agent answers false to every cancel below, as the SDK does for a
// coalesced-batch member, the batch representative and a held-back uuid.

var ID_C = "33333333-3333-4333-8333-333333333333";
var ID_D = "44444444-4444-4444-8444-444444444444";
// A turn's frames reach the session only through the message processor; the end of a turn
// settles nothing, it only records where the next batch starts. A mid-turn frame goes
// through the real processor, so one that settled or dropped anything would show in the
// assertions that follow it. The end of a turn is recorded directly: a real result frame
// also ends the session's processing, which would turn the next send into an idle one
// that is never queued, and those rows need the message queued behind the turn.
function frameOf(h, isResult) {
  if (isResult) { queuedChat.markTurnEnd(h.session); return; }
  h.processor = h.processor || processorFor();
  h.processor.processSDKMessage(h.session, { yokeType: "status", status: null });
}
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
    assert.deepEqual(droppedReplies(h), [], "a turn's end drops nothing");
    queuedChat.settleIdle(h.session, false); // nothing runs for the grace period
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
    frameOf(h, true);
    assert.equal(droppedReplies(h).length, 0, "nor at the turn's end: the agent may run it as the next turn");
    queuedChat.settleIdle(h.session, false); // idle for the grace period: no frame ever names it
    var dropped = droppedReplies(h);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].text, "held");
    assert.equal(h.records().length, 0);
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.delivered().length, 0, "never shown as delivered");
    queuedChat.settleIdle(h.session, false);
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

test("no turn runs after a false cancel: the idle settle reports the message dropped with its text; a running turn leaves it alone", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    h.send({ type: "message", text: "idle drop", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.equal(queuedChat.hasUnconfirmed(h.session), true);
    assert.deepEqual(queuedChat.settleIdle(h.session, true), [], "a turn is running: left alone");
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

test("N pending cancels on one session arm exactly one idle-settle timer, and the settlement happens once", async function () {
  var timers = require("node:test").mock.timers;
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  var realSet = null;
  var realClear = null;
  try {
    h.send({ type: "message", text: "one", messageId: ID_A });
    h.send({ type: "message", text: "two", messageId: ID_B });
    h.send({ type: "message", text: "three", messageId: ID_C });
    timers.enable({ apis: ["setTimeout"] });
    // The mocked clock has no count of its live timers, so count them here: a
    // grace-period timer is live from its arming until it fires or is cleared.
    var live = new Set();
    realSet = globalThis.setTimeout;
    realClear = globalThis.clearTimeout;
    globalThis.setTimeout = function (fn, ms) {
      var args = Array.prototype.slice.call(arguments);
      var handle = null;
      if (ms === 10000) {
        args[0] = function () { live.delete(handle); return fn.apply(this, arguments); };
      }
      handle = realSet.apply(this, args);
      if (ms === 10000) live.add(handle);
      return handle;
    };
    globalThis.clearTimeout = function (handle) { live.delete(handle); return realClear.apply(this, arguments); };
    [ID_A, ID_B, ID_C].forEach(function (id) { h.send({ type: "cancel_queued_message", messageId: id }); });
    await tick(); await tick();
    assert.deepEqual(answers(h), ["pending", "pending", "pending"]);
    assert.equal(live.size, 1, "one idle-settle timer for the session, not one per cancel");
    h.session.isProcessing = false;
    timers.tick(10000);
    assert.deepEqual(droppedReplies(h).map(function (m) { return m.messageId; }), [ID_A, ID_B, ID_C], "each message is settled once");
    assert.equal(live.size, 0, "nothing is left armed once nothing is unconfirmed");
    timers.tick(10000);
    assert.equal(droppedReplies(h).length, 3, "no second settlement");
  } finally {
    if (realSet) globalThis.setTimeout = realSet;
    if (realClear) globalThis.clearTimeout = realClear;
    timers.reset();
    h.done();
  }
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
    assert.deepEqual(droppedReplies(h), [], "a turn's end drops nothing");
    queuedChat.settleIdle(h.session, false);
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
    queuedChat.settleIdle(h.session, false);
    assert.deepEqual(droppedReplies(h).map(function (m) { return m.messageId; }), [ID_A, ID_B]);
    assert.deepEqual(h.delivered().map(function (m) { return m.messageId; }), [ID_C]);
  } finally { h.done(); }
});

test("the message processor delivers a message named on a frame; the result frame drops nothing, only the idle settle does", function () {
  var processor = processorFor();
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
    assert.deepEqual(events, [["delivered", ID_A]], "named on the result frame: delivered; not named: still waiting");
    assert.equal(queuedChat.has(session, ID_D), true);
    assert.equal(queuedChat.has(session, ID_B), true, "a message never in doubt keeps waiting");
    assert.equal(queuedChat.has(session, ID_C), true);
    queuedChat.settleIdle(session, false);
    assert.deepEqual(events[1], ["dropped", ID_D, "not_taken"], "dropped only by the idle settle");
  });
});

function processorFor() {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor.js");
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null, currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function () {}, sendToSession: function () {}, saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  return attachMessageProcessor({
    sm: sm, send: function () {}, slug: "t", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; }, adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; }, discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; }, mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
}

test("a message cancelled during an already-running turn stays pending through that turn's result, and a later turn delivers it once", async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(false); } });
  try {
    var processor = processorFor();
    h.send({ type: "message", text: "cancelled mid-turn", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.deepEqual(answers(h), ["pending"]);
    processor.processSDKMessage(h.session, { yokeType: "status", status: null }); // the running turn goes on
    processor.processSDKMessage(h.session, { yokeType: "result" }); // and ends without naming the message
    assert.equal(droppedReplies(h).length, 0, "not dropped at that turn's result");
    assert.equal(queuedChat.has(h.session, ID_A), true, "still tracked: the agent runs it as the next turn");
    assert.equal(h.records().length, 0, "not restored, not recorded yet");
    processor.processSDKMessage(h.session, { yokeType: "status", status: null }); // the next turn begins
    processor.processSDKMessage(h.session, { yokeType: "status", status: null, userMessageUuids: [ID_A] });
    assert.equal(h.delivered().length, 1, "delivered by the later turn");
    assert.equal(h.records().length, 1, "in history exactly once");
    processor.processSDKMessage(h.session, { yokeType: "result", userMessageUuids: [ID_A] });
    assert.equal(h.records().length, 1);
    assert.equal(h.delivered().length, 1);
    assert.equal(droppedReplies(h).length, 0);
  } finally { h.done(); }
});

// ------------------------------------------------------------ what happens to queued text
// One test per case: the message is pushed to the agent, not yet taken in, and
//   (a) the daemon restarts, (b) the worker dies, (c) the page reloads with the
//   daemon alive, (d) a rewind replaces the query. In none may the text vanish.

function framesTo(shown, who, type) {
  return shown.filter(function (m) { return m.ws === who && m.obj.type === type; }).map(function (m) { return m.obj; });
}

test("(a) the daemon restarts with chat queued: the next time the session is shown its text comes back, once", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "queued at restart", pastes: ["a paste"], images: [{ mediaType: "image/png", data: "AA==" }], messageId: ID_A });
    var r = h.restart();
    assert.ok(r.session, "the session is read back from its file");
    var tab = { id: "tab" };
    r.sm.switchSession(r.session.localId, tab);
    assert.deepEqual(framesTo(r.shown, tab, "queued_message_cancelled"), [
      { type: "queued_message_cancelled", messageId: ID_A, result: "dropped", cause: "restart", text: "queued at restart", pastes: ["a paste"], imageCount: 1 },
    ]);
    assert.deepEqual(framesTo(r.shown, tab, "queued_message_tracked"), [], "it is not drawn as queued: nothing in this daemon holds it");
    var other = { id: "other tab" };
    r.sm.switchSession(r.session.localId, other);
    assert.deepEqual(framesTo(r.shown, other, "queued_message_cancelled"), [], "handed back once");
    var again = h.restart();
    var third = { id: "after another restart" };
    again.sm.switchSession(again.session.localId, third);
    assert.deepEqual(framesTo(again.shown, third, "queued_message_cancelled"), [], "and not again after the next restart");
  } finally { h.done(); }
});

test("(a) a long queued message comes back whole: it does not break reading the session file back", async function () {
  var h = await harness();
  try {
    var long = "x".repeat(20000);
    h.send({ type: "message", text: long, messageId: ID_A });
    var r = h.restart();
    assert.ok(r.session, "the session still loads");
    var tab = { id: "tab" };
    r.sm.switchSession(r.session.localId, tab);
    assert.equal(framesTo(r.shown, tab, "queued_message_cancelled")[0].text, long);
  } finally { h.done(); }
});

test("(a) a message delivered before the restart is not handed back",async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "taken in", messageId: ID_A });
    queuedChat.consume(h.session, [ID_A]);
    var r = h.restart();
    var tab = { id: "tab" };
    r.sm.switchSession(r.session.localId, tab);
    assert.deepEqual(framesTo(r.shown, tab, "queued_message_cancelled"), []);
  } finally { h.done(); }
});

test("(a) a query that closes with nobody viewing the session keeps the text for the next time it is shown", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "nobody watched", messageId: ID_A });
    queuedChat.dropAll(h.session);
    var tab = { id: "late tab" };
    h.sm.switchSession(h.session.localId, tab);
    assert.deepEqual(framesTo(h.out.toWs, tab, "queued_message_cancelled").map(function (m) { return [m.messageId, m.result, m.cause, m.text]; }),
      [[ID_A, "dropped", "closed", "nobody watched"]]);
    h.sm.switchSession(h.session.localId, { id: "another" });
    assert.equal(h.out.toWs.filter(function (m) { return m.obj.type === "queued_message_cancelled"; }).length, 1, "once");
  } finally { h.done(); }
});

test("(b) the worker dies with chat queued: the stream breaks, the query closes, and the text comes back through the dropped reply", async function () {
  var query = fakeQuery();
  var bridge = null;
  var h = await harness({ pushMessage: function () { return bridge.pushMessage.apply(null, arguments); } });
  try {
    bridge = bridgeFor(h, [query]);
    h.ws._clagenticActiveSession = h.session.localId;
    await bridge.startQuery(h.session, "first", null, null);
    h.session.isProcessing = true;
    h.send({ type: "message", text: "worker will die", messageId: ID_A });
    query.fail(new Error("Worker killed by SIGKILL"));
    await settle();
    assert.deepEqual(droppedReplies(h).map(function (m) { return [m.messageId, m.cause, m.text]; }), [[ID_A, "closed", "worker will die"]]);
    assert.equal(queuedChat.has(h.session, ID_A), false);
  } finally { h.done(); }
});

test("(c) the page reloads while the daemon is alive: the message still waiting is drawn as queued again, and its delivery clears it once", async function () {
  var h = await harness();
  try {
    h.send({ type: "message", text: "still waiting", pastes: ["p"], images: [{ mediaType: "image/png", data: "AA==" }], messageId: ID_A });
    var reloaded = { id: "reloaded page" };
    h.sm.switchSession(h.session.localId, reloaded);
    assert.deepEqual(framesTo(h.out.toWs, reloaded, "queued_message_tracked"), [
      { type: "queued_message_tracked", messageId: ID_A, text: "still waiting", pastes: ["p"], imageCount: 1, unconfirmed: false },
    ]);
    assert.equal(queuedChat.has(h.session, ID_A), true, "the server still tracks it");
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.delivered().length, 1, "delivery is announced to the session, the reloaded page included");
    var later = { id: "later" };
    h.sm.switchSession(h.session.localId, later);
    assert.deepEqual(framesTo(h.out.toWs, later, "queued_message_tracked"), [], "a delivered message is not drawn as queued");
  } finally { h.done(); }
});

test("(c) a cancel from the second page replies to it with the text and tells the first page to drop its item, without the text",async function () {
  var h = await harness({ cancelQueuedMessage: function () { return Promise.resolve(true); } });
  try {
    h.send({ type: "message", text: "withdraw me", messageId: ID_A });
    var tab = { id: "second tab" };
    h.clients.add(tab);
    h.sendFrom(tab, { type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.deepEqual(h.out.toSender.filter(function (m) { return m.type === "queued_message_cancelled"; }).map(function (m) { return [m.result, m.text]; }), [["cancelled", "withdraw me"]]);
    assert.deepEqual(h.out.toOthers.filter(function (m) { return m.type === "queued_message_cancelled"; }),
      [{ type: "queued_message_cancelled", messageId: ID_A, result: "cancelled" }], "the other page drops its item; no text, so nothing lands in its composer");
  } finally { h.done(); }
});

test("(d) a rewind replaces the query with chat queued on the old one: the old entry is dropped with its text, the new query's stays queued", async function () {
  var a = fakeQuery();
  var b = fakeQuery();
  var bridge = null;
  var h = await harness({ pushMessage: function () { return bridge.pushMessage.apply(null, arguments); } });
  try {
    bridge = bridgeFor(h, [a, b]);
    h.ws._clagenticActiveSession = h.session.localId;
    await bridge.startQuery(h.session, "first", null, null);
    h.session.isProcessing = true;
    h.send({ type: "message", text: "queued on the old query", messageId: ID_A });
    assert.deepEqual(a.pushed.slice(-1), [ID_A]);

    // rewind_execute: the old query is aborted and unlinked from the session, then a
    // message starts a new one while the old stream is still unwinding.
    h.session.queryInstance = null;
    h.session.isProcessing = false;
    await bridge.startQuery(h.session, "after the rewind", null, null);
    h.session.isProcessing = true;
    h.send({ type: "message", text: "queued on the new query", messageId: ID_B });
    assert.deepEqual(b.pushed.slice(-1), [ID_B]);

    a.finish();
    await settle();
    assert.deepEqual(droppedReplies(h).map(function (m) { return [m.messageId, m.cause, m.text]; }), [[ID_A, "closed", "queued on the old query"]],
      "the old query's message is no longer drawn as queued: its text goes back");
    assert.equal(queuedChat.has(h.session, ID_A), false);
    assert.equal(queuedChat.has(h.session, ID_B), true, "the live query's message is left alone");
    b.finish();
    await settle();
  } finally { h.done(); }
});

// ------------------------------------------------------------ Send now: interrupt and send
// Send now on a message already with the agent interrupts the running turn with the
// agent's queue kept (Query.interrupt(), never cancel_queued, never a re-push) and
// reads the receipt. A hit keeps the message tracked as send-now; a miss hands its
// text back and never pushes it again.

function sendNowReplies(h) { return h.out.toSender.filter(function (m) { return m.type === "queued_message_send_now"; }); }

test("Send now on a queued message: one interrupt per path, the receipt decides, the text reaches the agent at most once", async function () {
  var rows = [
    { name: "receipt hit: marked send-now, still delivered once", receipt: { stillQueued: [ID_A] }, result: "requested", interrupts: 1, tracked: true },
    { name: "no receipt (older CLI): cannot say, stays marked and tracked", receipt: { stillQueued: null }, result: "requested", interrupts: 1, tracked: true },
    { name: "receipt miss: ended, text handed back with a cause, never re-pushed", receipt: { stillQueued: [ID_B] }, result: "missed", interrupts: 1, tracked: false, dropped: true },
    { name: "already delivered: no interrupt", before: function (h) { queuedChat.consume(h.session, [ID_A]); }, receipt: { stillQueued: [] }, result: "already_delivered", interrupts: 0, tracked: false },
    { name: "untracked id: no interrupt", id: ID_C, receipt: { stillQueued: [] }, result: "already_delivered", interrupts: 0, tracked: true },
    { name: "no turn running: no interrupt, truthful no-op", before: function (h) { h.session.isProcessing = false; }, receipt: { stillQueued: [] }, result: "no_turn", interrupts: 0, tracked: true },
    { name: "double frame: one interrupt", twice: true, receipt: { stillQueued: [ID_A] }, result: "requested", interrupts: 1, tracked: true },
    {
      name: "pushed into an older query that was replaced: no interrupt of the live query, truthful no-op",
      setup: function (h) { h.session.queryInstance = { name: "query A" }; },
      before: function (h) { h.session.queryInstance = { name: "query B" }; },
      receipt: { stillQueued: [ID_A] }, result: "no_turn", interrupts: 0, tracked: true,
    },
    { name: "agent cannot interrupt: unsupported, nothing interrupted", unsupported: true, result: "unsupported", interrupts: 0, tracked: false, pushed: 0, delivered: 0 },
    {
      name: "failed interrupt: error, left queued and unmarked, and can be asked again",
      interrupt: function (n) { return n === 1 ? Promise.reject(new Error("worker gone")) : Promise.resolve({ stillQueued: [ID_A] }); },
      result: "error", interrupts: 1, tracked: true, unmarked: true,
      again: { result: "requested", interrupts: 2 },
    },
  ];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var interrupts = 0;
    var h = await harness(Object.assign({
      interruptKeepingQueued: function () { interrupts++; return row.interrupt ? row.interrupt(interrupts) : Promise.resolve(row.receipt); },
    }, row.unsupported ? { canCancelQueued: function () { return false; } } : {}));
    try {
      if (row.setup) row.setup(h);
      if (!row.unsupported) h.send({ type: "message", text: "row " + i, messageId: ID_A });
      if (row.before) row.before(h);
      var id = row.id || ID_A;
      h.send({ type: "send_now_queued_message", messageId: id });
      if (row.twice) h.send({ type: "send_now_queued_message", messageId: id });
      await settle();
      assert.deepEqual(sendNowReplies(h).map(function (r) { return r.result; }), row.twice ? [row.result, row.result] : [row.result], row.name + ": reply");
      assert.equal(interrupts, row.interrupts, row.name + ": interrupt() calls");
      assert.equal(h.out.cancelled.length, 0, row.name + ": the agent's queue is kept: no cancel");
      assert.equal(h.out.pushed.length, row.pushed === undefined ? 1 : row.pushed, row.name + ": pushed once, never again");
      assert.equal(queuedChat.has(h.session, ID_A), row.tracked, row.name + ": tracked");
      assert.equal(droppedReplies(h).length, row.dropped ? 1 : 0, row.name + ": dropped replies");
      if (row.dropped) {
        assert.deepEqual(droppedReplies(h)[0], { type: "queued_message_cancelled", messageId: ID_A, result: "dropped", cause: "send_now_missed", text: "row " + i, pastes: [], imageCount: 0 });
      }
      if (row.unmarked) {
        assert.equal(queuedChat.pending(h.session)[0].sendNow, undefined, row.name + ": not marked");
        h.send({ type: "send_now_queued_message", messageId: id });
        await settle();
        assert.equal(sendNowReplies(h)[1].result, row.again.result, row.name + ": asked again");
        assert.equal(interrupts, row.again.interrupts, row.name + ": interrupt() calls after asking again");
      }
      // A miss can still be followed by the agent reporting the message consumed (the
      // receipt raced the SDK taking it into the interrupted turn): it ran, so it is
      // reported once; a second report changes nothing.
      queuedChat.consume(h.session, [ID_A]);
      queuedChat.consume(h.session, [ID_A]);
      var once = row.delivered === undefined ? 1 : row.delivered;
      assert.equal(h.delivered().length, once, row.name + ": delivered at most once");
      assert.equal(h.records().length, once, row.name + ": recorded at most once");
    } finally { h.done(); }
  }
});

test("Send now: a hit tells the other pages, and a frame in flight is one interrupt answered alike", async function () {
  var release;
  var calls = 0;
  var h = await harness({ interruptKeepingQueued: function () { calls++; return new Promise(function (resolve) { release = resolve; }); } });
  try {
    h.send({ type: "message", text: "in flight", messageId: ID_A });
    h.send({ type: "send_now_queued_message", messageId: ID_A });
    h.send({ type: "send_now_queued_message", messageId: ID_A });
    await tick();
    assert.equal(queuedChat.pending(h.session)[0].sendNow, true, "marked as soon as asked: a page shown now draws it as sending");
    release({ stillQueued: [ID_A] });
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(sendNowReplies(h).map(function (r) { return r.result; }), ["requested", "requested"]);
    var told = h.out.toOthers.filter(function (m) { return m.type === "queued_message_send_now"; });
    assert.ok(told.length >= 1, "the other pages are told");
    told.forEach(function (m) { assert.deepEqual(m, { type: "queued_message_send_now", messageId: ID_A, result: "requested" }, "the same idempotent frame each time"); });
  } finally { h.done(); }
});

test("Send now: delivery that lands before the receipt wins, whatever the receipt says; nothing is handed back", async function () {
  var release;
  var h = await harness({ interruptKeepingQueued: function () { return new Promise(function (resolve) { release = resolve; }); } });
  try {
    h.send({ type: "message", text: "photo finish", messageId: ID_A });
    h.send({ type: "send_now_queued_message", messageId: ID_A });
    await tick();
    queuedChat.consume(h.session, [ID_A]);
    release({ stillQueued: [] });
    await settle();
    assert.deepEqual(sendNowReplies(h).map(function (r) { return r.result; }), ["already_delivered"]);
    assert.equal(droppedReplies(h).length, 0);
    assert.equal(h.delivered().length, 1);
    assert.equal(h.records().length, 1);
  } finally { h.done(); }
});

test("Send now: a page shown after the press (a switch back, a reload) is told sendNow, never a plain queued item", async function () {
  var h = await harness({ interruptKeepingQueued: function () { return Promise.resolve({ stillQueued: [ID_A] }); } });
  try {
    h.send({ type: "message", text: "keep me sending", messageId: ID_A });
    var before = { id: "before" };
    h.sm.switchSession(h.session.localId, before);
    assert.equal(framesTo(h.out.toWs, before, "queued_message_tracked")[0].sendNow, undefined, "not pressed yet: queued");
    h.send({ type: "send_now_queued_message", messageId: ID_A });
    await settle();
    var back = { id: "back" };
    h.sm.switchSession(h.session.localId, back);
    assert.deepEqual(framesTo(h.out.toWs, back, "queued_message_tracked"), [
      { type: "queued_message_tracked", messageId: ID_A, text: "keep me sending", pastes: [], imageCount: 0, unconfirmed: false, sendNow: true },
    ]);
    queuedChat.consume(h.session, [ID_A]);
    var later = { id: "later" };
    h.sm.switchSession(h.session.localId, later);
    assert.deepEqual(framesTo(h.out.toWs, later, "queued_message_tracked"), [], "delivered: no longer drawn");
  } finally { h.done(); }
});

test("Send now: the idle grace does not hand back a message the receipt says is still queued, and still settles one it does not cover", async function () {
  var h = await harness({
    cancelQueuedMessage: function () { return Promise.resolve(false); },
    interruptKeepingQueued: function () { return Promise.resolve({ stillQueued: [ID_A] }); },
  });
  try {
    h.send({ type: "message", text: "marked", messageId: ID_A });
    h.send({ type: "message", text: "plain", messageId: ID_B });
    h.send({ type: "cancel_queued_message", messageId: ID_A });
    h.send({ type: "cancel_queued_message", messageId: ID_B });
    await settle();
    assert.equal(queuedChat.hasUnconfirmed(h.session), true);
    h.send({ type: "send_now_queued_message", messageId: ID_A });
    await settle();
    assert.deepEqual(queuedChat.settleIdle(h.session, false), [ID_B], "only the message Send now was not pressed on is settled");
    assert.equal(queuedChat.has(h.session, ID_A), true, "it is still tracked and still ends delivered");
    assert.equal(queuedChat.hasUnconfirmed(h.session), false);
    queuedChat.consume(h.session, [ID_A]);
    assert.equal(h.delivered().length, 1);
  } finally { h.done(); }
});

test("Send now: the Claude handles interrupt through Query.interrupt() with the queue kept and read the receipt", async function () {
  var calls = [];
  var queue = { push: function () {}, end: function () {} };
  var handle = claudeAdapter._test_createQueryHandle({
    interrupt: function () { calls.push(arguments.length); return Promise.resolve({ still_queued: [ID_A, 7] }); },
  }, queue, null);
  assert.deepEqual(await handle.interruptKeepingQueued(), { stillQueued: [ID_A] });
  assert.deepEqual(calls, [0], "called with no options: cancelQueued is never set");
  var older = claudeAdapter._test_createQueryHandle({ interrupt: function () { return Promise.resolve(undefined); } }, queue, null);
  assert.deepEqual(await older.interruptKeepingQueued(), { stillQueued: null }, "no receipt");
  await assert.rejects(claudeAdapter._test_createQueryHandle({}, queue, null).interruptKeepingQueued(), /cannot interrupt/);

  var worker = { sent: [], handler: null, process: null, exitPromise: null };
  worker.onMessage = function (fn) { worker.handler = fn; };
  worker.send = function (msg) { worker.sent.push(msg); };
  var viaWorker = claudeAdapter._test_createWorkerQueryHandle(worker, null, null, null);
  var hit = viaWorker.interruptKeepingQueued();
  var failing = viaWorker.interruptKeepingQueued();
  var asks = worker.sent.filter(function (m) { return m.type === "interrupt_query"; });
  assert.equal(asks.length, 2);
  worker.handler({ type: "interrupt_response", requestId: asks[0].requestId, receipt: { still_queued: [ID_B] } });
  worker.handler({ type: "interrupt_response", requestId: asks[1].requestId, error: "no such query" });
  assert.deepEqual(await hit, { stillQueued: [ID_B] });
  await assert.rejects(failing, /no such query/);
  var pending = viaWorker.interruptKeepingQueued();
  worker.handler({ type: "query_done" });
  await assert.rejects(pending, /query ended/);
});

test("Send now uses neither the undocumented priority field nor a cancel-and-re-push", function () {
  var root = path.join(__dirname, "..", "lib");
  ["project-user-message.js", "queued-chat.js", "sdk-bridge.js", path.join("yoke", "adapters", "claude.js"), path.join("yoke", "adapters", "claude-worker.js")].forEach(function (file) {
    var src = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(/priority\s*:\s*["']now["']/.test(src), false, file + ": no SDKUserMessage.priority");
    assert.equal(/cancelQueued\s*:\s*true|cancel_queued\s*:\s*true/.test(src), false, file + ": the interrupt never cancels queued input");
  });
});

test("two tabs on one session and a dropped reply: the text is sent to the session once and never pushed to the agent again", async function () {
  var h = await harness();
  try {
    var tab = { id: "second tab" };
    h.ws._clagenticActiveSession = h.session.localId;
    tab._clagenticActiveSession = h.session.localId;
    h.clients.add(tab);
    h.send({ type: "message", text: "in two composers at most", messageId: ID_A });
    queuedChat.dropAll(h.session);
    assert.equal(droppedReplies(h).length, 1, "one reply for the session: each tab hands it to its own composer, never to the agent");
    assert.equal(h.out.pushed.length, 1, "only the original push ever reached the agent");
    h.sendFrom(tab, { type: "cancel_queued_message", messageId: ID_A });
    await tick(); await tick();
    assert.deepEqual(h.replies().map(function (r) { return r.result; }), ["already_delivered"], "the second tab cannot withdraw or restore it again");
    assert.equal(queuedChat.dropAll(h.session).length, 0);
    assert.equal(h.out.pushed.length, 1);
    var restarted = h.restart();
    var viewer = { id: "after" };
    restarted.sm.switchSession(restarted.session.localId, viewer);
    assert.deepEqual(framesTo(restarted.shown, viewer, "queued_message_cancelled"), [], "a viewer saw the reply, so nothing is kept to hand back later");
  } finally { h.done(); }
});
