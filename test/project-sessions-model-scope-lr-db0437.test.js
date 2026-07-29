"use strict";
/**
 * Regression tests for lr-db0437: per-session model choice silently became
 * the de-facto project default for all future sessions, and changing a
 * project/server default silently retargeted whatever session happened to
 * be focused ("reverse bleed").
 *
 * Root causes covered here (see lib/sdk-bridge.js setModel and
 * lib/project-sessions.js new_session / set_project_default_model /
 * set_server_default_model for the full fix + comments):
 *
 *   (a)+(b) new_session used to seed a brand-new session's model from
 *       sm.currentModel — a field also mutated by any OTHER session's
 *       setModel call — so session A picking model X leaked into session B
 *       on creation. Fixed: new_session now seeds from
 *       sm._savedDefaultModel, the actual saved project/global default,
 *       which setModel (session-scoped) never touches.
 *
 *   (c) set_project_default_model / set_server_default_model used to call
 *       sdk.setModel(session, msg.model) on the currently-focused session,
 *       silently changing its live model as a side effect of changing the
 *       default. Fixed: these handlers now only update sm.currentModel /
 *       sm._savedDefaultModel (the default), never session.model.
 *
 * These tests drive attachSessions().handleSessionsMessage directly against
 * a minimal stub ctx/sm/sdk, following the harness pattern established by
 * test/project-sessions-remove-project-lr-fc2818.test.js.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");

function makeSessionManager(overrides) {
  var sessions = new Map();
  return Object.assign({
    sessions: sessions,
    currentModel: null,
    _savedDefaultModel: null,
    currentPermissionMode: "default",
    _savedDefaultMode: "default",
    createSession: function (sessionOpts, targetWs) {
      var localId = sessions.size + 1;
      var session = { localId: localId, model: null, permissionMode: null };
      sessions.set(localId, session);
      return session;
    },
    saveSessionFile: function () {},
  }, overrides);
}

function makeCtx(overrides) {
  var sent = [];
  var sentTo = [];
  var noop = function () {};

  var ctx = Object.assign({
    cwd: "/tmp/test-db0437",
    slug: "test-db0437",
    osUsers: false,
    currentVersion: "0.0.0",
    sm: makeSessionManager(),
    sdk: { setModel: function () { return Promise.resolve(); } },
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (msg) { sent.push(msg); },
    sendTo: function (ws, msg) { sent.push(msg); sentTo.push([ws, msg]); },
    sendToAdmins: noop,
    sendToSession: noop,
    sendToSessionOthers: noop,
    opts: {},
    usersModule: { getEffectivePermissions: function () { return {}; } },
    userPresence: { setPresence: noop },
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: noop,
    broadcastPresence: noop,
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: noop,
    moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; },
    fetchVersion: noop,
    isNewer: function () { return false; },
    onCreateWorktree: null,
    IGNORED_DIRS: new Set(),
    scheduleMessage: noop,
    cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; },
    setLatestVersion: noop,
  }, overrides);

  ctx._sent = sent;
  ctx._sentTo = sentTo;
  return ctx;
}

function makeWs() {
  return { readyState: 1, send: function () {} };
}

test("lr-db0437: a new session does not inherit another session's live model choice", function () {
  var ctx = makeCtx();
  var sessions = attachSessions(ctx);

  // sm._savedDefaultModel is the real saved default (untouched); sm.currentModel
  // simulates another session having picked "opus" without that becoming the
  // default (this is exactly what setModel now does — see sdk-bridge.js).
  ctx.sm._savedDefaultModel = "sonnet";
  ctx.sm.currentModel = "opus";

  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "new_session" });

  var newSession = ctx.sm.sessions.get(1);
  assert.ok(newSession, "expected a new session to be created");
  assert.strictEqual(newSession.model, "sonnet",
    "new session must seed from the saved project/global default, not from another session's live model choice");
});

test("lr-db0437: set_project_default_model does not mutate the focused session's live model", function () {
  var focusedSession = { localId: 1, model: "sonnet" };
  var ctx = makeCtx({
    getSessionForWs: function () { return focusedSession; },
  });
  var setModelCalls = [];
  ctx.sdk.setModel = function (session, model) {
    setModelCalls.push([session, model]);
    return Promise.resolve();
  };
  ctx.opts.onSetProjectDefaultModel = function (slug, model) {
    ctx.opts._lastProjectDefault = model;
  };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_project_default_model", model: "opus" });

  assert.strictEqual(focusedSession.model, "sonnet",
    "changing the project default must not change the focused session's own model");
  assert.strictEqual(ctx.sm.currentModel, "opus", "the default cache must reflect the new default");
  assert.strictEqual(ctx.sm._savedDefaultModel, "opus", "the saved default must reflect the new default");
  assert.deepStrictEqual(setModelCalls, [], "sdk.setModel must never be called from a default-model handler");

  var configState = ctx._sent.find(function (m) { return m.type === "config_state"; });
  assert.ok(configState, "expected a config_state broadcast");
  assert.strictEqual(configState.model, "opus");
});

test("lr-db0437: set_server_default_model does not mutate the focused session's live model", function () {
  var focusedSession = { localId: 1, model: "haiku" };
  var ctx = makeCtx({
    getSessionForWs: function () { return focusedSession; },
  });
  var setModelCalls = [];
  ctx.sdk.setModel = function (session, model) {
    setModelCalls.push([session, model]);
    return Promise.resolve();
  };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_server_default_model", model: "opus" });

  assert.strictEqual(focusedSession.model, "haiku",
    "changing the server default must not change the focused session's own model");
  assert.strictEqual(ctx.sm.currentModel, "opus");
  assert.strictEqual(ctx.sm._savedDefaultModel, "opus");
  assert.deepStrictEqual(setModelCalls, [], "sdk.setModel must never be called from a default-model handler");
});
