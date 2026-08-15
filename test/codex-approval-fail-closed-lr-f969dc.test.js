// Regression tests for lr-f969dc (fold-in) — BOBBIE's open nit on lr-4a13c3:
// the new Codex $skill-name approval gate fails CLOSED when canUseTool is
// unwired (e.g. a warmup/init query), but the three PRE-EXISTING approval
// sites in this same file — command execution, file change, and MCP
// elicitation — silently auto-accepted (fail OPEN) in the exact same
// situation. That inconsistency meant a query created without a canUseTool
// callback wired could execute an arbitrary shell command or apply an
// arbitrary file change with zero operator sign-off, while the newer Skill
// gate correctly refused to inject anything.
//
// Fix: all three older sites now respond "decline" (command/file) or
// "decline" (MCP action) when no canUseTool callback is wired, matching the
// Skill injection gate's fail-closed behavior exactly.
//
// Drives the real createCodexQueryHandle / handleServerEvent path against a
// fake app-server (same harness pattern as
// test/codex-approval-routing-lr-f7a4.test.js), asserting on the actual
// respond() call — not on source-text greps.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

// Minimal fake app-server: only implements what createCodexQueryHandle's
// runQueryLoop / handleServerEvent actually call.
function buildFakeAppServer(approvalEvent) {
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
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      if (method === "turn/start") {
        setImmediate(function () {
          dispatch(approvalEvent);
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

test("lr-f969dc: command execution approval fails CLOSED when no canUseTool is wired", async function () {
  var fake = buildFakeAppServer({
    method: "item/commandExecution/requestApproval",
    id: "req-1",
    params: { itemId: "item-1", command: "rm -rf /tmp/whatever" },
  });

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    // canUseTool intentionally omitted.
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.deepEqual(fake.respondCalls[0].result, { decision: "decline" },
    "an unreviewed command must never be silently executed when no approval callback is wired");

  handle.close();
});

test("lr-f969dc: file change approval fails CLOSED when no canUseTool is wired", async function () {
  var fake = buildFakeAppServer({
    method: "item/fileChange/requestApproval",
    id: "req-2",
    params: { changes: [{ kind: "modify", path: "/tmp/whatever.txt" }], path: "/tmp/whatever.txt" },
  });

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    // canUseTool intentionally omitted.
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.deepEqual(fake.respondCalls[0].result, { decision: "decline" },
    "an unreviewed file change must never be silently applied when no approval callback is wired");

  handle.close();
});

test("lr-f969dc: MCP elicitation/tool approval fails CLOSED when neither onElicitation nor canUseTool is wired", async function () {
  var fake = buildFakeAppServer({
    method: "mcpServer/elicitation/request",
    id: "req-3",
    params: { serverName: "some-server", _meta: { tool: "some-tool" } },
  });

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    // canUseTool and onElicitation both intentionally omitted.
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.deepEqual(fake.respondCalls[0].result, { action: "decline" },
    "an unreviewed MCP tool call must never be silently accepted when no approval callback is wired");

  handle.close();
});

test("lr-f969dc: command execution still auto-accepts under allow-all even with no canUseTool wired (unaffected by the fail-closed fix)", async function () {
  var fake = buildFakeAppServer({
    method: "item/commandExecution/requestApproval",
    id: "req-4",
    params: { itemId: "item-4", command: "echo hi" },
  });

  var handle = createCodexQueryHandle(fake.appServer, {
    approvalPolicy: "on-request",
    toolPolicy: "allow-all",
    // canUseTool intentionally omitted — allow-all must still bypass the gate.
  });

  handle.pushMessage("do something");
  await waitForRespond(fake, 1);

  assert.deepEqual(fake.respondCalls[0].result, { decision: "accept" },
    "allow-all must still bypass the approval gate regardless of canUseTool wiring");

  handle.close();
});

test("lr-f969dc: command execution still routes through a wired canUseTool normally (unaffected by the fail-closed fix)", async function () {
  var fake = buildFakeAppServer({
    method: "item/commandExecution/requestApproval",
    id: "req-5",
    params: { itemId: "item-5", command: "echo hi" },
  });

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

  assert.equal(canUseToolCalls.length, 1);
  assert.deepEqual(fake.respondCalls[0].result, { decision: "accept" });

  handle.close();
});
