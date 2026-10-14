"use strict";
// Opening and settling an operator prompt each leave one journal line, and
// every settle names its source: the connection and user that answered, the
// push action, the timer, or the cancel reason. The same source is recorded on
// the prompt_resolved event. No line carries prompt content.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var { createPromptRegistry } = require("../lib/prompt-registry");

var client = world.client;
var withServer = world.withServer;

var SECRET_COMMAND = "rm -rf SECRET-COMMAND-TEXT";
var SECRET_QUESTION = "SECRET-QUESTION-TEXT";
var SECRET_ANSWER = "SECRET-ANSWER-TEXT";

function captureRegistryLog(t) {
  var lines = [];
  t.mock.method(console, "log", function () { lines.push(Array.prototype.join.call(arguments, " ")); });
  return {
    all: lines,
    registry: function () { return lines.filter(function (l) { return l.indexOf("[prompt-registry]") === 0; }); },
  };
}

function answer(server, c, id, decision) {
  server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: id, kind: "permission", decision: decision });
}

function resolvedEvent(server, requestId) {
  return server.session.history.filter(function (m) { return m.type === "prompt_resolved" && m.requestId === requestId; })[0];
}

test("opening a prompt logs project, session, request, kind and tool, and never the tool input", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var asked = server.ask("Bash", { command: SECRET_COMMAND });
    var lines = log.registry();
    assert.deepEqual(lines, [
      "[prompt-registry] prompt opened: project=harness session=" + server.session.localId
        + " request=" + asked.id + " kind=permission tool=Bash agent=none",
    ]);
    log.all.forEach(function (l) { assert.equal(l.indexOf("SECRET-COMMAND-TEXT"), -1); });
  });
});

test("a prompt raised by a background agent names the owning Task", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var prompts = server.sm.prompts;
    prompts.taskStarted(server.session, "task-9");
    prompts.noteSubagentTool(server.session, "tu-sub", "task-9");
    server.ask("Write", { file_path: "/work/x" }, { toolUseID: "tu-sub" });
    assert.match(log.registry()[0], / kind=permission tool=Write agent=task:task-9$/);
  });
});

test("an answer from a browser connection logs the client and user and records the same source", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var c = client();
    c.ws._clagenticUser = { id: "u-7" };
    server.connect(c.ws);
    var asked = server.ask("Bash", { command: SECRET_COMMAND });
    answer(server, c, asked.id, "allow_always");
    assert.equal((await asked.promise).behavior, "allow");

    var clientId = c.ws._clagenticClientId;
    assert.match(clientId, /^c-[0-9a-f]{8}$/);
    var settled = log.registry()[1];
    assert.equal(settled,
      "[prompt-registry] prompt resolved: project=harness session=" + server.session.localId
      + " request=" + asked.id + " kind=permission tool=Bash agent=none decision=allow_always grant=stored"
      + " source=ws client=" + clientId + " user=u-7");
    assert.deepEqual(resolvedEvent(server, asked.id).source, { kind: "ws", clientId: clientId, user: "u-7" });
    log.all.forEach(function (l) { assert.equal(l.indexOf("SECRET-COMMAND-TEXT"), -1); });
  });
});

test("two answers from one connection share a client id; another connection gets its own", async function (t) {
  captureRegistryLog(t);
  await withServer(async function (server) {
    var a = client();
    var b = client();
    server.connect(a.ws);
    server.connect(b.ws);
    var first = server.ask("Bash", { command: "ls" });
    var second = server.ask("Bash", { command: "pwd" });
    var third = server.ask("Bash", { command: "date" });
    answer(server, a, first.id, "allow");
    answer(server, a, second.id, "deny");
    answer(server, b, third.id, "allow");
    var ids = [first, second, third].map(function (p) { return resolvedEvent(server, p.id).source.clientId; });
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[0], ids[2]);
  });
});

test("an answer from a push notification logs the push action", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var asked = server.ask("Bash", { command: "make" });
    assert.equal(await server.httpRespond(asked.id, "deny"), 200);
    assert.equal((await asked.promise).behavior, "deny");
    assert.match(log.registry()[1], / decision=deny grant=none source=push action=deny user=-$/);
    assert.deepEqual(resolvedEvent(server, asked.id).source, { kind: "push", action: "deny", user: null });
  });
});

test("a prompt that ends with its query logs the cancel reason as its source", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var asked = server.ask("Bash", { command: "make" });
    await server.endQuery();
    await asked.promise;
    var settled = log.registry()[1];
    assert.match(settled, /^\[prompt-registry\] prompt cancelled: /);
    assert.match(settled, / reason=\w+ source=cancel$/);
    assert.doesNotMatch(settled, /decision=/);
  });
});

test("a prompt that times out logs timeout as its source", function (t) {
  var log = captureRegistryLog(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var session = { localId: 3, queryInstance: null };
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    getProjectSlug: function () { return "alpha"; },
  });
  var opened = registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" }, { toolUseId: "tu-t", timeoutMs: 5000 });
  t.mock.timers.tick(5000);
  assert.equal(registry.lookup(opened.requestId), null);
  assert.equal(log.registry()[1],
    "[prompt-registry] prompt cancelled: project=alpha session=3 request=" + opened.requestId
    + " kind=permission tool=Bash agent=none reason=expired source=timeout");
});

test("an answer that names no source is logged as unspecified and its event carries none", function (t) {
  var log = captureRegistryLog(t);
  var session = { localId: 4, queryInstance: null };
  var recorded = [];
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function (s, m) { recorded.push(m); },
    saveSessionFile: function () {},
    getProjectSlug: function () { return "alpha"; },
  });
  var opened = registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" }, {});
  registry.respond(opened.requestId, { decision: "allow" });
  assert.match(log.registry()[1], / source=unspecified$/);
  assert.equal(recorded.filter(function (m) { return m.type === "prompt_resolved"; })[0].source, undefined);
});

test("an AskUserQuestion's question and answer stay out of the log", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var prompts = server.sm.prompts;
    var opened = prompts.open(server.session, "ask_user", { input: { questions: [{ question: SECRET_QUESTION }] } }, { toolUseId: "tu-q" });
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: opened.requestId, kind: "ask_user", answers: { 0: SECRET_ANSWER } });
    await opened.answer;
    var lines = log.registry();
    assert.equal(lines.length, 2);
    assert.match(lines[0], / kind=ask_user tool=- agent=none$/);
    assert.match(lines[1], /prompt resolved: .* kind=ask_user .* source=ws client=c-/);
    log.all.forEach(function (l) {
      assert.equal(l.indexOf("SECRET-QUESTION-TEXT"), -1);
      assert.equal(l.indexOf("SECRET-ANSWER-TEXT"), -1);
    });
  });
});

test("a value from outside cannot split a lifecycle line", async function (t) {
  var log = captureRegistryLog(t);
  await withServer(async function (server) {
    server.ask("Bash\nFORGED line", { command: "ls" });
    var forged = log.all.filter(function (l) { return l.indexOf("FORGED") !== -1; });
    assert.equal(forged.length, 1);
    assert.equal(forged[0].indexOf("\n"), -1);
    assert.equal(log.all.filter(function (l) { return l.indexOf("FORGED line") === 0; }).length, 0);
  });
});
