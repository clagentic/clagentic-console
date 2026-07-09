// Regression tests for lr-f7a4 — Codex tool approvals must respect the
// configured approval policy instead of silently auto-approving every
// command. Exercises the real createCodexQueryHandle (exported as
// _test_createCodexQueryHandle) against a fake app-server, so reverting the
// approval-routing fix in lib/yoke/adapters/codex.js breaks these tests.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

// Minimal fake app-server: only implements what createCodexQueryHandle's
// runQueryLoop / handleServerEvent actually call (addEventHandler,
// updateHandlerThreadId, removeEventHandler, send, respond).
function buildFakeAppServer() {
  var handlers = [];
  var respondCalls = [];
  var sentMethods = [];

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
    respond: function (id, result) {
      respondCalls.push({ id: id, result: result });
    },
    send: function (method, params) {
      sentMethods.push({ method: method, params: params });
      if (method === "thread/start") {
        // Synchronously "start" the thread and hand back a threadId.
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      if (method === "turn/start") {
        // Deliver a command-execution approval request on the next tick,
        // then complete the turn once the approval branch has resolved.
        setImmediate(function () {
          dispatch({
            method: "item/commandExecution/requestApproval",
            id: "req-1",
            params: { itemId: "item-1", command: "rm -rf /tmp/whatever" },
          });
        });
        return Promise.resolve({});
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
    dispatch: dispatch,
    respondCalls: respondCalls,
    sentMethods: sentMethods,
  };
}

function waitForRespond(fake, count) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 2000;
    (function poll() {
      if (fake.respondCalls.length >= count) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for respond() call"));
      setImmediate(poll);
    })();
  });
}

test("lr-f7a4: a non-'never' approval policy routes a command through canUseTool (not silent allow)", async function () {
  var fake = buildFakeAppServer();
  var canUseToolCalls = [];

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    canUseTool: function (toolName, input) {
      canUseToolCalls.push({ toolName: toolName, input: input });
      return Promise.resolve({ behavior: "allow" });
    },
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.equal(canUseToolCalls.length, 1, "canUseTool must be invoked for the approval request");
  assert.equal(canUseToolCalls[0].toolName, "Bash");
  assert.equal(canUseToolCalls[0].input.command, "rm -rf /tmp/whatever");
  assert.deepEqual(fake.respondCalls[0].result, { decision: "accept" });

  handle.close();
});

test("lr-f7a4: canUseTool denial is honored — the command is declined, not silently allowed", async function () {
  var fake = buildFakeAppServer();

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    canUseTool: function () {
      return Promise.resolve({ behavior: "deny" });
    },
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.deepEqual(fake.respondCalls[0].result, { decision: "decline" });

  handle.close();
});

test("lr-f7a4: setToolPolicy('allow-all') takes live effect — bypasses canUseTool for the next approval", async function () {
  var fake = buildFakeAppServer();
  var canUseToolCalls = [];

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    canUseTool: function (toolName, input) {
      canUseToolCalls.push({ toolName: toolName, input: input });
      return Promise.resolve({ behavior: "deny" });
    },
  });

  await handle.setToolPolicy("allow-all");

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.equal(canUseToolCalls.length, 0, "canUseTool must be bypassed once allow-all is set");
  assert.deepEqual(fake.respondCalls[0].result, { decision: "accept" });

  handle.close();
});

test("lr-f7a4: queryOpts.toolPolicy === 'allow-all' seeds the same live bypass at creation time", async function () {
  var fake = buildFakeAppServer();
  var canUseToolCalls = [];

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "never",
    toolPolicy: "allow-all",
    canUseTool: function (toolName, input) {
      canUseToolCalls.push({ toolName: toolName, input: input });
      return Promise.resolve({ behavior: "deny" });
    },
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.equal(canUseToolCalls.length, 0);
  assert.deepEqual(fake.respondCalls[0].result, { decision: "accept" });

  handle.close();
});
