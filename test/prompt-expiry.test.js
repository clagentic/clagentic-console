"use strict";
// The registry-wide bound on an unanswered operator prompt (daemon.json
// promptExpiryMinutes, lib/prompt-expiry.js), on every path that opens a
// prompt, with fake timers.

var test = require("node:test");
var assert = require("node:assert/strict");
var { createPromptRegistry } = require("../lib/prompt-registry");
var { createExpiryReader } = require("../lib/prompt-expiry");
var claudeAdapter = require("../lib/yoke/adapters/claude");
var { startWorkerProcess } = require("./helpers/worker-process");
var world = require("./prompt-harness-world");

var HOUR = 3600000;
var DAY = 24 * HOUR;

function makeRegistry(config) {
  var recorded = [];
  var session = { localId: 1, queryInstance: null };
  var cfg = { value: config };
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function (s, m) { recorded.push(m); },
    saveSessionFile: function () {},
    getConfig: function () { return cfg.value; },
  });
  return { registry: registry, session: session, recorded: recorded, cfg: cfg };
}

var OPENERS = {
  permission: function (h) { return h.registry.open(h.session, "permission", { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" }, { toolUseId: "tu-p" }); },
  plan: function (h) { return h.registry.open(h.session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, { toolUseId: "tu-pl" }); },
  ask_user: function (h) { return h.registry.open(h.session, "ask_user", { input: { questions: [{ question: "Which?" }] } }, { toolUseId: "tu-a" }); },
  elicitation: function (h) { return h.registry.open(h.session, "elicitation", { serverName: "srv", message: "?" }, { toolUseId: "tu-e" }); },
};

function cancels(h) {
  return h.recorded.filter(function (m) { return m.type === "prompt_cancel"; });
}

function silenceWarnings(t) {
  var warnings = [];
  t.mock.method(console, "warn", function () { warnings.push(Array.prototype.join.call(arguments, " ")); });
  return warnings;
}

Object.keys(OPENERS).forEach(function (kind) {
  test("a " + kind + " prompt expires once at the default bound, cancelled with reason expired and source timeout", async function (t) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    var h = makeRegistry(null);
    var opened = OPENERS[kind](h);
    var settled = false;
    opened.answer.then(function () { settled = true; });

    t.mock.timers.tick(DAY - 1);
    await Promise.resolve();
    assert.equal(settled, false, "still pending a moment before the bound");
    assert.equal(cancels(h).length, 0);

    t.mock.timers.tick(1);
    var value = await opened.answer;
    assert.equal(cancels(h).length, 1);
    assert.equal(cancels(h)[0].reason, "expired");
    assert.equal(cancels(h)[0].source, "timeout");
    assert.equal(h.registry.lookup(opened.requestId), null);
    // The kind's own fail-closed value is what the callback receives.
    if (kind === "elicitation") assert.equal(value.action, "reject");
    else assert.equal(value.behavior, "deny");

    t.mock.timers.tick(DAY);
    assert.equal(cancels(h).length, 1, "nothing ends it a second time");
  });
});

test("promptExpiryMinutes sets the bound; 0 disables it", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry({ promptExpiryMinutes: 10 });
  OPENERS.permission(h);
  t.mock.timers.tick(10 * 60000);
  assert.equal(cancels(h).length, 1);

  var off = makeRegistry({ promptExpiryMinutes: 0 });
  var opened = OPENERS.permission(off);
  t.mock.timers.tick(365 * DAY);
  assert.equal(cancels(off).length, 0);
  assert.notEqual(off.registry.lookup(opened.requestId), null, "still pending");
});

test("a malformed or negative promptExpiryMinutes falls back to the default with one warning naming the key", function (t) {
  var warnings = silenceWarnings(t);
  var read = createExpiryReader();
  [-5, "10", NaN, Infinity, true, {}, 1e9].forEach(function (bad) {
    assert.equal(read({ promptExpiryMinutes: bad }), DAY, JSON.stringify(bad));
  });
  read({ promptExpiryMinutes: -5 });
  read({ promptExpiryMinutes: -5 });
  assert.equal(warnings.filter(function (w) { return /promptExpiryMinutes/.test(w); }).length, 7, "one per distinct value");
  assert.equal(read({}), DAY);
  assert.equal(read(null), DAY);
  assert.equal(read({ promptExpiryMinutes: 0 }), 0);
  assert.equal(read({ promptExpiryMinutes: 1.5 }), 90000);
  assert.equal(warnings.length, 7, "absent and valid values do not warn");
});

test("the registry warns once for a malformed value across many prompts", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var warnings = silenceWarnings(t);
  var h = makeRegistry({ promptExpiryMinutes: -1 });
  OPENERS.permission(h);
  OPENERS.plan(h);
  OPENERS.ask_user(h);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promptExpiryMinutes/);
});

test("an answer just before the bound wins and the prompt does not also expire", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry(null);
  var opened = OPENERS.permission(h);
  t.mock.timers.tick(DAY - 1);
  var outcome = h.registry.respond(opened.requestId, { decision: "allow" }, {});
  assert.equal(outcome.status, "resolved");
  t.mock.timers.tick(10);
  assert.equal(cancels(h).length, 0);
  assert.equal(h.recorded.filter(function (m) { return m.type === "prompt_resolved"; }).length, 1);
  assert.equal((await opened.answer).behavior, "allow");
});

test("a kind's own timeout wins over the bound", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry({ promptExpiryMinutes: 0 });
  var ext = h.registry.open(null, "extension", { command: "tab_page_text", args: {} }, { timeoutMs: 500 });
  var explicit = h.registry.open(h.session, "permission", { toolName: "Bash", toolInput: {}, vendor: "claude" }, { toolUseId: "tu-x", timeoutMs: 1000 });
  t.mock.timers.tick(500);
  assert.equal(h.registry.lookup(ext.requestId), null, "the extension command still ends at its own 500 ms");
  assert.notEqual(h.registry.lookup(explicit.requestId), null);
  t.mock.timers.tick(500);
  assert.equal(h.registry.lookup(explicit.requestId), null, "an explicit timeoutMs is honoured even with the bound off");
});

test("a reconnect, a replay and a history page do not reset the deadline", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry(null);
  var opened = OPENERS.permission(h);
  t.mock.timers.tick(DAY / 2);
  // What a reconnecting client causes: the prompt is re-presented and a
  // replayed history is annotated against it.
  h.registry.pendingMessages(h.session);
  h.registry.pendingInfo(h.session);
  h.registry.replayAnnotator(h.session, h.recorded, 0);
  h.registry.lookup(opened.requestId);
  t.mock.timers.tick(DAY / 2);
  assert.equal(cancels(h).length, 1, "expired DAY after open(), not DAY after the reconnect");
});

test("a changed setting applies to the next prompt, not to one already open", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry({ promptExpiryMinutes: 60 });
  OPENERS.permission(h);
  h.cfg.value = { promptExpiryMinutes: 0 };
  t.mock.timers.tick(HOUR);
  assert.equal(cancels(h).length, 1);
});

test("an in-process permission prompt expires through the registry, with the SDK's deny", async function (t) {
  await world.withServer(async function (server) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    var asked = server.ask("Bash", { command: "make" });
    t.mock.timers.tick(DAY);
    var value = await asked.promise;
    assert.equal(value.behavior, "deny");
    var cancel = server.session.history.filter(function (m) { return m.type === "prompt_cancel"; })[0];
    assert.equal(cancel.reason, "expired");
    assert.equal(cancel.source, "timeout");
  });
});

test("a Codex approval prompt, which reaches canUseTool with only an abort signal, expires through the registry", async function (t) {
  await world.withServer(async function (server) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    var ac = new AbortController();
    var pending = server.bridge.handleCanUseTool(server.session, "Bash", { command: "make" }, { signal: ac.signal });
    assert.equal(server.heldPromptIds().length, 1);
    t.mock.timers.tick(DAY);
    var value = await pending;
    assert.equal(value.behavior, "deny");
    assert.equal(server.heldPromptIds().length, 0);
    assert.equal(ac.signal.aborted, false, "the registry settled it; nothing aborted the vendor's signal");
  });
});

test("the invariant harness sees the expiry as one terminal event with source timeout", async function (t) {
  if (world.overridesLib) { t.skip("only meaningful against this checkout"); return; }
  var harness = require("./prompt-invariants-harness");
  await harness.freshDom();
  var h = new harness.Harness("expiry");
  await h.init(1);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    var kinds = Object.keys(harness.BY_KIND);
    var reqs = [];
    for (var i = 0; i < kinds.length; i++) {
      var r = await h.request(harness.BY_KIND[kinds[i]], null);
      if (r) reqs.push(r);
    }
    assert.ok(reqs.length >= 3);
    await h.expire(function () { t.mock.timers.tick(DAY); });
    reqs.forEach(function (r) {
      assert.equal(r.settled, true, r.id + " settled");
      assert.equal(h.terminalEvents[r.id], 1, r.id + " recorded exactly one terminal event");
      assert.deepEqual(h.cancelEvents[r.id], { reason: "expired", source: "timeout" });
    });
    h.assertClean();
  } finally {
    h.close();
  }
});

test("the worker relay holds a prompt for the daemon past 30 s: it only ends when the daemon says so", async function () {
  var worker = { sent: [], handler: null, process: null, exitPromise: null, onMessage: function (fn) { worker.handler = fn; }, send: function (m) { worker.sent.push(m); } };
  var calls = [];
  claudeAdapter._test_createWorkerQueryHandle(worker, function (name, input, opts) {
    return new Promise(function (resolve) { calls.push({ signal: opts.signal, resolve: resolve }); });
  }, null, null);
  worker.handler({ type: "permission_request", requestId: "w1", toolName: "Bash", input: {}, toolUseId: "tu" });
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve({ behavior: "deny", message: "Permission request timed out" });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(worker.sent[0].type, "permission_response");
});

test("the worker process no longer auto-denies a permission ask after 30 s", { timeout: 60000 }, async function () {
  var worker = await startWorkerProcess({ prefix: "clagentic-worker-expiry-", waitMs: 33000 });
  try {
    worker.send({ type: "query_start", prompt: null, options: { cwd: require("os").tmpdir() }, singleTurn: false });
    await worker.next(function (m) { return m.type === "sdk_event" && m.event.subtype === "init"; }, "init");
    worker.send({ type: "push_message", content: { type: "user", message: { role: "user", content: [{ type: "text", text: "ask" }] } } });
    await worker.next(function (m) { return m.type === "permission_request"; }, "permission_request");
    await assert.rejects(
      worker.next(function (m) { return m.type === "permission_expired" || (m.type === "sdk_event" && m.event.call === "canUseTool"); }, "an auto-deny"),
      /timed out waiting for an auto-deny/
    );
  } finally {
    await worker.stop();
  }
});
