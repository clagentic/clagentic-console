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
//
// BOBBIE's follow-up nit (folded into the same PR, not filed separately --
// it closes this task's own stated root cause rather than merely relocating
// it): the base/admin split above was enforced only by developer discipline
// plus a code comment, not a structural guard -- a future author adding a
// field to the base tier that should be admin-tier would silently reopen
// this exposure class a third time (PR #403, then the original gap this
// task closed, then a hypothetical next). PROCESS_STATS_BASE_FIELD_KEYS
// (lib/project-sessions.js) is now the explicit allowlist the handler
// projects the base response through -- an unlisted key cannot reach a
// non-admin. The "exact key set" test below is what makes that fail LOUDLY
// (at test time) rather than silently: it asserts the real, non-admin
// response's key set equals the allowlist, so a field landing in rawBase
// without a deliberate allowlist update breaks this test immediately.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions, PROCESS_STATS_BASE_FIELD_KEYS } = require("../lib/project-sessions");

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

// Structural guard (BOBBIE nit, folded lr-2016fe): the base tier is no
// longer "whatever fields happen to be on statsResp when the admin branch
// hasn't run yet" -- it is PROCESS_STATS_BASE_FIELD_KEYS, an explicit
// allowlist the handler projects through. This asserts the real, non-admin
// response's key set is EXACTLY that allowlist -- not a superset, not a
// subset -- so a field silently added to the handler's raw base object
// without a deliberate allowlist update fails this test rather than
// shipping unreviewed.
test("process_stats: non-admin response key set is exactly PROCESS_STATS_BASE_FIELD_KEYS plus 'type' (structural allowlist guard)", function () {
  var stub = makeCtx();
  var responses = [];
  stub.ctx.sendTo = function (target, msg) { responses.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, { type: "process_stats" });

  var resp = responses[0];
  var actualKeys = Object.keys(resp).filter(function (k) { return k !== "type"; }).sort();
  var expectedKeys = PROCESS_STATS_BASE_FIELD_KEYS.slice().sort();
  assert.deepEqual(actualKeys, expectedKeys);
});

// Proves the guard actually bites: a handler that populated a stray
// admin-worthy field on the base object by hand (the exact failure mode
// BOBBIE flagged -- a future author adding a field to the wrong tier) would
// fail the "exact key set" test above. This test independently confirms
// the allowlist itself excludes the admin-tier field names, so even if a
// future edit added one of them to rawBase, the projection loop would drop
// it rather than forward it to a non-admin.
test("process_stats: PROCESS_STATS_BASE_FIELD_KEYS does not (and must not) contain any admin-tier diagnostic field name", function () {
  var adminOnlyFields = [
    "activeLiveCount",
    "maxConcurrentSessions",
    "activityDivergenceCount",
    "activityDivergenceRecentSamples",
  ];
  adminOnlyFields.forEach(function (field) {
    assert.equal(
      PROCESS_STATS_BASE_FIELD_KEYS.indexOf(field),
      -1,
      field + " must not be in the base-tier allowlist"
    );
  });
});
