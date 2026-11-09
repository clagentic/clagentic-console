"use strict";
// Send now, server side: the Codex adapter steers a running turn through
// turn/steer and queues the message when the steer cannot land; the steering
// capability follows what the running app-server answers; Claude's capability
// is backed by the installed SDK's documented behaviour.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");
var { codexCapabilities } = require("../lib/yoke/adapters/codex-capabilities");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var { resolveCapabilities } = require("../lib/yoke/capabilities");

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

// A fake app-server whose turn/start never completes on its own, so the turn
// stays running until the test ends it.
function rpcError(message, code) {
  var e = new Error(message);
  e.rpcCode = code;
  return e;
}

function runningTurn(steerBehavior) {
  var handlers = [];
  var fake = { calls: [] };
  fake.dispatch = function (msg) {
    handlers.forEach(function (h) { if (h.threadId === null || h.threadId === "thread-1") h.fn(msg); });
  };
  fake.appServer = {
    started: true,
    addEventHandler: function (fn, threadId) { var e = { fn: fn, threadId: threadId || null }; handlers.push(e); return e; },
    removeEventHandler: function (e) { handlers = handlers.filter(function (h) { return h !== e; }); },
    updateHandlerThreadId: function (e, threadId) { e.threadId = threadId || null; },
    respond: function () {},
    send: function (method, params) {
      fake.calls.push({ method: method, params: params });
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        setImmediate(function () { fake.dispatch({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-7" } } }); });
        return Promise.resolve({});
      }
      if (method === "turn/steer") return steerBehavior ? steerBehavior(params) : Promise.resolve({ turnId: "turn-7" });
      return Promise.resolve({});
    },
  };
  return fake;
}

async function startTurn(fake) {
  var handle = codexAdapter._test_createCodexQueryHandle(fake.appServer, { approvalPolicy: "on-request" });
  handle.pushMessage("first", null, "human", "m1");
  for (var i = 0; i < 100 && !fake.calls.some(function (c) { return c.method === "turn/start"; }); i++) await tick();
  await tick(); await tick();
  return handle;
}

test("Codex: a steered message goes to turn/steer with the running turn id", async function () {
  var fake = runningTurn();
  var handle = await startTurn(fake);
  var result = await handle.steerMessage("go left", null, "human", "m2");
  assert.deepEqual(result, { steered: true });
  var steer = fake.calls.filter(function (c) { return c.method === "turn/steer"; })[0];
  assert.equal(steer.params.expectedTurnId, "turn-7");
  assert.equal(steer.params.threadId, "thread-1");
  assert.deepEqual(steer.params.input, [{ type: "text", text: "go left" }]);
  handle.close();
});

test("Codex: a steer that races the end of the turn is queued for the next turn, not dropped", async function () {
  var fake = runningTurn(function () { return Promise.reject(rpcError("expected turn id does not match the active turn", -32600)); });
  var handle = await startTurn(fake);
  var result = await handle.steerMessage("late", null, "human", "m3");
  assert.equal(result.steered, false);
  assert.equal(result.reason, "turn-ended");
  // The turn then completes: the queued message must start the next turn.
  fake.dispatch({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-7", status: "completed" } } });
  for (var i = 0; i < 100 && fake.calls.filter(function (c) { return c.method === "turn/start"; }).length < 2; i++) await tick();
  var starts = fake.calls.filter(function (c) { return c.method === "turn/start"; });
  assert.equal(starts.length, 2, "the queued message started a second turn");
  assert.deepEqual(starts[1].params.input, [{ type: "text", text: "late" }]);
  handle.close();
});

// Drives one send-now message through the real user-message handler with a
// steer outcome and returns what was recorded, persisted and broadcast.
async function sendNowOutcome(steerResult) {
  var os = require("os");
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "send-now-fallback-"));
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  try {
    var noop = function () {};
    var sm = require("../lib/sessions").createSessionManager({ cwd: tmpHome, send: noop, sendTo: noop, sendEach: noop });
    var session = sm.createSessionRaw({});
    session.cliSessionId = "send-now-fallback-1";
    session.vendor = "codex";
    session.title = "t";
    session.isProcessing = true;
    sm.saveSessionFile(session);
    var sent = [];
    var sdk = {
      canSteer: function () { return true; },
      steerMessage: function () { return Promise.resolve(steerResult); },
      pushMessage: noop,
    };
    var handler = require("../lib/project-user-message").attachUserMessage({
      cwd: tmpHome, slug: "p", osUsers: false, sm: sm, sdk: sdk, nm: {}, tm: {},
      send: noop, sendTo: noop, sendToSession: function (id, obj) { sent.push(obj); }, sendToSessionOthers: noop, clients: new Set(),
      opts: {}, usersModule: {},
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
    handler.handleUserMessage({}, { type: "message", text: "late one", sendNow: true });
    await tick();
    await tick();
    sm.saveSessionFile(session);
    var found = null;
    var base = path.join(tmpHome, "console", "sessions");
    fs.readdirSync(base).forEach(function (d) {
      var f = path.join(base, d, "send-now-fallback-1.jsonl");
      if (fs.existsSync(f)) found = f;
    });
    var lines = fs.readFileSync(found, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    return {
      sent: sent,
      memory: session.history.filter(function (h) { return h.type === "user_message"; }),
      persisted: lines.filter(function (l) { return l.type === "user_message"; }),
    };
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origHome;
    ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

test("send-now: a steer that lands is recorded once, marked mid-turn", async function () {
  var out = await sendNowOutcome({ steered: true });
  assert.equal(out.memory.length, 1);
  assert.equal(out.persisted.length, 1);
  assert.equal(out.memory[0].sentMidTurn, true);
  assert.equal(out.persisted[0].sentMidTurn, true);
});

test("send-now: a fallback to the queue produces exactly one unmarked record and no clear message", async function () {
  var out = await sendNowOutcome({ steered: false, reason: "turn-ended" });
  assert.equal(out.memory.length, 1);
  assert.equal(out.persisted.length, 1);
  assert.ok(!out.memory[0].sentMidTurn && !out.persisted[0].sentMidTurn, "never marked");
  assert.ok(!out.sent.some(function (m) { return m.type === "sent_mid_turn_cleared"; }));
  assert.ok(out.sent.some(function (m) { return m.type === "diagnostic" && m.source === "send-now"; }), "the user gets the notice");
});

test("send-now: an unconfirmed delivery is recorded once, unmarked, with a notice that it is unconfirmed", async function () {
  var out = await sendNowOutcome({ steered: false, reason: "unconfirmed" });
  assert.equal(out.persisted.length, 1);
  assert.ok(!out.persisted[0].sentMidTurn);
  var notice = out.sent.filter(function (m) { return m.type === "diagnostic" && m.source === "send-now"; });
  assert.equal(notice.length, 1);
  assert.match(notice[0].message, /could not confirm/);
});

test("Codex: a transport timeout on turn/steer is not requeued and resolves unconfirmed", async function () {
  var fake = runningTurn(function () { return Promise.reject(new Error("Request timeout: turn/steer (id=9)")); });
  var handle = await startTurn(fake);
  var result = await handle.steerMessage("maybe", null, "human", "m5");
  assert.equal(result.steered, false);
  assert.equal(result.reason, "unconfirmed");
  fake.dispatch({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-7", status: "completed" } } });
  for (var i = 0; i < 20; i++) await tick();
  assert.equal(fake.calls.filter(function (c) { return c.method === "turn/start"; }).length, 1, "no second turn was started for it");
  handle.close();
});

test("Codex: with no running turn a steer is queued like a normal send", async function () {
  var fake = runningTurn();
  var handle = await startTurn(fake);
  fake.dispatch({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-7", status: "completed" } } });
  await tick();
  var result = await handle.steerMessage("after", null, "human", "m4");
  assert.equal(result.steered, false);
  assert.equal(fake.calls.filter(function (c) { return c.method === "turn/steer"; }).length, 0);
  handle.close();
});

test("Codex: the probe turns steering on from the app-server's answer, never from a version", async function () {
  var has = { send: function () { return Promise.reject(rpcError("thread not found: 0000", -32600)); } };
  var lacks = { send: function () { return Promise.reject(rpcError("Method not found", -32601)); } };
  var dead = { send: function () { return Promise.reject(new Error("Process exited: code=1")); } };
  assert.equal(await codexAdapter._test_probeTurnSteer(has), true);
  assert.equal(await codexAdapter._test_probeTurnSteer(lacks), false);
  assert.equal(await codexAdapter._test_probeTurnSteer(dead), false, "an inconclusive probe leaves steering off");
});

test("Codex: an advertised steering of false narrows the declaration to off", function () {
  assert.equal(codexCapabilities().steering, true);
  var off = resolveCapabilities({ capabilities: codexCapabilities() }, null, Object.assign(codexCapabilities(), { steering: false }));
  assert.equal(off.steering, false);
  var on = resolveCapabilities({ capabilities: codexCapabilities() }, null, codexCapabilities());
  assert.equal(on.steering, true);
});

// AC4 evidence: the installed SDK documents that a user message sent while a
// turn runs is folded into that running turn between tool rounds, and the
// Claude handle writes the message into the live input stream with nothing
// that waits for the turn to end.
test("Claude: steering is declared on only because the SDK documents a mid-turn fold", function () {
  var dts = fs.readFileSync(path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"), "utf8");
  assert.match(dts, /queued user message folded into the running turn between tool rounds/);
  assert.match(dts, /still_queued/);
  assert.equal(claudeCapabilities().steering, true);
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "yoke", "adapters", "claude.js"), "utf8");
  assert.match(src, /pushMessage: function\(text, images, initiator, messageId\) \{\s*messageQueue\.push\(/);
});

test("Claude: an agent whose declaration turns steering off stays off", function () {
  var decl = Object.assign(claudeCapabilities(), { steering: false });
  assert.equal(resolveCapabilities({ capabilities: decl }, null, null).steering, false);
});
