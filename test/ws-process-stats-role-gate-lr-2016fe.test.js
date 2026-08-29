"use strict";
// Regression tests for lr-2016fe: the process_stats WS handler had no
// auth/role gate at all, unlike its update_now/kill_process siblings in the
// same file (lib/project-sessions.js).
//
// The fix is NOT a blanket admin gate: enumeration (app-panels.js's
// requestProcessStats/updateStatusPanel and server-settings.js's
// requestStats/updateSettingsStats) showed the `/status` panel and the
// Settings "Server Status" card are non-admin-gated UI, open to any
// authenticated user, and both consume the base fields (pid, uptime,
// memory, sessions, processing, clients, terminals). A blanket admin gate
// would break those existing non-admin consumers.
//
// Instead, only the daemon-wide diagnostic subgroup sourced from
// sdk.getMemoryStats() (activeLiveCount, maxConcurrentSessions,
// activityDivergenceCount, activityDivergenceRecentSamples) -- the fields
// documented as module-scope/cross-project and the ones a future author is
// most likely to enrich with per-session identifying data (as already
// happened once in PR #403) -- is restricted to admins. Base fields are
// still sent to every authenticated caller.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");

function makeCtx(overrides) {
  overrides = overrides || {};

  var regularUser = { id: "user-1", role: "user", permissions: {} };
  var adminUser = { id: "user-2", role: "admin", permissions: {} };
  var wsSession = { localId: 1, ownerId: "user-1", sessionVisibility: "private", isProcessing: false };

  var memStatsCallCount = 0;

  var ctx = Object.assign({
    cwd: "/tmp/test-2016fe", slug: "test", osUsers: false, currentVersion: "0.0.0",
    sm: {
      sessions: new Map([[1, wsSession]]),
      getActiveSession: function () { return wsSession; },
      broadcastSessionList: function () {},
    },
    sdk: {
      getMemoryStats: function () {
        memStatsCallCount++;
        return {
          activeLiveCount: 3,
          maxConcurrentSessions: 50,
          activityDivergenceCount: 2,
          activityDivergenceRecentSamples: [
            { ts: 12345, rawIsProcessing: true, derivedIsActive: false, hasQueryInstance: true },
          ],
        };
      },
    },
    tm: { list: function () { return []; } },
    clients: new Map(),
    opts: {},
    send: function () {},
    sendTo: function () {},
    sendToAdmins: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    usersModule: {
      isMultiUser: function () { return true; },
      canAccessSession: function (userId, session) { return session.ownerId === userId; },
      getUserPermission: function (user, perm) { return user && user.permissions && !!user.permissions[perm]; },
      getEffectivePermissions: function (user) { return user ? (user.permissions || {}) : {}; },
    },
    userPresence: null, pushModule: null,
    getSessionForWs: function (ws) { return ws._session || null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return true; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: function () {},
    broadcastPresence: function () {},
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
  }, overrides);

  return {
    ctx: ctx,
    regularUser: regularUser,
    adminUser: adminUser,
    wsSession: wsSession,
    getMemStatsCallCount: function () { return memStatsCallCount; },
  };
}

test("process_stats: non-admin does not receive activeLiveCount/maxConcurrentSessions/activityDivergence* fields", function () {
  var stub = makeCtx();
  var responses = [];
  stub.ctx.sendTo = function (target, msg) { responses.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  assert.equal(responses.length, 1, "should send exactly one process_stats reply");
  var resp = responses[0];
  assert.equal(resp.type, "process_stats");

  assert.equal(resp.activeLiveCount, undefined, "non-admin must not receive activeLiveCount");
  assert.equal(resp.maxConcurrentSessions, undefined, "non-admin must not receive maxConcurrentSessions");
  assert.equal(resp.activityDivergenceCount, undefined, "non-admin must not receive activityDivergenceCount");
  assert.equal(resp.activityDivergenceRecentSamples, undefined, "non-admin must not receive activityDivergenceRecentSamples (this is the field that carried session ids pre-lr-58c813)");
});

test("process_stats: non-admin STILL receives the base fields the /status panel and Settings overview card need", function () {
  var stub = makeCtx();
  var responses = [];
  stub.ctx.sendTo = function (target, msg) { responses.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  var resp = responses[0];
  assert.equal(typeof resp.pid, "number");
  assert.equal(typeof resp.uptime, "number");
  assert.ok(resp.memory && typeof resp.memory.rss === "number");
  assert.equal(resp.sessions, 1);
  assert.equal(resp.processing, 0);
  assert.equal(typeof resp.clients, "number");
  assert.equal(typeof resp.terminals, "number");
});

test("process_stats: admin DOES receive the diagnostic fields", function () {
  var stub = makeCtx();
  var responses = [];
  stub.ctx.sendTo = function (target, msg) { responses.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.adminUser };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  var resp = responses[0];
  assert.equal(resp.activeLiveCount, 3);
  assert.equal(resp.maxConcurrentSessions, 50);
  assert.equal(resp.activityDivergenceCount, 2);
  assert.equal(resp.activityDivergenceRecentSamples.length, 1);
});

test("process_stats: unauthenticated caller (no _clayUser) does not receive diagnostic fields either", function () {
  var stub = makeCtx();
  var responses = [];
  stub.ctx.sendTo = function (target, msg) { responses.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: null };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  var resp = responses[0];
  assert.equal(resp.activeLiveCount, undefined);
  assert.equal(resp.activityDivergenceRecentSamples, undefined);
});

test("process_stats: sdk.getMemoryStats() is not called at all for a non-admin caller (no wasted work fetching data that will be dropped)", function () {
  var stub = makeCtx();
  stub.ctx.sendTo = function () {};

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  assert.equal(stub.getMemStatsCallCount(), 0);
});
