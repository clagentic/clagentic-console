"use strict";
/**
 * Regression tests for lr-f22787 FINDING 2 — silent failure on an invalid
 * model ID.
 *
 * Root cause: lib/project-sessions.js's "set_model" handler called
 * sdk.setModel(session, msg.model).then(...) with no branch for failure —
 * sdk.setModel used to always resolve (even when the underlying SDK
 * rejected the model switch, e.g. model_not_found), so an invalid or
 * unentitled custom model ID (the new free-text escape-hatch input added by
 * this same task) failed with zero user-visible signal, and the handler
 * still sent a `config_state` reply as if the switch had succeeded.
 *
 * Fixed in this diff:
 *   - lib/sdk-bridge.js's setModel() now returns { ok: true } or
 *     { ok: false, error } instead of resolving unconditionally.
 *   - lib/project-sessions.js's "set_model" handler branches on that result:
 *     on failure it sends a targeted `{ type: "error", text }` to the
 *     requesting client and returns before persisting/echoing config_state.
 *   - A rejection from sdk.setModel (defensive; not expected in practice
 *     since sdk-bridge.js's own try/catch converts rejections to
 *     { ok: false }) is still caught and surfaced, never swallowed.
 *
 * These tests drive attachSessions().handleSessionsMessage directly against
 * a minimal stub ctx/sm/sdk, following the harness pattern established by
 * test/project-sessions-model-scope-lr-db0437.test.js.
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
    currentEffort: "medium",
    currentBetas: [],
    currentThinking: "adaptive",
    currentThinkingBudget: 10000,
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
    cwd: "/tmp/test-f22787",
    slug: "test-f22787",
    osUsers: false,
    currentVersion: "0.0.0",
    sm: makeSessionManager(),
    sdk: { setModel: function () { return Promise.resolve({ ok: true }); } },
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

test("lr-f22787: a rejected custom model ID sends a targeted error to the requesting client, not a success config_state", async function () {
  var session = { localId: 1, model: "sonnet" };
  var savedSession;
  var ctx = makeCtx({
    getSessionForWs: function () { return session; },
  });
  ctx.sdk.setModel = function (s, model) {
    return Promise.resolve({ ok: false, error: "model_not_found: claude-opus-4-99" });
  };
  ctx.sm.saveSessionFile = function (s) { savedSession = s; };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_model", model: "claude-opus-4-99" });

  // The handler chain is async (.then off a resolved promise) — flush microtasks.
  await Promise.resolve();
  await Promise.resolve();

  assert.strictEqual(session.model, "sonnet", "session.model must not change on a rejected switch");
  assert.strictEqual(savedSession, undefined, "saveSessionFile must not be called on a rejected switch");

  var errorMsg = ctx._sentTo.find(function (entry) { return entry[1].type === "error"; });
  assert.ok(errorMsg, "expected a targeted error reply to the requesting client");
  assert.match(errorMsg[1].text, /model_not_found/);

  var configState = ctx._sentTo.find(function (entry) { return entry[1].type === "config_state"; });
  assert.strictEqual(configState, undefined, "must not send a success-shaped config_state reply after a rejected switch");
});

test("lr-f22787: a successful custom model ID still persists and replies with config_state (unchanged happy path)", async function () {
  var session = { localId: 1, model: "sonnet" };
  var savedSession;
  var ctx = makeCtx({
    getSessionForWs: function () { return session; },
  });
  ctx.sdk.setModel = function (s, model) {
    s.model = model;
    return Promise.resolve({ ok: true });
  };
  ctx.sm.saveSessionFile = function (s) { savedSession = s; };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_model", model: "claude-opus-4-6" });

  await Promise.resolve();
  await Promise.resolve();

  assert.strictEqual(session.model, "claude-opus-4-6");
  assert.strictEqual(savedSession, session, "saveSessionFile must be called on a successful switch");

  var configState = ctx._sentTo.find(function (entry) { return entry[1].type === "config_state"; });
  assert.ok(configState, "expected a targeted config_state reply");
  assert.strictEqual(configState[1].model, "claude-opus-4-6");

  var errorMsg = ctx._sentTo.find(function (entry) { return entry[1].type === "error"; });
  assert.strictEqual(errorMsg, undefined, "must not send an error reply on success");
});

test("lr-f22787: a rejected sdk.setModel promise (defensive path) is still caught and surfaced, never swallowed", async function () {
  var session = { localId: 1, model: "sonnet" };
  var ctx = makeCtx({
    getSessionForWs: function () { return session; },
  });
  ctx.sdk.setModel = function () {
    return Promise.reject(new Error("worker crashed mid-switch"));
  };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_model", model: "claude-opus-4-6" });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  var errorMsg = ctx._sentTo.find(function (entry) { return entry[1].type === "error"; });
  assert.ok(errorMsg, "expected a targeted error reply even when sdk.setModel itself rejects");
  assert.match(errorMsg[1].text, /worker crashed mid-switch/);
});
