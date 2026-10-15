"use strict";
// The Codex file change approval reaches canUseTool as the Edit tool, so an
// Allow for Session on it grants Edit for the rest of the session.

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var grantKeys = require("../lib/grant-keys");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

function approvalInput(params) {
  var handlers = [];
  var respondCalls = [];
  var appServer = {
    started: true,
    addEventHandler: function (fn, threadId) {
      var entry = { fn: fn, threadId: threadId || null };
      handlers.push(entry);
      return entry;
    },
    removeEventHandler: function (entry) { handlers = handlers.filter(function (h) { return h !== entry; }); },
    updateHandlerThreadId: function (entry, threadId) { entry.threadId = threadId || null; },
    respond: function (id, result) { respondCalls.push({ id: id, result: result }); },
    send: function (method) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "t1" } });
      if (method === "turn/start") {
        setImmediate(function () {
          handlers.forEach(function (h) {
            if (h.threadId === null || h.threadId === "t1") h.fn({ method: "item/fileChange/requestApproval", id: "r1", params: params });
          });
        });
      }
      return Promise.resolve({});
    },
  };
  return new Promise(function (resolve, reject) {
    var seen = null;
    var handle = createCodexQueryHandle(appServer, {
      approvalPolicy: "on-request",
      canUseTool: function (toolName, input) {
        seen = { toolName: toolName, input: input };
        return Promise.resolve({ behavior: "allow" });
      },
    });
    handle.pushMessage("go");
    var deadline = Date.now() + 2000;
    (function poll() {
      if (respondCalls.length) { handle.close(); return resolve(seen); }
      if (Date.now() > deadline) return reject(new Error("no approval answered"));
      setImmediate(poll);
    })();
  });
}

test("a single-file change set is granted as the whole Edit tool", async function () {
  var seen = await approvalInput({ changes: [{ kind: "modify", path: "/work/a.txt" }], path: "/work/a.txt" });
  assert.equal(grantKeys.permissionGrantKey(seen.toolName, seen.input), "Edit");
});

test("a multi-file change set is granted under the same key", async function () {
  var seen = await approvalInput({
    changes: [{ kind: "modify", path: "/work/a.txt" }, { kind: "modify", path: "/work/secret" }],
    path: "/work/a.txt",
  });
  assert.equal(grantKeys.permissionGrantKey(seen.toolName, seen.input), "Edit");
});

test("the approval carries the change summary and no path to key on", async function () {
  var seen = await approvalInput({ changes: [{ kind: "modify", path: "/work/a.txt" }], path: "/work/a.txt" });
  assert.deepEqual(seen.input, { changes: "modify /work/a.txt" });
});
