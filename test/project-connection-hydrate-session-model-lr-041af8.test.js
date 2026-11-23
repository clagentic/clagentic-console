"use strict";
/**
 * Regression test for lr-041af8 (MILLER diagnosis): operator picked
 * "opus 4.7" in a session, the session DEMONSTRABLY RAN on it (persisted to
 * disk correctly per lr-db0437), but the text-bar model chip kept showing
 * "sonnet" (the project default) after any reconnect / page load. A
 * display-only defect: the connect/hydration path in
 * lib/project-connection.js (model_info + config_state, and separately
 * session_switched) hydrated every client from the shared sm.currentModel
 * (project/global default) instead of the resolved active session's own
 * .model — even though the resolved session (restoredActive / active) is
 * already known at that point in handleConnection().
 *
 * lr-db0437 fixed the WRITE side of this exact shared-mutable-state class
 * (setModel session-only write) but never enumerated the SENDERS that
 * hydrate clients from that state — this is the second half, MILLER's
 * loop_class: double.
 *
 * This test drives the real attachConnection() + createSessionManager()
 * code paths (no reimplementation), following the pattern established by
 * test/project-connection-ownership-claim-lr-768c9e.test.js.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-041af8-"));
}

// Same module-cache/env-var race guard as the lr-768c9e connection test
// (project-connection.js and its transitive requires freeze CONFIG_DIR-
// derived paths at first require).
var REQUIRE_CACHE_MODULES = [
  "../lib/config", "../lib/sessions", "../lib/users", "../lib/utils",
  "../lib/store", "../lib/users-auth", "../lib/users-permissions",
  "../lib/users-preferences", "../lib/user-presence", "../lib/lite-detect",
  "../lib/project-connection",
];

function bustRequireCache() {
  REQUIRE_CACHE_MODULES.forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
}

function makeModules(tmpHome) {
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule, connModule;
  try {
    sessionsModule = require("../lib/sessions");
    connModule = require("../lib/project-connection");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return { sessionsModule: sessionsModule, connModule: connModule };
}

function makeConnectionCtx(overrides) {
  return Object.assign({
    cwd: overrides.cwd,
    slug: "test-project",
    isMate: false,
    osUsers: false,
    debug: false,
    dangerouslySkipPermissionsConfigured: false,
    currentVersion: "0.0.0",
    lanHost: null,
    clients: new Set(),
    send: function () {},
    sendTo: function () {},
    opts: {},
    loopState: {},
    loopRegistry: {},
    _loop: {
      loopState: {},
      loopRegistry: {},
      resumeLoop: function () {},
      sendConnectionState: function () {},
    },
    _mcp: null,
    _notifications: null,
    hydrateImageRefs: function (o) { return o; },
    broadcastClientCount: function () {},
    broadcastPresence: function () {},
    getProjectList: function () { return []; },
    getHubSchedules: function () { return []; },
    loadContextSources: function () { return []; },
    stopFileWatch: function () {},
    stopAllDirWatches: function () {},
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: function () {},
    getLatestVersion: function () { return null; },
    getTitle: function () { return "Test Project"; },
    getProject: function () { return "test-project"; },
    warmup: null,
  }, overrides);
}

test("lr-041af8: reconnect hydrates model_info/config_state/session_switched from the restored session's own model, not the shared project default", function () {
  var tmpHome = makeTempHome();
  try {
    bustRequireCache();
    var mods = makeModules(tmpHome);
    var sm = mods.sessionsModule.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: null,
    });

    // Simulate the project/global default being "sonnet" (what a fresh
    // daemon/project would have as sm.currentModel) while THIS session
    // separately picked "claude-opus-4-7" and it was persisted (lr-db0437).
    sm.currentModel = "sonnet";

    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-lr-041af8";
    session.model = "claude-opus-4-7";
    sm.sendAndRecord(session, { type: "user_message", text: "hello" });
    sm.saveSessionFile(session);

    var sendToCalls = [];
    var ctx = makeConnectionCtx({
      cwd: tmpHome,
      sm: sm,
      tm: { list: function () { return []; } },
      nm: { list: function () { return []; } },
      sendTo: function (ws, msg) { sendToCalls.push(msg); },
    });

    var attachment = mods.connModule.attachConnection(ctx);
    var ws = { on: function () {}, readyState: 1, send: function () {} };

    // No stored presence for this ws/user — findRestoredActiveSession falls
    // back to "most recently active session", which is this one (the only
    // session in this project).
    attachment.handleConnection(ws, null, function () {}, function () {});

    var modelInfo = sendToCalls.find(function (m) { return m.type === "model_info"; });
    assert.ok(modelInfo, "expected a model_info message on connect");
    assert.strictEqual(modelInfo.model, "claude-opus-4-7",
      "model_info on connect must reflect the restored session's own model, not sm.currentModel (the project default)");

    var configState = sendToCalls.find(function (m) { return m.type === "config_state"; });
    assert.ok(configState, "expected a config_state message on connect");
    assert.strictEqual(configState.model, "claude-opus-4-7",
      "config_state on connect must reflect the restored session's own model, not sm.currentModel");

    var switched = sendToCalls.find(function (m) { return m.type === "session_switched"; });
    assert.ok(switched, "expected a session_switched message on connect");
    assert.strictEqual(switched.model, "claude-opus-4-7",
      "session_switched must carry the session's own model field so hydration doesn't need a separate round-trip");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-041af8: reconnect falls back to the project default only when the restored session never picked its own model", function () {
  var tmpHome = makeTempHome();
  try {
    bustRequireCache();
    var mods = makeModules(tmpHome);
    var sm = mods.sessionsModule.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: null,
    });

    sm.currentModel = "sonnet";

    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-lr-041af8-nodel";
    // session.model deliberately left unset.
    sm.sendAndRecord(session, { type: "user_message", text: "hello" });
    sm.saveSessionFile(session);

    var sendToCalls = [];
    var ctx = makeConnectionCtx({
      cwd: tmpHome,
      sm: sm,
      tm: { list: function () { return []; } },
      nm: { list: function () { return []; } },
      sendTo: function (ws, msg) { sendToCalls.push(msg); },
    });

    var attachment = mods.connModule.attachConnection(ctx);
    var ws = { on: function () {}, readyState: 1, send: function () {} };
    attachment.handleConnection(ws, null, function () {}, function () {});

    var configState = sendToCalls.find(function (m) { return m.type === "config_state"; });
    assert.ok(configState, "expected a config_state message on connect");
    assert.strictEqual(configState.model, "sonnet",
      "a session with no model of its own must fall back to the project/global default, not an empty string");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// The same split for effort, betas and thinking: a reconnect shows the restored
// session's own values, and the saved defaults only for a session with none.
[
  {
    name: "a session's own effort, betas and thinking",
    own: { effort: "low", betas: ["own-beta"], thinking: "budget", thinkingBudget: 2048, codexApproval: "never", codexSandbox: "read-only", codexWebSearch: "cached" },
    expect: { effort: "low", betas: ["own-beta"], thinking: "budget", thinkingBudget: 2048 },
    codex: { approval: "never", sandbox: "read-only", webSearch: "cached" },
  },
  {
    name: "the saved defaults for a session that never chose",
    own: {},
    expect: { effort: "high", betas: ["default-beta"], thinking: "disabled", thinkingBudget: 10000 },
    codex: { approval: "on-request", sandbox: "danger-full-access", webSearch: "disabled" },
  },
].forEach(function (row) {
  test("reconnect hydrates config_state with " + row.name, function () {
    var tmpHome = makeTempHome();
    try {
      bustRequireCache();
      var mods = makeModules(tmpHome);
      var sm = mods.sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null });
      sm._savedDefaultEffort = "high";
      sm._savedDefaultBetas = ["default-beta"];
      sm._savedDefaultThinking = "disabled";
      sm._savedDefaultCodexApproval = "on-request";
      sm._savedDefaultCodexSandbox = "danger-full-access";
      sm._savedDefaultCodexWebSearch = "disabled";
      var session = sm.createSessionRaw({});
      session.cliSessionId = "sess-config-hydrate";
      // The saved defaults were not set yet when the session was made, as for a
      // session loaded from a file saved before they existed.
      delete session.effort; delete session.betas; delete session.thinking; delete session.thinkingBudget;
      delete session.codexApproval; delete session.codexSandbox; delete session.codexWebSearch;
      Object.assign(session, row.own);
      sm.sendAndRecord(session, { type: "user_message", text: "hello" });
      sm.saveSessionFile(session);

      var sendToCalls = [];
      var ctx = makeConnectionCtx({
        cwd: tmpHome,
        sm: sm,
        tm: { list: function () { return []; } },
        nm: { list: function () { return []; } },
        sendTo: function (ws, msg) { sendToCalls.push(msg); },
      });
      mods.connModule.attachConnection(ctx).handleConnection({ on: function () {}, readyState: 1, send: function () {} }, null, function () {}, function () {});

      var state = sendToCalls.find(function (m) { return m.type === "config_state"; });
      assert.ok(state, "expected a config_state message on connect");
      assert.deepStrictEqual(
        { effort: state.effort, betas: state.betas, thinking: state.thinking, thinkingBudget: state.thinkingBudget },
        row.expect);
      var codex = sendToCalls.find(function (m) { return m.type === "codex_config"; });
      assert.ok(codex, "expected a codex_config message on connect");
      assert.deepStrictEqual({ approval: codex.approval, sandbox: codex.sandbox, webSearch: codex.webSearch }, row.codex,
        "the restored session's own Codex values, else the saved defaults");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// The Settings pickers show the saved defaults, which a connecting client is
// sent from the stores the daemon keeps (so after a restart they are the ones
// set before), whatever the restored session holds.
test("reconnect sends the saved server and project defaults, not the restored session's values", function () {
  var tmpHome = makeTempHome();
  try {
    bustRequireCache();
    var mods = makeModules(tmpHome);
    var sm = mods.sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null });
    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-saved-defaults";
    Object.assign(session, { model: "haiku", effort: "low", betas: ["own-beta"], thinking: "disabled" });
    sm.sendAndRecord(session, { type: "user_message", text: "hello" });
    sm.saveSessionFile(session);

    var sendToCalls = [];
    var ctx = makeConnectionCtx({
      cwd: tmpHome,
      sm: sm,
      tm: { list: function () { return []; } },
      nm: { list: function () { return []; } },
      sendTo: function (ws, msg) { sendToCalls.push(msg); },
      opts: {
        onGetServerDefaultModel: function () { return { model: "sonnet" }; },
        onGetProjectDefaultModel: function () { return { model: "opus" }; },
        onGetServerDefaultEffort: function () { return { effort: "high" }; },
        onGetProjectDefaultEffort: function () { return { effort: null }; },
        onGetServerDefaultBetas: function () { return { betas: ["server-beta"] }; },
        onGetProjectDefaultBetas: function () { return { betas: [] }; },
        onGetServerDefaultThinking: function () { return { thinking: "budget", thinkingBudget: 4096 }; },
        onGetProjectDefaultThinking: function () { return { thinking: null, thinkingBudget: null }; },
        onGetServerDefaultMode: function () { return { mode: "acceptEdits" }; },
        onGetProjectDefaultMode: function () { return { mode: null }; },
        onGetServerDefaultCodex: function () { return { approval: "never", sandbox: null, webSearch: null }; },
        onGetProjectDefaultCodex: function () { return { approval: null, sandbox: "read-only", webSearch: null }; },
      },
    });
    mods.connModule.attachConnection(ctx).handleConnection({ on: function () {}, readyState: 1, send: function () {} }, null, function () {}, function () {});

    var saved = sendToCalls.find(function (m) { return m.type === "saved_defaults"; });
    assert.ok(saved, "expected a saved_defaults message on connect");
    assert.deepStrictEqual(saved.server, { model: "sonnet", mode: "acceptEdits", effort: "high", betas: ["server-beta"], thinking: "budget", thinkingBudget: 4096, codexApproval: "never", codexSandbox: null, codexWebSearch: null });
    assert.deepStrictEqual(saved.project, { model: "opus", mode: null, effort: null, betas: [], thinking: null, thinkingBudget: null, codexApproval: null, codexSandbox: "read-only", codexWebSearch: null });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// A reconnect hydrates through the same session_switched builder as a switch,
// so its vendor source tells an unreadable meta (shown neutral by the client)
// from a recorded vendor.
[
  { name: "a session whose meta cannot be read is sent as error with no vendor", meta: "{not json", vendor: null, vendorSource: "error" },
  { name: "a session whose meta records a vendor is sent as present", meta: null, vendor: "codex", vendorSource: "present" },
].forEach(function (row) {
  test("session_switched on reconnect: " + row.name, function () {
    var tmpHome = makeTempHome();
    try {
      bustRequireCache();
      var mods = makeModules(tmpHome);
      var sm = mods.sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null });
      var session = sm.createSessionRaw({});
      session.cliSessionId = "sess-vendor-source";
      if (row.vendor) session.vendor = row.vendor;
      sm.sendAndRecord(session, { type: "user_message", text: "hello" });
      sm.saveSessionFile(session);
      if (row.meta) {
        var file = fs.readdirSync(tmpHome, { recursive: true }).filter(function (f) { return f.endsWith("sess-vendor-source.jsonl"); })[0];
        fs.writeFileSync(path.join(tmpHome, file), row.meta + "\n");
        session.vendor = null;
      }

      var sendToCalls = [];
      var ctx = makeConnectionCtx({
        cwd: tmpHome,
        sm: sm,
        tm: { list: function () { return []; } },
        nm: { list: function () { return []; } },
        sendTo: function (ws, msg) { sendToCalls.push(msg); },
      });
      var attachment = mods.connModule.attachConnection(ctx);
      attachment.handleConnection({ on: function () {}, readyState: 1, send: function () {} }, null, function () {}, function () {});

      var switched = sendToCalls.find(function (m) { return m.type === "session_switched"; });
      assert.ok(switched, "expected a session_switched message on connect");
      assert.strictEqual(switched.vendor, row.vendor);
      assert.strictEqual(switched.vendorSource, row.vendorSource);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
