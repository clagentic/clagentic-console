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
  var fake = runningTurn(function () { return Promise.reject(new Error("expected turn id does not match the active turn")); });
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
  var has = { send: function () { return Promise.reject(new Error("thread not found: 0000")); } };
  var lacks = { send: function () { return Promise.reject(new Error("Invalid request: unknown variant `turn/steer`, expected one of `initialize`")); } };
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
