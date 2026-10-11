"use strict";
// Codex sessions through the real server, project context and SDK bridge, and
// the real Codex adapter over a recording stand-in for the app-server process:
//   - the model list the project shows everyone is read in the environment no
//     session adds to, never in a session's own;
//   - a rewind rolls the Codex thread back on a server for the session's
//     environment even after the idle reclaim ended the one that held it, and
//     when the thread cannot be rolled back the rewind fails and the session's
//     history is left as it was.

var test = require("node:test");
var assert = require("node:assert/strict");

// The Codex adapter takes its app-server class when it is loaded: swap in a
// recording one before anything loads it.
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var appServers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.started = false;
  this.proc = null;
  this.calls = [];
  appServers.push(this);
}
FakeAppServer.rollbackFailure = null;
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.send = function (method, params) {
  this.calls.push({ method: method, params: params });
  if (method === "model/list") {
    var tag = this.opts.env && this.opts.env.MODEL_TAG;
    var model = tag ? "gpt-" + tag : "gpt-test";
    return Promise.resolve({ data: [{ model: model, displayName: model, isDefault: true }] });
  }
  if (method === "skills/list") return Promise.resolve({ data: [] });
  if (method === "thread/rollback" && FakeAppServer.rollbackFailure) return Promise.reject(new Error(FakeAppServer.rollbackFailure));
  return Promise.resolve({});
};
FakeAppServer.prototype.addEventHandler = function () { return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

var config = { sharedEnv: "", projects: [{ slug: "alpha" }] };
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
});

var server = null;
var alpha = null;
var ownerWs = null;
var codexAdapter = null;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function until(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

function callsOf(appServer, method) {
  return appServer.calls.filter(function (c) { return c.method === method; });
}

function modelValues(models) {
  return (models || []).map(function (m) { return typeof m === "string" ? m : m.value; });
}

// A Codex session of the project's owner with two turns of local history and a
// thread behind it.
function sessionWithTwoTurns(threadId) {
  var session = alpha.sm.createSessionRaw({ ownerId: server.people.owner.id });
  session.vendor = "codex";
  session.cliSessionId = threadId;
  session.history = [
    { type: "user_message", text: "first" },
    { type: "message_uuid", uuid: "u1", messageType: "user" },
    { type: "delta", text: "answer" },
    { type: "user_message", text: "second" },
    { type: "message_uuid", uuid: "u2", messageType: "user" },
  ];
  session.messageUUIDs = [
    { uuid: "u1", type: "user", historyIndex: 1 },
    { uuid: "u2", type: "user", historyIndex: 4 },
  ];
  // A rewind reads the full history back from the session's file.
  alpha.sm.saveSessionFile(session);
  return session;
}

async function rewind(session, uuid) {
  ownerWs.inbox.length = 0;
  ownerWs.send({ type: "switch_session", id: session.localId });
  await ownerWs.waitFor(function (m) { return m.type === "session_switched"; });
  ownerWs.inbox.length = 0;
  ownerWs.send({ type: "rewind_execute", uuid: uuid, mode: "chat" });
  return ownerWs.waitFor(function (m) { return m.type === "rewind_complete" || m.type === "rewind_error"; });
}

test.before(async function () {
  server = await harness.start({
    users: [{ key: "owner", username: "owner", role: "admin" }],
    projects: [{ slug: "alpha", ownerKey: "owner" }],
    serverOpts: envSettings,
    beforeServer: function () {
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        codexAdapter = yoke.createAdapter({ vendor: "codex", cwd: opts.cwd, slug: opts.slug });
        return { adapters: { codex: codexAdapter }, auth: { codex: true } };
      };
    },
  });
  server.relay.forEachProject(function (ctx, slug) {
    if (slug === "alpha") alpha = ctx;
  });
  ownerWs = await server.connect("alpha", "owner");
  assert.equal(ownerWs.ok, true);
  // The first connection warms the adapters up, in the environment no session adds to.
  await until(function () { return appServers.length > 0 && alpha.sm.modelsByVendor && alpha.sm.modelsByVendor.codex; }, "the warmup");

  ownerWs.send({ type: "set_project_env", envrc: "export MODEL_TAG=owner" });
  var saved = await ownerWs.waitFor(function (m) { return m.type === "set_project_env_result"; });
  assert.equal(saved.ok, true, saved.error);
});

test.after(async function () {
  if (server) await server.stop();
});

test("a session's own environment does not decide the model list the project shows everyone", async function () {
  assert.deepEqual(modelValues(alpha.sm.modelsByVendor.codex), ["gpt-test"], "the warmup list is the no-session environment's");
  // As when the list was never filled: the next session to start fills it.
  delete alpha.sm.modelsByVendor.codex;

  var session = sessionWithTwoTurns("thread-models");
  await alpha.sdk.startQuery(session, "go", null, null);

  var ownersServer = appServers.filter(function (s) { return s.opts.env && s.opts.env.MODEL_TAG === "owner"; })[0];
  assert.ok(ownersServer, "the owner's session runs on a server with the owner's variables");
  assert.deepEqual(modelValues(alpha.sm.modelsByVendor.codex), ["gpt-test"],
    "the shared list was filled from the no-session environment, not from the owner's endpoint");

  if (session.queryInstance) session.queryInstance.close();
  if (session.streamPromise) await session.streamPromise;
});

test("a rewind after the idle reclaim ended the thread's server rolls the thread back on a server for the session's environment", async function () {
  assert.equal(await codexAdapter.shutdownIfIdle(0), true, "the idle servers are reclaimed");
  var session = sessionWithTwoTurns("thread-rewind");
  var count = appServers.length;

  var outcome = await rewind(session, "u2");

  assert.equal(outcome.type, "rewind_complete", outcome.text);
  assert.equal(appServers.length, count + 1, "the owner's server was started again");
  var restarted = appServers[appServers.length - 1];
  assert.equal(restarted.opts.env.MODEL_TAG, "owner");
  assert.deepEqual(callsOf(restarted, "thread/rollback").map(function (c) { return c.params; }), [{ threadId: "thread-rewind", numTurns: 1 }]);
  var texts = session.history.map(function (entry) { return entry.text; });
  assert.ok(texts.indexOf("first") !== -1, "the turn before the rewound one is kept");
  assert.equal(texts.indexOf("second"), -1, "and the local history was trimmed to before the rewound turn");
});

test("a rewind whose Codex thread cannot be rolled back fails and leaves the session's history as it was", async function () {
  var session = sessionWithTwoTurns("thread-refused");
  FakeAppServer.rollbackFailure = "thread not found";
  var outcome;
  try {
    outcome = await rewind(session, "u2");
  } finally {
    FakeAppServer.rollbackFailure = null;
  }

  assert.equal(outcome.type, "rewind_error");
  assert.match(outcome.text, /thread not found/);
  assert.equal(session.history.length, 5, "no entry was dropped");
  assert.equal(session.messageUUIDs.length, 2);
});
