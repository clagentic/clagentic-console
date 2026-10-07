"use strict";
// A requestId is whatever a client sends. An answer may reach only a prompt
// the server holds, so a name every object inherits (__proto__, constructor,
// toString, ...) is no prompt: through every path that applies an answer it
// gets that path's not-found reply, nothing throws (an exception in a
// message handler takes the daemon down), nothing settles, and the real
// prompts stay pending and answerable. Runs on the real server modules
// (prompt-harness-world.js).

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var { promptsFor } = require("../lib/prompt-registry");
var { attachUserMessage } = require("../lib/project-user-message");

var HOSTILE_IDS = [
  "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__",
];
// JSON carries more than strings; each of these coerces to an inherited name.
var NON_STRING_IDS = [["__proto__"], ["constructor"], { toString: null }, 0, true];

var SCHEMA = { type: "object", properties: { token: { type: "string" } } };

// Every WS message that answers a prompt, built for one requestId, and the
// reply type its not-found answer gets.
var WS_ANSWERS = [
  { path: "prompt_response permission", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: "permission", requestId: id, decision: "allow_always" }; } },
  { path: "prompt_response plan", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: "plan", requestId: id, decision: "allow_clear_context" }; } },
  { path: "prompt_response ask_user", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: "ask_user", requestId: id, answers: { 0: "x" } }; } },
  { path: "prompt_response elicitation", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: "elicitation", requestId: id, action: "accept", content: { token: "t" } }; } },
  { path: "prompt_response extension", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: "extension", requestId: id, result: {} }; } },
  { path: "prompt_response with the id as its kind", stale: "prompt_cancel", build: function (id) { return { type: "prompt_response", kind: id, requestId: id, decision: "allow" }; } },
  { path: "permission_response", stale: "permission_cancel", build: function (id) { return { type: "permission_response", requestId: id, decision: "allow" }; } },
  { path: "ask_user_response", stale: "prompt_cancel", build: function (id) { return { type: "ask_user_response", toolId: id, answers: { 0: "x" } }; } },
  { path: "elicitation_response", stale: "prompt_cancel", build: function (id) { return { type: "elicitation_response", requestId: id, action: "accept", content: { token: "t" } }; } },
];

function client() {
  var inbox = [];
  return { inbox: inbox, ws: { readyState: 1, _clagenticUser: null, send: function (data) { inbox.push(JSON.parse(data)); } } };
}

// One prompt of every kind, pending, so every store and the index hold a
// real entry while the hostile answers arrive.
function openOneOfEach(server) {
  var session = server.session;
  var prompts = promptsFor(server.sm);
  var opened = {
    permission: server.bridge.handleCanUseTool(session, "Bash", { command: "make" }, { toolUseID: "tu-perm", signal: server.issueSignal().signal }),
    plan: server.bridge.handleCanUseTool(session, "ExitPlanMode", { plan: "p" }, { toolUseID: "tu-plan", signal: server.issueSignal().signal }),
    ask_user: server.bridge.handleCanUseTool(session, "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "x" }] }] }, { toolUseID: "tu-ask", signal: server.issueSignal().signal }),
    elicitation: server.bridge.handleElicitation(session, { serverName: "deploy", message: "Token?", requestedSchema: SCHEMA }, { signal: server.issueSignal().signal }),
    extension: prompts.open(null, "extension", { command: "tab_list", args: {} }, { timeoutMs: 60000 }),
  };
  var settled = {};
  Object.keys(opened).forEach(function (kind) {
    var answer = kind === "extension" ? opened[kind].answer : opened[kind];
    answer.then(function () { settled[kind] = true; });
  });
  var ids = { extension: opened.extension.requestId };
  prompts.pendingMessages(session).forEach(function (m) { ids[m.kind] = m.requestId; });
  return { opened: opened, settled: settled, ids: ids };
}

function assertPrototypesClean() {
  assert.deepEqual(Object.keys(Object.prototype), [], "Object.prototype gained no keys");
  assert.equal(typeof Object.prototype.toString, "function");
  assert.equal(typeof Object.prototype.hasOwnProperty, "function");
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

test("an inherited name is no prompt on any WS answer path: a stale reply, no throw, nothing settled", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var real = openOneOfEach(server);
    var held = server.heldPromptIds().sort();
    assert.equal(held.length, 4, "the four session prompts are pending");

    var ids = HOSTILE_IDS.concat(NON_STRING_IDS);
    for (var i = 0; i < WS_ANSWERS.length; i++) {
      for (var j = 0; j < ids.length; j++) {
        var path = WS_ANSWERS[i];
        var id = ids[j];
        var where = path.path + " with requestId " + JSON.stringify(id);
        c.inbox.length = 0;
        assert.doesNotThrow(function () { server.handlers.handleSessionsMessage(c.ws, path.build(id)); }, where);
        var replies = c.inbox.filter(function (m) { return m.type === path.stale; });
        assert.equal(replies.length, 1, where + ": one not-found reply");
        assert.equal(replies[0].reason, "stale", where);
        await world.flush();
        assert.deepEqual(server.heldPromptIds().sort(), held, where + ": every real prompt is still pending");
        assert.deepEqual(real.settled, {}, where + ": no vendor callback was answered");
      }
    }
    // A message type is a name from outside too: an inherited one is no
    // answer alias.
    HOSTILE_IDS.forEach(function (name) {
      assert.doesNotThrow(function () {
        server.handlers.handleSessionsMessage(c.ws, { type: name, requestId: real.ids.permission, decision: "allow" });
      }, "message type " + name);
    });
    await world.flush();
    assert.deepEqual(server.heldPromptIds().sort(), held, "an inherited message type settles nothing");
    assertPrototypesClean();

    // The real prompts are still answerable afterwards.
    server.handlers.handleSessionsMessage(c.ws, { type: "permission_response", requestId: real.ids.permission, decision: "allow" });
    assert.equal((await real.opened.permission).behavior, "allow");
  });
});

test("an inherited name is no prompt on the push notification's HTTP route: 404, no throw", async function () {
  await withServer(async function (server) {
    var real = openOneOfEach(server);
    var held = server.heldPromptIds().sort();
    for (var i = 0; i < HOSTILE_IDS.length; i++) {
      for (var d = 0; d < 2; d++) {
        var decision = d ? "deny" : "allow";
        var status = await server.httpRespond(HOSTILE_IDS[i], decision);
        assert.equal(status, 404, HOSTILE_IDS[i] + " " + decision + ": not found");
      }
    }
    await world.flush();
    assert.deepEqual(server.heldPromptIds().sort(), held, "every real prompt is still pending");
    assert.deepEqual(real.settled, {});
    assertPrototypesClean();
  });
});

test("an inherited name is no prompt on the browser extension's result path: no throw, nothing settled", async function () {
  await withServer(async function (server) {
    var real = openOneOfEach(server);
    var userMessages = attachUserMessage({ sm: server.sm, clients: server.clients, opts: {} });
    var ids = HOSTILE_IDS.concat(NON_STRING_IDS);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      assert.doesNotThrow(function () {
        userMessages.handleUserMessage({ readyState: 1 }, { type: "extension_result", requestId: id, result: { ok: true } });
      }, "extension_result with requestId " + JSON.stringify(id));
    }
    await world.flush();
    assert.deepEqual(real.settled, {}, "nothing settled");
    assertPrototypesClean();

    userMessages.handleUserMessage({ readyState: 1 }, { type: "extension_result", requestId: real.ids.extension, result: { ok: true } });
    assert.deepEqual(await real.opened.extension.answer, { ok: true }, "the real extension prompt is still answerable");
  });
});

test("the registry looks up only its own entries, whatever it is asked for", async function () {
  await withServer(async function (server) {
    openOneOfEach(server);
    var prompts = promptsFor(server.sm);
    HOSTILE_IDS.concat(NON_STRING_IDS).forEach(function (id) {
      var where = "requestId " + JSON.stringify(id);
      assert.equal(prompts.lookup(id, server.session), null, where + ": lookup finds nothing");
      assert.deepEqual(prompts.respond(id, { decision: "allow" }, { session: server.session }), { status: "stale" }, where + ": respond is stale");
      assert.equal(prompts.isTaskTracked(server.session, id), false, where + ": no Task is tracked by that name");
      assert.equal(prompts.taskOwnsPending(server.session, id), false, where);
    });
    assert.equal(prompts.isGranted(server.session, "constructor", {}), false, "no tool is granted by an inherited name");
    assertPrototypesClean();
  });
});
