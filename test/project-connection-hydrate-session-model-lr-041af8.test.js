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
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
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
