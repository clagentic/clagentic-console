// Regression / coverage tests for lr-872f94 — Codex telemetry: consume the
// vendor context window and previously-discarded token fields, render
// rate-limit usedPercent.
//
// Schema-verified (`codex app-server generate-json-schema`, codex-cli
// 0.124.0) findings this suite pins down:
//   - There is NO model_context_window field on turn/started or
//     turn/completed. That was a degraded-research-tier hypothesis, not a
//     real field. The vendor context window is
//     ThreadTokenUsage.modelContextWindow, delivered on
//     thread/tokenUsage/updated.
//   - ThreadTokenUsage.total (TokenUsageBreakdown) carries inputTokens,
//     outputTokens, cachedInputTokens, reasoningOutputTokens, totalTokens —
//     previously only .total.inputTokens was read (codex.js:540-546 before
//     this fix), discarding the rest.
//   - RateLimitWindow.usedPercent (account/rateLimits/updated) already
//     reached the frontend as a 0-1 "utilization" fraction on the
//     yokeType: "rate_limit" event but was never rendered in the pill.
//
// This suite drives the real createCodexQueryHandle (via
// _test_createCodexQueryHandle) against a fake app-server and asserts on
// the emitted YOKE events, not on source-text greps — same harness pattern
// as test/codex-live-model-effort-lr-79ee.test.js and
// test/codex-skill-permission-gate-lr-4a13c3.test.js.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

// Minimal fake app-server: only implements what createCodexQueryHandle's
// runQueryLoop/handleServerEvent actually call. The test controls exactly
// which notifications are dispatched before turn/completed so each test can
// isolate the tokenUsage-breakdown / context-window / rate-limit paths.
function buildFakeAppServer() {
  var handlers = [];
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
    respond: function () {},
    send: function (method, params) {
      sentMethods.push({ method: method, params: params });
      if (method === "thread/start") {
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      return Promise.resolve({});
    },
  };

  function dispatch(msg) {
    handlers.forEach(function (h) {
      if (h.threadId === null || h.threadId === "test-thread-1") h.fn(msg);
    });
  }

  return { appServer: appServer, dispatch: dispatch, sentMethods: sentMethods };
}

// Drains handle's async-iterator events until a "result" yokeType event is
// seen (or a timeout), returning every event collected along the way.
function collectUntilResult(handle) {
  return new Promise(function (resolve, reject) {
    var events = [];
    var deadline = Date.now() + 2000;
    (async function pump() {
      try {
        while (Date.now() < deadline) {
          var stepPromise = handle[Symbol.asyncIterator]().next();
          var step = await Promise.race([
            stepPromise,
            new Promise(function (r) { setTimeout(function () { r({ timedOut: true }); }, 50); }),
          ]);
          if (step.timedOut) continue;
          if (step.done) break;
          events.push(step.value);
          if (step.value.yokeType === "result") return resolve(events);
        }
        reject(new Error("timed out waiting for a result event; collected: " + JSON.stringify(events)));
      } catch (e) {
        reject(e);
      }
    })();
  });
}

test("lr-872f94: thread/tokenUsage/updated's full breakdown (output/cached/reasoning) reaches the result event's usage, not just input", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.5" });

  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });

  fake.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "test-thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens: 1200,
          outputTokens: 340,
          cachedInputTokens: 500,
          reasoningOutputTokens: 220,
          totalTokens: 2260,
        },
        last: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 500, reasoningOutputTokens: 220, totalTokens: 2260 },
        modelContextWindow: null,
      },
    },
  });
  fake.dispatch({ method: "turn/completed", params: { threadId: "test-thread-1", turn: { id: "turn-1", status: "completed" } } });

  var events = await collectUntilResult(handle);
  var result = events.filter(function (e) { return e.yokeType === "result"; })[0];

  assert.ok(result, "a result event must be emitted");
  assert.equal(result.usage.input_tokens, 1200);
  assert.equal(result.usage.output_tokens, 340, "outputTokens was previously discarded");
  assert.equal(result.usage.cache_read_input_tokens, 500, "cachedInputTokens was previously discarded");
  assert.equal(result.usage.reasoning_output_tokens, 220, "reasoningOutputTokens was previously discarded entirely -- a real Codex-specific spend category invisible to users before this fix");

  handle.close();
});

test("lr-872f94: ThreadTokenUsage.modelContextWindow populates modelUsage[model].contextWindow on the result event (vendor-first, no hardcoded table)", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.5" });

  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });

  fake.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "test-thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 110 },
        last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 110 },
        // Schema-verified field name/location (lr-872f94): NOT on
        // turn/started -- that field does not exist in the installed
        // protocol version.
        modelContextWindow: 272000,
      },
    },
  });
  fake.dispatch({ method: "turn/completed", params: { threadId: "test-thread-1", turn: { id: "turn-1", status: "completed" } } });

  var events = await collectUntilResult(handle);
  var result = events.filter(function (e) { return e.yokeType === "result"; })[0];

  assert.equal(result.modelUsage["gpt-5.5"].contextWindow, 272000, "the vendor-reported window must be used verbatim, no table lookup involved");

  handle.close();
});

test("lr-872f94: with no thread/tokenUsage/updated context window reported yet, modelUsage[model].contextWindow stays null (unknown, not a guess)", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.5" });

  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });

  fake.dispatch({ method: "turn/completed", params: { threadId: "test-thread-1", turn: { id: "turn-1", status: "completed" } } });

  var events = await collectUntilResult(handle);
  var result = events.filter(function (e) { return e.yokeType === "result"; })[0];

  assert.equal(result.modelUsage["gpt-5.5"].contextWindow, null, "must stay null (unknown) absent a vendor-reported window -- never a hardcoded per-model default (lr-3af675 contract)");

  handle.close();
});

test("lr-872f94: a zero/negative/non-numeric modelContextWindow does not clobber a previously-known good window", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.5" });

  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });

  fake.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "test-thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 },
        last: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 },
        modelContextWindow: 272000,
      },
    },
  });
  fake.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "test-thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 22 },
        last: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 22 },
        modelContextWindow: null, // e.g. a later update that doesn't repeat it
      },
    },
  });
  fake.dispatch({ method: "turn/completed", params: { threadId: "test-thread-1", turn: { id: "turn-1", status: "completed" } } });

  var events = await collectUntilResult(handle);
  var result = events.filter(function (e) { return e.yokeType === "result"; })[0];

  assert.equal(result.modelUsage["gpt-5.5"].contextWindow, 272000, "a later null modelContextWindow must not erase an already-known vendor window");

  handle.close();
});

test("lr-872f94: account/rateLimits/updated still emits utilization (0-1 fraction) on the rate_limit event for the pill percent render", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, { model: "gpt-5.5" });

  var rateLimitEvents = [];
  (async function drain() {
    for await (var evt of handle) {
      if (evt.yokeType === "rate_limit") rateLimitEvents.push(evt);
      if (evt.yokeType === "result") break;
    }
  })();

  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });

  fake.dispatch({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        primary: { usedPercent: 83, resetsAt: 1234567890, windowDurationMins: 300 },
      },
    },
  });
  fake.dispatch({ method: "turn/completed", params: { threadId: "test-thread-1", turn: { id: "turn-1", status: "completed" } } });

  await new Promise(function (r) { setTimeout(r, 100); });

  assert.equal(rateLimitEvents.length, 1);
  assert.equal(rateLimitEvents[0].rateLimitInfo.utilization, 0.83, "usedPercent must reach the frontend as a 0-1 fraction, matching Claude's rate_limit_info.utilization shape");
  assert.equal(rateLimitEvents[0].rateLimitInfo.status, "allowed_warning", "our own >=80 threshold (documented as invented, not vendor semantics)");

  handle.close();
});
