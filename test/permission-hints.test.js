"use strict";
// The Claude Agent SDK tells the host how an ask may be presented: a
// persistent "don't ask again" choice must not be offered (suppressAlwaysAllowRule),
// the ask must not open on an approve choice (defaultToNo), and a user-written
// ask rule forced it so no host-side auto-approval may answer it (matchedAskRule).
// These tests hold the console to that on every path that carries, shows or
// answers a tool-permission prompt, on the real server modules
// (prompt-harness-world.js) and the real client card code.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var dom = require("./fake-dom-prompt-cards");
var { promptsFor } = require("../lib/prompt-registry");

var RULE = { source: "projectSettings", toolName: "Bash", ruleContent: "make:*" };
var TOOL_INPUT = { command: "make" };

function client() {
  var inbox = [];
  return { inbox: inbox, ws: { readyState: 1, _clagenticUser: null, send: function (data) { inbox.push(JSON.parse(data)); } } };
}

async function withServer(fn) {
  var server = await world.createServer();
  try {
    await server.startQuery();
    await fn(server);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

// An in-process canUseTool call, as the SDK makes it, carrying the hints.
function ask(server, hints, toolName, input) {
  return server.ask(toolName || "Bash", input || TOOL_INPUT, hints);
}

function isSettled(promise) {
  var state = { settled: false };
  promise.then(function () { state.settled = true; });
  return state;
}

// Every WS shape that carries an Allow-for-session answer: the card, the
// notification banner (the card's message plus the project it belongs to), and
// the older per-kind alias.
var WS_SHAPES = [
  { name: "card prompt_response", build: function (id) { return { type: "prompt_response", requestId: id, kind: "permission", decision: "allow_always" }; } },
  { name: "banner prompt_response", build: function (id) { return { type: "prompt_response", requestId: id, kind: "permission", decision: "allow_always", targetSlug: "harness" }; } },
  { name: "permission_response alias", build: function (id) { return { type: "permission_response", requestId: id, decision: "allow_always" }; } },
];

test("a suppressed ask refuses allow_always on every answer path, stays pending and grants nothing", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var opened = ask(server, { suppressAlwaysAllowRule: true });
    var state = isSettled(opened.promise);
    assert.equal(opened.opened.length, 1, "the ask opened one prompt");

    for (var i = 0; i < WS_SHAPES.length; i++) {
      c.inbox.length = 0;
      server.handlers.handleSessionsMessage(c.ws, WS_SHAPES[i].build(opened.id));
      await world.flush();
      var where = WS_SHAPES[i].name;
      assert.equal(state.settled, false, where + ": the call is still waiting");
      assert.deepEqual(server.heldPromptIds(), [opened.id], where + ": the prompt is still pending");
      assert.deepEqual(Object.keys(server.session.allowedTools || {}), [], where + ": nothing was granted for the session");
      var reoffer = c.inbox.filter(function (m) { return m.type === "prompt_pending" && m.requestId === opened.id; });
      assert.equal(reoffer.length, 1, where + ": the prompt is offered again to the responder");
      assert.equal(reoffer[0].suppressAlwaysAllowRule, true, where + ": and still carries the restriction");
      assert.equal(c.inbox.filter(function (m) { return m.type === "prompt_resolved" || m.type === "prompt_cancel"; }).length, 0, where + ": nothing was announced as settled");
    }

    assert.equal(await server.httpRespond(opened.id, "allow_always"), 400, "the push route offers allow and deny only");
    assert.deepEqual(server.heldPromptIds(), [opened.id]);
    assert.equal(state.settled, false);

    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: opened.id, kind: "permission", decision: "allow" });
    var outcome = await opened.promise;
    assert.equal(outcome.behavior, "allow", "Allow once still works");
    assert.deepEqual(Object.keys(server.session.allowedTools || {}), [], "and grants nothing");

    var again = ask(server, { suppressAlwaysAllowRule: true });
    assert.equal(again.opened.length, 1, "the same call asks again: no standing approval was written");
  });
});

test("an ask without hints keeps offering and honouring Allow for session (Claude without hints, Codex approvals)", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var plain = ask(server, {});
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: plain.id, kind: "permission", decision: "allow_always" });
    assert.equal((await plain.promise).behavior, "allow");
    assert.equal(Object.keys(server.session.allowedTools).length, 1, "the grant was written");
    var second = ask(server, {});
    assert.equal(second.opened.length, 0, "the granted call is approved without a prompt");
    assert.equal((await second.promise).behavior, "allow");

    // Codex approvals arrive through the same callback with no hint fields.
    server.session.vendor = "codex";
    server.session.allowedTools = Object.create(null);
    var codexAsk = ask(server, {}, "Bash", { command: "make codex" });
    var pending = promptsFor(server.sm).pendingMessages(server.session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].suppressAlwaysAllowRule, undefined, "no restriction is invented");
    assert.equal(pending[0].defaultToNo, undefined);
    assert.equal(pending[0].matchedAskRule, undefined);
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: codexAsk.id, kind: "permission", decision: "allow_always" });
    assert.equal((await codexAsk.promise).behavior, "allow", "Allow for session works for an ask with no hints");
  });
});

test("the hints reach the prompt record, the recorded request, the connect snapshot and the notification", async function () {
  await withServer(async function (server) {
    var opened = ask(server, { suppressAlwaysAllowRule: true, defaultToNo: true, matchedAskRule: RULE });

    var pending = promptsFor(server.sm).pendingMessages(server.session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].suppressAlwaysAllowRule, true);
    assert.equal(pending[0].defaultToNo, true);
    assert.deepEqual(pending[0].matchedAskRule, RULE);

    var recorded = server.session.history.filter(function (m) { return m.type === "prompt_request" && m.requestId === opened.id; });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].suppressAlwaysAllowRule, true);
    assert.equal(recorded[0].defaultToNo, true);
    assert.deepEqual(recorded[0].matchedAskRule, RULE, "history paging replays the same restrictions");

    // A client connecting now gets the snapshot (replayed request and the
    // pending re-send), each carrying the hints.
    var late = client();
    server.connect(late.ws);
    var seen = late.inbox.filter(function (m) { return (m.type === "prompt_pending" || m.type === "prompt_request") && m.requestId === opened.id; });
    assert.ok(seen.some(function (m) { return m.type === "prompt_pending"; }), "the pending snapshot is sent");
    seen.forEach(function (m) {
      assert.equal(m.suppressAlwaysAllowRule, true, m.type + " carries suppressAlwaysAllowRule");
      assert.equal(m.defaultToNo, true, m.type + " carries defaultToNo");
      assert.deepEqual(m.matchedAskRule, RULE, m.type + " carries matchedAskRule");
    });

    var state = null;
    server.notifications.sendConnectionState({}, function (ws, msg) { state = msg; });
    var notif = state.notifications.filter(function (n) { return n.type === "permission_request" && n.meta.requestId === opened.id; })[0];
    assert.ok(notif, "the banner notification exists");
    assert.equal(notif.meta.suppressAlwaysAllowRule, true, "the banner is told not to offer Allow for session");
    assert.equal(notif.meta.defaultToNo, true);
  });
});

test("matchedAskRule is recorded on the resolved event; a malformed one still counts as rule-forced", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var opened = ask(server, { matchedAskRule: RULE });
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: opened.id, kind: "permission", decision: "deny" });
    await opened.promise;
    var resolved = server.session.history.filter(function (m) { return m.type === "prompt_resolved" && m.requestId === opened.id; });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].decision, "deny");
    assert.deepEqual(resolved[0].matchedAskRule, RULE);

    var long = "x".repeat(5000);
    var hostile = ask(server, { matchedAskRule: { source: long, toolName: 42, ruleContent: { nested: true } }, suppressAlwaysAllowRule: "yes", defaultToNo: 1 });
    var held = promptsFor(server.sm).pendingMessages(server.session).filter(function (m) { return m.requestId === hostile.id; })[0];
    assert.equal(typeof held.matchedAskRule, "object", "an object that is not the expected shape is still a rule-forced ask");
    assert.ok(held.matchedAskRule.source.length <= 200, "text is bounded");
    assert.equal(typeof held.matchedAskRule.toolName, "string");
    assert.equal(held.suppressAlwaysAllowRule, undefined, "only a real boolean true restricts: a string is not one");
    assert.equal(held.defaultToNo, undefined);
  });
});

test("a rule-forced ask is never answered by a host-side auto-approval", async function () {
  await withServer(async function (server) {
    var prompts = promptsFor(server.sm);

    // Read-only whitelist.
    var control = ask(server, {}, "Read", { file_path: "/srv/app/a.txt" });
    assert.equal(control.opened.length, 0);
    assert.equal((await control.promise).behavior, "allow", "control: a read-only tool is approved without a prompt");
    var forcedRead = ask(server, { matchedAskRule: RULE }, "Read", { file_path: "/srv/app/a.txt" });
    assert.equal(forcedRead.opened.length, 1, "whitelist: a rule-forced Read asks the operator");
    prompts.respond(forcedRead.id, { decision: "deny" });
    await forcedRead.promise;

    // Full-auto mode.
    server.sm.currentPermissionMode = "bypassPermissions";
    var controlBypass = ask(server, {}, "Write", { file_path: "/srv/app/b.txt" });
    assert.equal(controlBypass.opened.length, 0);
    assert.equal((await controlBypass.promise).behavior, "allow", "control: full auto approves");
    var forcedBypass = ask(server, { matchedAskRule: RULE }, "Write", { file_path: "/srv/app/b.txt" });
    assert.equal(forcedBypass.opened.length, 1, "full auto: a rule-forced ask asks the operator");
    prompts.respond(forcedBypass.id, { decision: "deny" });
    await forcedBypass.promise;
    server.sm.currentPermissionMode = "default";

    // Autonomous loop execution.
    server.session.loop = { active: true, role: "worker" };
    var controlLoop = ask(server, {}, "Edit", { file_path: "/srv/app/c.txt" });
    assert.equal(controlLoop.opened.length, 0);
    assert.equal((await controlLoop.promise).behavior, "allow", "control: a loop approves");
    var forcedLoop = ask(server, { matchedAskRule: RULE }, "Edit", { file_path: "/srv/app/c.txt" });
    assert.equal(forcedLoop.opened.length, 1, "loop: a rule-forced ask asks the operator");
    prompts.respond(forcedLoop.id, { decision: "deny" });
    await forcedLoop.promise;
    server.session.loop = null;

    // An earlier Allow for session.
    prompts.grant(server.session, "Bash", TOOL_INPUT);
    var controlGrant = ask(server, {});
    assert.equal(controlGrant.opened.length, 0);
    assert.equal((await controlGrant.promise).behavior, "allow", "control: a granted call is approved");
    var forcedGrant = ask(server, { matchedAskRule: RULE });
    assert.equal(forcedGrant.opened.length, 1, "grant: a rule-forced ask asks the operator");
    var suppressedGrant = ask(server, { suppressAlwaysAllowRule: true });
    assert.equal(suppressedGrant.opened.length, 1, "grant: an ask the SDK marked as broader than a standing approval asks the operator");
    var declinedGrant = ask(server, { defaultToNo: true });
    assert.equal(declinedGrant.opened.length, 1, "grant: an ask that must open on No asks the operator");
  });
});

test("a tool-permission ask relayed from a worker carries the hints through to the prompt", async function () {
  await withServer(async function (server) {
    var claudeAdapter = require("../lib/yoke/adapters/claude");
    var relay = require("../lib/yoke/adapters/permission-relay");
    var sent = [];
    var worker = { sent: sent, handler: null, process: null, exitPromise: null, onMessage: function (fn) { worker.handler = fn; }, send: function (m) { sent.push(m); } };
    claudeAdapter._test_createWorkerQueryHandle(worker, function (toolName, input, opts) {
      return server.bridge.handleCanUseTool(server.session, toolName, input, opts);
    }, null, null);

    // What the worker process puts on the socket for an SDK ask carrying the hints.
    var wire = JSON.parse(JSON.stringify(relay.toRequestMessage("w-1", "Bash", TOOL_INPUT, {
      toolUseID: "tu-worker", decisionReason: "rule", suppressAlwaysAllowRule: true, defaultToNo: true, matchedAskRule: RULE,
    })));
    worker.handler(wire);
    await world.flush();

    var pending = promptsFor(server.sm).pendingMessages(server.session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].suppressAlwaysAllowRule, true);
    assert.equal(pending[0].defaultToNo, true);
    assert.deepEqual(pending[0].matchedAskRule, RULE);

    var c = client();
    server.connect(c.ws);
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: pending[0].requestId, kind: "permission", decision: "allow_always" });
    await world.flush();
    assert.equal(sent.length, 0, "the worker was not answered: Allow for session was refused");
    assert.deepEqual(Object.keys(server.session.allowedTools || {}), []);

    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: pending[0].requestId, kind: "permission", decision: "allow" });
    await world.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "permission_response");
    assert.equal(sent[0].requestId, "w-1");
    assert.equal(sent[0].result.behavior, "allow");
  });
});

test("a request relayed from a worker with no hints is a plain ask", async function () {
  var relay = require("../lib/yoke/adapters/permission-relay");
  var wire = JSON.parse(JSON.stringify(relay.toRequestMessage("w-2", "Bash", TOOL_INPUT, { toolUseID: "tu", decisionReason: "" })));
  var opts = relay.toCanUseToolOptions(wire, new AbortController().signal);
  assert.equal(opts.suppressAlwaysAllowRule, undefined);
  assert.equal(opts.defaultToNo, undefined);
  assert.equal(opts.matchedAskRule, undefined);
  assert.equal(opts.toolUseID, "tu");
});

test("the hints a worker sends are taken as data: only a real true restricts, a rule is a bounded object", function () {
  var relay = require("../lib/yoke/adapters/permission-relay");
  var opts = relay.toCanUseToolOptions({ toolUseId: "t", suppressAlwaysAllowRule: "true", defaultToNo: 1, matchedAskRule: "yes" }, new AbortController().signal);
  assert.equal(opts.suppressAlwaysAllowRule, undefined);
  assert.equal(opts.defaultToNo, undefined);
  assert.deepEqual(opts.matchedAskRule, {}, "a rule that is present but not an object is still a rule-forced ask");
});

test("a prompt_response of the extension kind never settles a browser-extension command", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var prompts = promptsFor(server.sm);
    var command = prompts.open(null, "extension", { command: "tab_list", args: {} }, { timeoutMs: 60000 });
    var state = isSettled(command.answer);
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: command.requestId, kind: "extension", result: { forged: true } });
    await world.flush();
    assert.equal(state.settled, false, "another client's prompt_response does not answer the extension's command");
    assert.equal(c.inbox.filter(function (m) { return m.type === "prompt_cancel" && m.reason === "stale"; }).length, 1, "and is answered as not found");
    assert.equal(prompts.respond(command.requestId, { result: { ok: true } }, { kinds: ["extension"] }).status, "resolved", "the extension path still answers it");
    assert.deepEqual(await command.answer, { ok: true });
  });
});

// --- the client ------------------------------------------------------------

function request(id, extra) {
  return Object.assign({ type: "prompt_request", requestId: id, kind: "permission", toolName: "Bash", toolInput: TOOL_INPUT, decisionReason: "" }, extra || {});
}

async function clientFor(t, layout) {
  var env = await dom.setupToolsEnv(t);
  global.localStorage.setItem("clagentic-wide-view", layout);
  return env;
}

function approveControls(card) {
  return card.querySelectorAll("button").filter(function (b) {
    return /permission-allow|perm-allow|perm-always/.test(b.className);
  });
}

["bubble", "channel"].forEach(function (layout) {
  test("the " + layout + " card omits Allow for session for a suppressed ask, in a live request and in a replayed snapshot", async function (t) {
    var env = await clientFor(t, layout);
    env.tools.applyPromptMessage(request("c1"));
    assert.ok(dom.cardFor(env, "c1").querySelector(".permission-allow-session, .perm-always"), "control: an ordinary ask offers it");

    env.tools.applyPromptMessage(request("c2", { suppressAlwaysAllowRule: true }));
    assert.equal(dom.cardFor(env, "c2").querySelector(".permission-allow-session, .perm-always"), null, "live request");
    assert.ok(dom.cardFor(env, "c2").querySelector(".permission-allow, .perm-allow"), "Allow once stays");
    assert.ok(dom.cardFor(env, "c2").querySelector(".permission-deny, .perm-deny"), "Deny stays");

    env.tools.applyPromptMessage(Object.assign(request("c3", { suppressAlwaysAllowRule: true }), { type: "prompt_pending" }));
    assert.equal(dom.cardFor(env, "c3").querySelector(".permission-allow-session, .perm-always"), null, "pending snapshot");

    // The older recorded shape.
    env.tools.applyPromptMessage({ type: "permission_request", requestId: "c4", toolName: "Bash", toolInput: TOOL_INPUT, suppressAlwaysAllowRule: true });
    assert.equal(dom.cardFor(env, "c4").querySelector(".permission-allow-session, .perm-always"), null, "older permission_request shape");
  });

  test("the " + layout + " card for a defaultToNo ask opens on No: Deny first, no approve choice marked or focused", async function (t) {
    var env = await clientFor(t, layout);
    env.tools.applyPromptMessage(request("d1", { defaultToNo: true }));
    var card = dom.cardFor(env, "d1");
    var buttons = card.querySelectorAll(".permission-actions button");
    assert.match(buttons[0].className, /permission-deny|perm-deny/, "the decline option comes first");
    assert.equal(buttons[0].dataset.defaultChoice, "true", "and is the default choice");
    approveControls(card).forEach(function (b) {
      assert.equal(b.dataset.defaultChoice, undefined, "no approve option is the default");
    });
    assert.equal(card.dataset.defaultToNo, "true");

    env.tools.applyPromptMessage(request("d2"));
    var plain = dom.cardFor(env, "d2");
    assert.equal(plain.dataset.defaultToNo, undefined, "an ordinary ask is drawn as before");
    assert.match(plain.querySelectorAll(".permission-actions button")[0].className, /permission-allow|perm-allow/);
  });

  test("the " + layout + " card shows the rule that forced the ask", async function (t) {
    var env = await clientFor(t, layout);
    env.tools.applyPromptMessage(request("m1", { matchedAskRule: RULE }));
    var text = dom.cardFor(env, "m1").textContent;
    assert.match(text, /make:\*/, "the operator can see which of their rules asked");
  });
});

test("a banner offers Allow for session only for an ask that allows it, and Deny stays first for defaultToNo", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var banner = await import(dom.moduleUrl("prompt-banner.js"));
  var decisions = function (meta) { return banner.bannerActions("permission", meta).map(function (a) { return a.decision; }); };

  assert.deepEqual(decisions({}), ["allow", "allow_always", "deny"], "control: an ordinary ask");
  assert.deepEqual(decisions({ suppressAlwaysAllowRule: true }), ["allow", "deny"]);
  assert.deepEqual(decisions({ defaultToNo: true }), ["deny", "allow", "allow_always"], "No first when the ask must open on No");
  assert.deepEqual(decisions({ defaultToNo: true, suppressAlwaysAllowRule: true }), ["deny", "allow"]);
  assert.deepEqual(banner.bannerActions("plan", { suppressAlwaysAllowRule: true }).map(function (a) { return a.decision; }), ["allow", "deny"], "plan banners are unchanged");
  assert.deepEqual(banner.bannerActions("nonsense", {}), [], "a kind with no entry offers nothing");
  assert.deepEqual(banner.bannerActions("constructor", {}), [], "an inherited name is no kind");
});
