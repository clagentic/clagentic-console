"use strict";
// The vendor adapters hand every operator prompt an AbortSignal that ends the
// daemon-side prompt when the vendor side gives up on it: the worker relay
// (lib/yoke/adapters/claude.js) on a worker-side expiry or cancellation and
// when the worker's query ends, the Codex adapter on the app-server clearing
// a request it never got an answer to and when its query ends. A signal must
// only ever end a prompt that is still waiting.

var test = require("node:test");
var assert = require("node:assert/strict");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var codexAdapter = require("../lib/yoke/adapters/codex");

function tick() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function fakeWorker() {
  var worker = {
    sent: [],
    handler: null,
    process: null,
    exitPromise: null,
    onMessage: function (fn) { worker.handler = fn; },
    send: function (msg) { worker.sent.push(msg); },
  };
  return worker;
}

// A daemon-side callback whose settlement the test controls.
function controlledCallback() {
  var calls = [];
  function callback() {
    var args = Array.prototype.slice.call(arguments);
    var opts = args[args.length - 1];
    var call = { args: args, signal: opts.signal };
    call.promise = new Promise(function (resolve, reject) { call.resolve = resolve; call.reject = reject; });
    calls.push(call);
    return call.promise;
  }
  return { callback: callback, calls: calls };
}

test("a worker-side expiry ends the daemon-side permission prompt while it is waiting", async function () {
  var worker = fakeWorker();
  var cb = controlledCallback();
  claudeAdapter._test_createWorkerQueryHandle(worker, cb.callback, null, null);

  worker.handler({ type: "permission_request", requestId: "w1", toolName: "Bash", input: {}, toolUseId: "tu" });
  worker.handler({ type: "permission_expired", requestId: "w1" });

  assert.equal(cb.calls[0].signal.aborted, true);
  assert.equal(cb.calls[0].signal.reason, "expired");
});

test("a permission prompt that settled, either way, is not ended by a later expiry", async function () {
  var outcomes = ["resolve", "reject"];
  for (var i = 0; i < outcomes.length; i++) {
    var worker = fakeWorker();
    var cb = controlledCallback();
    var errors = [];
    var origError = console.error;
    console.error = function () { errors.push(Array.prototype.join.call(arguments, " ")); };
    try {
      claudeAdapter._test_createWorkerQueryHandle(worker, cb.callback, null, null);
      worker.handler({ type: "permission_request", requestId: "w2", toolName: "Bash", input: {}, toolUseId: "tu" });
      if (outcomes[i] === "resolve") cb.calls[0].resolve({ behavior: "allow", updatedInput: {} });
      else cb.calls[0].reject(new Error("callback failed"));
      await tick();
      worker.handler({ type: "permission_expired", requestId: "w2" });
    } finally {
      console.error = origError;
    }

    assert.equal(cb.calls[0].signal.aborted, false, outcomes[i] + ": the relay forgot the prompt once it settled");
    if (outcomes[i] === "resolve") assert.deepEqual(worker.sent, [{ type: "permission_response", requestId: "w2", result: { behavior: "allow", updatedInput: {} } }]);
    else assert.equal(errors.length, 1, "a failed callback is logged, not dropped silently");
  }
});

test("a prompt the worker's SDK cancelled, or every prompt once the worker's query ends, ends daemon-side", function () {
  var worker = fakeWorker();
  var cb = controlledCallback();
  var elicit = controlledCallback();
  claudeAdapter._test_createWorkerQueryHandle(worker, cb.callback, elicit.callback, null);
  worker.handler({ type: "permission_request", requestId: "w3", toolName: "Bash", input: {}, toolUseId: "tu" });
  worker.handler({ type: "ask_user_request", toolUseId: "tu-ask", input: { questions: [] } });
  worker.handler({ type: "elicitation_request", requestId: "e2", serverName: "srv", message: "?" });

  worker.handler({ type: "prompt_cancelled", kind: "ask_user", id: "tu-ask" });
  assert.equal(cb.calls[1].signal.aborted, true, "the cancelled question ends");
  assert.equal(cb.calls[0].signal.aborted, false, "nothing else does");

  worker.handler({ type: "query_done" });
  assert.equal(cb.calls[0].signal.aborted, true);
  assert.equal(elicit.calls[0].signal.aborted, true);
});

test("the worker's AskUserQuestion and elicitation prompts get a real abort signal too", function () {
  var worker = fakeWorker();
  var ask = controlledCallback();
  var elicit = controlledCallback();
  claudeAdapter._test_createWorkerQueryHandle(worker, ask.callback, elicit.callback, null);

  worker.handler({ type: "ask_user_request", toolUseId: "tu-ask", input: { questions: [] } });
  worker.handler({ type: "elicitation_request", requestId: "e1", serverName: "srv", message: "?" });

  assert.ok(ask.calls[0].signal instanceof AbortSignal);
  assert.ok(elicit.calls[0].signal instanceof AbortSignal);
});

// A fake Codex app-server that issues one command approval on turn start.
function codexWithApproval() {
  var handlers = [];
  var fake = { respondCalls: [] };
  fake.dispatch = function (msg) {
    handlers.forEach(function (h) { if (h.threadId === null || h.threadId === "thread-1") h.fn(msg); });
  };
  fake.appServer = {
    started: true,
    addEventHandler: function (fn, threadId) { var e = { fn: fn, threadId: threadId || null }; handlers.push(e); return e; },
    removeEventHandler: function (e) { handlers = handlers.filter(function (h) { return h !== e; }); },
    updateHandlerThreadId: function (e, threadId) { e.threadId = threadId || null; },
    respond: function (id, result) { fake.respondCalls.push({ id: id, result: result }); },
    send: function (method) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        setImmediate(function () {
          fake.dispatch({ method: "item/commandExecution/requestApproval", id: 41, params: { threadId: "thread-1", itemId: "i1", command: "make" } });
        });
      }
      return Promise.resolve({});
    },
  };
  return fake;
}

async function waitFor(predicate) {
  for (var i = 0; i < 200 && !predicate(); i++) await tick();
  assert.ok(predicate(), "timed out");
}

test("a Codex approval the app-server cleared ends the daemon-side prompt and takes no answer", async function () {
  var fake = codexWithApproval();
  var cb = controlledCallback();
  var handle = codexAdapter._test_createCodexQueryHandle(fake.appServer, { approvalPolicy: "on-request", canUseTool: cb.callback });
  handle.pushMessage("go");
  await waitFor(function () { return cb.calls.length === 1; });
  var call = cb.calls[0];
  call.signal.addEventListener("abort", function () { call.resolve({ behavior: "deny", message: "Request cancelled" }); });

  fake.dispatch({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } });
  await tick();
  await tick();

  assert.equal(call.signal.aborted, true);
  assert.deepEqual(fake.respondCalls, [], "a cleared request is not answered");
  handle.close();
});

test("a Codex approval answered by the operator is not aborted by the app-server's confirmation", async function () {
  var fake = codexWithApproval();
  var cb = controlledCallback();
  var handle = codexAdapter._test_createCodexQueryHandle(fake.appServer, { approvalPolicy: "on-request", canUseTool: cb.callback });
  handle.pushMessage("go");
  await waitFor(function () { return cb.calls.length === 1; });

  cb.calls[0].resolve({ behavior: "allow" });
  await waitFor(function () { return fake.respondCalls.length === 1; });
  fake.dispatch({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } });
  handle.close();

  assert.equal(cb.calls[0].signal.aborted, false);
  assert.deepEqual(fake.respondCalls[0], { id: 41, result: { decision: "accept" } });
});

test("a Codex approval still waiting when its query ends is ended and not answered", async function () {
  var fake = codexWithApproval();
  var cb = controlledCallback();
  var handle = codexAdapter._test_createCodexQueryHandle(fake.appServer, { approvalPolicy: "on-request", canUseTool: cb.callback });
  handle.pushMessage("go");
  await waitFor(function () { return cb.calls.length === 1; });

  handle.close();
  cb.calls[0].resolve({ behavior: "deny", message: "Request cancelled" });
  await tick();

  assert.equal(cb.calls[0].signal.aborted, true);
  assert.deepEqual(fake.respondCalls, []);
});
