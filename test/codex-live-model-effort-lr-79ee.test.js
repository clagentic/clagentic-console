// Regression tests for lr-79ee — the Codex model/effort pickers were silent
// no-ops for an active session: handle.setModel()/setEffort() returned
// resolved promises without changing anything, so the picker lied about
// taking effect. Exercises the real createCodexQueryHandle (exported as
// _test_createCodexQueryHandle) against a fake app-server, so reverting the
// live-switch fix in lib/yoke/adapters/codex.js breaks these tests.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

// Minimal fake app-server: only implements what createCodexQueryHandle's
// runQueryLoop actually calls (addEventHandler, updateHandlerThreadId,
// removeEventHandler, send). Every turn/start completes immediately by
// emitting turn/completed on the next tick, so pushMessage() can be awaited
// via waitForTurnCount() below.
function buildFakeAppServer() {
  var handlers = [];
  var sentMethods = [];
  var turnCompletedCount = 0;

  var appServer = {
    started: true,
    addEventHandler: function (fn, threadId) {
      var entry = { fn: fn, threadId: threadId || null };
      handlers.push(entry);
      return entry;
    },
    removeEventHandler: function (entry) {
      handlers = handlers.filter(function (h) { return h !== entry; });
    },
    updateHandlerThreadId: function (entry, threadId) {
      entry.threadId = threadId || null;
    },
    respond: function () {},
    send: function (method, params) {
      sentMethods.push({ method: method, params: params });
      if (method === "thread/start") {
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      if (method === "turn/start") {
        setImmediate(function () {
          dispatch({ method: "turn/started", params: {} });
          dispatch({ method: "turn/completed", params: { usage: null } });
          turnCompletedCount++;
        });
        return Promise.resolve({ turn: { id: "turn-" + turnCompletedCount } });
      }
      return Promise.resolve({});
    },
  };

  function dispatch(msg) {
    handlers.forEach(function (h) {
      if (h.threadId === null || h.threadId === "test-thread-1") h.fn(msg);
    });
  }

  return {
    appServer: appServer,
    sentMethods: sentMethods,
    getTurnCompletedCount: function () { return turnCompletedCount; },
  };
}

function waitForTurnStartCount(fake, count) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 2000;
    (function poll() {
      var turnStarts = fake.sentMethods.filter(function (m) { return m.method === "turn/start"; });
      if (turnStarts.length >= count) return resolve(turnStarts);
      if (Date.now() > deadline) return reject(new Error("timed out waiting for turn/start calls"));
      setImmediate(poll);
    })();
  });
}

test("lr-79ee: setModel() before the first turn is sent as the turn/start model", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.4" });

  await handle.setModel("gpt-5.2");
  handle.pushMessage("hello");

  var turnStarts = await waitForTurnStartCount(fake, 1);
  assert.equal(turnStarts[0].params.model, "gpt-5.2", "turn/start must carry the live-switched model, not the thread-creation model");

  handle.close();
});

test("lr-79ee: setModel() mid-session takes effect on the NEXT turn of the SAME thread — no new thread is created", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.4" });

  handle.pushMessage("first turn");
  var firstTurnStarts = await waitForTurnStartCount(fake, 1);
  assert.equal(firstTurnStarts[0].params.model, "gpt-5.4");

  await handle.setModel("gpt-5.2");
  handle.pushMessage("second turn");
  var secondTurnStarts = await waitForTurnStartCount(fake, 2);
  assert.equal(secondTurnStarts[1].params.model, "gpt-5.2", "the second turn/start must use the newly selected model");

  var threadStarts = fake.sentMethods.filter(function (m) { return m.method === "thread/start"; });
  var threadResumes = fake.sentMethods.filter(function (m) { return m.method === "thread/resume"; });
  assert.equal(threadStarts.length, 1, "only one thread/start should ever be sent");
  assert.equal(threadResumes.length, 0, "switching model must not trigger a thread/resume — it's a same-thread, per-turn override");

  handle.close();
});

test("lr-79ee: setEffort() mid-session is sent as turn/start effort on the next turn", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.4" });

  handle.pushMessage("first turn");
  var firstTurnStarts = await waitForTurnStartCount(fake, 1);
  assert.equal(firstTurnStarts[0].params.effort, undefined, "no effort override until setEffort() is called");

  await handle.setEffort("high");
  handle.pushMessage("second turn");
  var secondTurnStarts = await waitForTurnStartCount(fake, 2);
  assert.equal(secondTurnStarts[1].params.effort, "high");

  handle.close();
});
