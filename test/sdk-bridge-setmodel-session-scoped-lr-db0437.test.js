"use strict";
/**
 * Regression test for lr-db0437: setModel() used to write the chosen model
 * into BOTH session.model AND the shared sm.currentModel. Since sm.currentModel
 * is what new_session (lib/project-sessions.js) seeds a brand-new session's
 * model from, any session picking a model silently became the de-facto
 * project default for every session created afterward.
 *
 * Fix mirrors the existing setPermissionMode pattern (lib/sdk-bridge.js,
 * same file): a session-only write. sm.currentModel is now only ever
 * updated by the explicit default-setter handlers
 * (set_project_default_model / set_server_default_model in
 * project-sessions.js), never by a plain per-session setModel call.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createSDKBridge } = require("../lib/sdk-bridge");

function makeBridge(smOverrides) {
  var sent = [];
  var sentToSession = [];
  var sm = Object.assign({
    currentModel: null,
    modelsByVendor: {},
    // lr-041af8: setModel's model_info reply is now targeted per-session
    // (sendToSession) instead of a broadcast, so a session's model choice
    // can no longer overwrite every other open session's chip. Mirrors
    // sm.sendToSession's real per-session-targeting shape closely enough for
    // this unit test: records what was sent, keyed by the acting session.
    sendToSession: function (session, obj) { sentToSession.push([session, obj]); },
  }, smOverrides);
  var bridge = createSDKBridge({
    cwd: "/tmp/test-db0437",
    slug: "test-db0437",
    sessionManager: sm,
    send: function (msg) { sent.push(msg); },
    adapter: { vendor: "claude" },
    adapters: {},
  });
  return { bridge: bridge, sm: sm, sent: sent, sentToSession: sentToSession };
}

test("lr-db0437: setModel on a session with no active query writes session.model only, never sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: "sonnet" });
  var session = { localId: 1, queryInstance: null, model: null };

  await bridge.setModel(session, "opus");

  assert.strictEqual(session.model, "opus", "session.model must reflect the new choice");
  assert.strictEqual(sm.currentModel, "sonnet",
    "sm.currentModel (the project/global default) must be untouched by a per-session setModel call");
});

test("lr-db0437: setModel on a session with an active query writes session.model only, never sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: "haiku" });
  var setModelCalls = [];
  var session = {
    localId: 2,
    model: "sonnet",
    vendor: "claude",
    queryInstance: {
      setModel: function (model) { setModelCalls.push(model); return Promise.resolve(); },
    },
  };

  await bridge.setModel(session, "opus");

  assert.deepStrictEqual(setModelCalls, ["opus"], "the live query must still be told to switch model");
  assert.strictEqual(session.model, "opus");
  assert.strictEqual(sm.currentModel, "haiku",
    "sm.currentModel (the project/global default) must be untouched even when a live query is running");
});

test("lr-db0437: two sessions setting different models never bleed into each other via sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: null });
  var sessionA = { localId: 1, queryInstance: null, model: null };
  var sessionB = { localId: 2, queryInstance: null, model: null };

  await bridge.setModel(sessionA, "opus");
  await bridge.setModel(sessionB, "haiku");

  assert.strictEqual(sessionA.model, "opus");
  assert.strictEqual(sessionB.model, "haiku");
  assert.strictEqual(sm.currentModel, null,
    "no per-session setModel call should ever populate the shared project/global default");
});

// ---------------------------------------------------------------------------
// Effort, betas and thinking: the same session scope, through the real session
// manager, WS handlers and query builder (the prompt harness's project).
// ---------------------------------------------------------------------------

var path = require("path");
var world = require("./prompt-harness-world");

// The harness's session handlers reach a session's clients through a no-op
// sendToSession; this one delivers like the project does.
function handlersFor(server) {
  function sendToSession(id, obj) {
    server.clients.forEach(function (ws) {
      if (ws.readyState === 1 && ws._clagenticActiveSession === id) ws.send(JSON.stringify(obj));
    });
  }
  return require(world.LIB_ROOT + "/project-sessions").attachSessions(Object.assign({}, server.handlerContext, { sendToSession: sendToSession }));
}

// A second session in the project, ready to start a query.
function addSession(server) {
  var s = server.sm.createSessionRaw({});
  s.cliSessionId = "harness-second-" + path.basename(server.home);
  server.sm.saveSessionFile(s);
  return s;
}

// A connected, administrator client viewing `session`.
function viewer(server, session) {
  var c = world.client();
  c.ws._clagenticAuthenticated = true;
  c.ws._clagenticActiveSession = session.localId;
  server.clients.add(c.ws);
  return c;
}

function send(handlers, c, msg) {
  handlers.handleSessionsMessage(c.ws, msg);
  return world.flush();
}

function claudeOptions(server, index) {
  return server.queryOptions[index].adapterOptions.CLAUDE;
}

function configStates(c) {
  return c.inbox.filter(function (m) { return m.type === "config_state"; });
}

async function withTwoSessions(fn) {
  var server = await world.createServer();
  try {
    var other = addSession(server);
    var handlers = handlersFor(server);
    await fn({ server: server, handlers: handlers, a: server.session, b: other, ca: viewer(server, server.session), cb: viewer(server, other) });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

test("a beta one session turns on is in that session's query and in no other session's", async function () {
  await withTwoSessions(async function (w) {
    await send(w.handlers, w.ca, { type: "set_betas", betas: ["context-1m-test"] });
    await w.server.bridge.startQuery(w.b, "go", null, null);
    await w.server.bridge.startQuery(w.a, "go", null, null);
    await world.flush();
    assert.strictEqual(claudeOptions(w.server, 0).betas, undefined, "the other session's query carries no beta");
    assert.deepStrictEqual(claudeOptions(w.server, 1).betas, ["context-1m-test"], "the session that chose it does");
    assert.strictEqual(w.server.sm._savedDefaultBetas, undefined, "and no shared default was written");
  });
});

test("a new session starts from the saved defaults, never from another session's picks", async function () {
  await withTwoSessions(async function (w) {
    w.server.sm._savedDefaultEffort = "high";
    w.server.sm._savedDefaultBetas = ["default-beta"];
    w.server.sm._savedDefaultThinking = "adaptive";
    await send(w.handlers, w.ca, { type: "set_effort", effort: "low" });
    await send(w.handlers, w.ca, { type: "set_betas", betas: ["a-beta"] });
    await send(w.handlers, w.ca, { type: "set_thinking", thinking: "disabled" });

    var made = w.server.sm.createSessionRaw({});
    assert.strictEqual(made.effort, "high");
    assert.deepStrictEqual(made.betas, ["default-beta"]);
    assert.notStrictEqual(made.betas, w.server.sm._savedDefaultBetas, "a copy: editing it cannot edit the default");
    assert.strictEqual(made.thinking, "adaptive");
    assert.strictEqual(w.a.effort, "low", "the session that picked keeps its pick");

    var unset = w.server.sm.effectiveSessionSettings({});
    assert.strictEqual(unset.effort, "high", "a session with no value of its own shows the saved default");
  });
});

test("with no saved default anywhere the fallbacks apply", async function () {
  await withTwoSessions(async function (w) {
    var shown = w.server.sm.effectiveSessionSettings(w.b);
    assert.deepStrictEqual(shown, { effort: "medium", betas: [], thinking: "adaptive", thinkingBudget: 10000 });
  });
});

test("changing a default leaves a running session's values and its next query alone", async function () {
  await withTwoSessions(async function (w) {
    await send(w.handlers, w.cb, { type: "set_effort", effort: "low" });
    await send(w.handlers, w.cb, { type: "set_betas", betas: ["b-beta"] });
    await send(w.handlers, w.cb, { type: "set_thinking", thinking: "budget", budgetTokens: 3000 });
    await send(w.handlers, w.cb, { type: "set_project_default_effort", effort: "max" });
    await send(w.handlers, w.cb, { type: "set_server_default_betas", betas: ["server-beta"] });
    await send(w.handlers, w.cb, { type: "set_project_default_thinking", thinking: "disabled" });

    assert.strictEqual(w.b.effort, "low");
    assert.deepStrictEqual(w.b.betas, ["b-beta"]);
    assert.strictEqual(w.b.thinking, "budget");
    await w.server.bridge.startQuery(w.b, "go", null, null);
    await world.flush();
    assert.strictEqual(w.server.queryOptions[0].effort, "low");
    assert.deepStrictEqual(claudeOptions(w.server, 0).betas, ["b-beta"]);
    assert.deepStrictEqual(claudeOptions(w.server, 0).thinking, { type: "enabled", budgetTokens: 3000 });
  });
});

test("loop settings win over the session's values at query start", async function () {
  await withTwoSessions(async function (w) {
    await send(w.handlers, w.cb, { type: "set_effort", effort: "low" });
    await send(w.handlers, w.cb, { type: "set_betas", betas: ["session-beta"] });
    await send(w.handlers, w.cb, { type: "set_thinking", thinking: "disabled" });
    w.b.loopSettings = { effort: "max", betas: ["loop-beta"], thinking: "budget", thinkingBudget: 1500 };
    await w.server.bridge.startQuery(w.b, "go", null, null);
    await world.flush();
    assert.strictEqual(w.server.queryOptions[0].effort, "max");
    assert.deepStrictEqual(claudeOptions(w.server, 0).betas, ["loop-beta"]);
    assert.deepStrictEqual(claudeOptions(w.server, 0).thinking, { type: "enabled", budgetTokens: 1500 });
  });
});

test("effort, betas, thinking and prompt expiry survive a daemon restart and reach the next query", async function () {
  var first = await world.createServer();
  var home = first.home;
  try {
    var handlers = handlersFor(first);
    var c = viewer(first, first.session);
    await send(handlers, c, { type: "set_effort", effort: "low" });
    await send(handlers, c, { type: "set_betas", betas: ["kept-beta"] });
    await send(handlers, c, { type: "set_thinking", thinking: "budget", budgetTokens: 4096 });
    await send(handlers, c, { type: "set_session_prompt_expiry", promptExpiryMinutes: 7 });
    var meta = JSON.parse(require("fs").readFileSync(path.join(first.sm.sessionsDir, first.session.cliSessionId + ".jsonl"), "utf8").split("\n")[0]);
    assert.deepStrictEqual(
      { effort: meta.effort, betas: meta.betas, thinking: meta.thinking, thinkingBudget: meta.thinkingBudget, promptExpiryMinutes: meta.promptExpiryMinutes },
      { effort: "low", betas: ["kept-beta"], thinking: "budget", thinkingBudget: 4096, promptExpiryMinutes: 7 },
      "all five are in the meta line");
    var cliSessionId = first.session.cliSessionId;
    first.shutdown();

    var second = await world.createServer({ home: home, cliSessionId: cliSessionId });
    var s = second.session;
    assert.deepStrictEqual(
      { effort: s.effort, betas: s.betas, thinking: s.thinking, thinkingBudget: s.thinkingBudget, promptExpiryMinutes: s.promptExpiryMinutes },
      { effort: "low", betas: ["kept-beta"], thinking: "budget", thinkingBudget: 4096, promptExpiryMinutes: 7 });
    await second.startQuery();
    assert.strictEqual(second.queryOptions[0].effort, "low");
    assert.deepStrictEqual(claudeOptions(second, 0).betas, ["kept-beta"]);
    assert.deepStrictEqual(claudeOptions(second, 0).thinking, { type: "enabled", budgetTokens: 4096 });
    second.shutdown();
  } finally {
    world.removeHome(home);
  }
});

// What a client viewing session A receives while session B changes: nothing
// that carries B's values. One row per way B can change.
var B_CHANGES = [
  { name: "the effort picker", act: function (w) { return send(w.handlers, w.cb, { type: "set_effort", effort: "xhigh" }); }, value: function (m) { return m.effort === "xhigh"; } },
  { name: "the betas picker", act: function (w) { return send(w.handlers, w.cb, { type: "set_betas", betas: ["b-only-beta"] }); }, value: function (m) { return m.betas && m.betas.indexOf("b-only-beta") !== -1; } },
  { name: "the thinking picker", act: function (w) { return send(w.handlers, w.cb, { type: "set_thinking", thinking: "budget", budgetTokens: 7777 }); }, value: function (m) { return m.thinkingBudget === 7777; } },
  {
    name: "a worker's effort_changed event",
    act: async function (w) {
      w.server.adapter.createQuery = function (queryOpts) {
        w.server.queryOptions.push(queryOpts);
        var delivered = false;
        var handle = {
          _adapterState: null,
          pushMessage: function () {}, endInput: function () {}, close: function () {}, abort: function () {},
          setPermissionMode: function () { return Promise.resolve(); },
        };
        handle[Symbol.asyncIterator] = function () {
          return {
            next: function () {
              if (delivered) return new Promise(function () {});
              delivered = true;
              return Promise.resolve({ value: { type: "_worker_meta", subtype: "effort_changed", data: { effort: "xhigh" } }, done: false });
            },
          };
        };
        return Promise.resolve(handle);
      };
      await w.server.bridge.startQuery(w.b, "go", null, null);
      await world.flush();
      await world.flush();
    },
    value: function (m) { return m.effort === "xhigh"; },
  },
];

// The Codex approval policy, sandbox and web search are a session's own too:
// one row per setting, through the real handlers, session manager and bridge.
// `option` is the adapterOptions.CODEX field the Codex adapter reads.
var CODEX_ROWS = [
  { type: "set_codex_approval", key: "approval", field: "codexApproval", option: "approvalPolicy", value: "never", fallback: "on-request" },
  { type: "set_codex_sandbox", key: "sandbox", field: "codexSandbox", option: "sandboxMode", value: "danger-full-access", fallback: "workspace-write" },
  { type: "set_codex_websearch", key: "webSearch", field: "codexWebSearch", option: "webSearchMode", value: "disabled", fallback: "live" },
];

function codexOptions(server, index) {
  return server.queryOptions[index].adapterOptions.CODEX;
}

function codexConfigs(c) {
  return c.inbox.filter(function (m) { return m.type === "codex_config"; });
}

CODEX_ROWS.forEach(function (row) {
  test(row.type + ": the pick is in that session's query and its clients only, and no other session's", async function () {
    await withTwoSessions(async function (w) {
      await send(w.handlers, w.ca, Object.assign({ type: row.type }, { [row.key]: row.value }));
      await w.server.bridge.startQuery(w.b, "go", null, null);
      await w.server.bridge.startQuery(w.a, "go", null, null);
      await world.flush();
      assert.strictEqual(codexOptions(w.server, 0)[row.option], row.fallback, "the other session's query carries its own value");
      assert.strictEqual(codexOptions(w.server, 1)[row.option], row.value, "the session that chose it carries the pick");
      assert.ok(codexConfigs(w.ca).some(function (m) { return m[row.key] === row.value; }), "the session's viewer is told");
      assert.deepStrictEqual(codexConfigs(w.cb), [], "the other session's viewer is not");
      assert.strictEqual(w.server.sm.codexApproval, undefined, "no shared field holds it");
      assert.strictEqual(w.server.sm[row.field], undefined);
    });
  });

  test(row.type + ": the pick survives a daemon restart and reaches the next query", async function () {
    var first = await world.createServer();
    var home = first.home;
    try {
      var handlers = handlersFor(first);
      var c = viewer(first, first.session);
      await send(handlers, c, Object.assign({ type: row.type }, { [row.key]: row.value }));
      var meta = JSON.parse(require("fs").readFileSync(path.join(first.sm.sessionsDir, first.session.cliSessionId + ".jsonl"), "utf8").split("\n")[0]);
      assert.strictEqual(meta[row.field], row.value, "it is in the meta line");
      var cliSessionId = first.session.cliSessionId;
      first.shutdown();

      var second = await world.createServer({ home: home, cliSessionId: cliSessionId });
      assert.strictEqual(second.session[row.field], row.value, "it is read back at load");
      await second.startQuery();
      assert.strictEqual(codexOptions(second, 0)[row.option], row.value);
      second.shutdown();
    } finally {
      world.removeHome(home);
    }
  });
});

B_CHANGES.forEach(function (row) {
  test("a client viewing one session is sent none of another session's values: " + row.name, async function () {
    await withTwoSessions(async function (w) {
      await row.act(w);
      assert.ok(configStates(w.cb).some(row.value), "the session that changed is told");
      assert.deepStrictEqual(configStates(w.ca).filter(row.value), [], "the other session's viewer is not");
      configStates(w.ca).forEach(function (m) {
        assert.strictEqual(m.effort === undefined || m.effort === "medium", true, "any push it did get carries its own effort");
      });
    });
  });
});
