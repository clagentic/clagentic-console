"use strict";
// Regression tests for lr-eb1a: three WS handlers lacked access-control gates.
//
// 3a. schedule_move: scheduledTasks permission required (was bypassed before
//     project-user-message.js gate due to short-circuit in project-sessions.js)
// 3b. set_session_visibility: canAccessSession required (sibling handlers
//     already had this gate; set_session_visibility did not)
// 3c. kill_process: admin-only in multi-user mode (isClaudeProcess check was
//     sufficient in single-user but allowed cross-user SIGTERM in multi-user)
//
// All tests drive the real attachSessions handler from project-sessions.js.
// Tests fail if the gates are removed.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");

// ---------------------------------------------------------------------------
// Shared ctx builder
// ---------------------------------------------------------------------------

function makeCtx(overrides) {
  overrides = overrides || {};

  var regularUser  = { id: "user-1", role: "user",  permissions: {} };
  var adminUser    = { id: "user-2", role: "admin", permissions: { scheduledTasks: true } };
  var otherSession = { localId: 99, ownerId: "user-9", sessionVisibility: "private" };
  var wsSession    = { localId: 1,  ownerId: "user-1", sessionVisibility: "private" };

  var killCalls = [];
  var moveCalls = [];
  var visCalls  = [];

  var ctx = Object.assign({
    cwd: "/tmp/test-eb1a", slug: "test", osUsers: false, currentVersion: "0.0.0",
    sm: {
      sessions: new Map([[1, wsSession], [99, otherSession]]),
      getActiveSession: function() { return wsSession; },
      broadcastSessionList: function() {},
      setSessionVisibility: function(id, vis) { visCalls.push({ id: id, vis: vis }); return { ok: true }; },
    },
    sdk: {
      stopTask: function() { return Promise.resolve(); },
      isClaudeProcess: function() { return true; },  // always claims valid claude proc
    },
    tm: null, clients: [], opts: {},
    send: function() {},
    sendTo: function() {},
    sendToAdmins: function() {},
    sendToSession: function() {},
    sendToSessionOthers: function() {},
    usersModule: {
      isMultiUser: function() { return true; },   // default: multi-user mode
      canAccessSession: function(userId, session) {
        // user can access their own session only
        return session.ownerId === userId;
      },
      getUserPermission: function(user, perm) {
        return user && user.permissions && !!user.permissions[perm];
      },
      // schedule_move uses getEffectivePermissions (returns permissions object)
      getEffectivePermissions: function(user) {
        return user ? (user.permissions || {}) : {};
      },
    },
    userPresence: null, pushModule: null,
    getSessionForWs: function(ws) { return ws._session || null; },
    getLinuxUserForSession: function() { return null; },
    ensureProjectAccessForSession: function() { return true; },
    getOsUserInfoForWs: function() { return null; },
    hydrateImageRefs: function(o) { return o; },
    onProcessingChanged: function() {},
    broadcastPresence: function() {},
    adapter: null,
    getProjectList: function() { return []; },
    getProjectCount: function() { return 0; },
    getScheduleCount: function() { return 0; },
    moveScheduleToProject: function(args) { moveCalls.push(args); },
  }, overrides);

  return {
    ctx: ctx,
    regularUser: regularUser,
    adminUser: adminUser,
    wsSession: wsSession,
    otherSession: otherSession,
    killCalls: killCalls,
    moveCalls: moveCalls,
    visCalls: visCalls,
  };
}

// ---------------------------------------------------------------------------
// 3a — schedule_move: scheduledTasks permission gate
// ---------------------------------------------------------------------------

test("3a: schedule_move denied for user without scheduledTasks permission", function() {
  var stub = makeCtx();
  // regularUser has no scheduledTasks permission
  stub.ctx.usersModule.getEffectivePermissions = function(user) {
    return user && user.permissions ? user.permissions : {};
  };
  var errors = [];
  stub.ctx.sendTo = function(ws, msg) { if (msg.type === "error") errors.push(msg); };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };  // regularUser: { permissions: {} }
  h.handleSessionsMessage(ws, {
    type: "schedule_move",
    recordId: "sched-1",
    fromSlug: "proj-1",
    toSlug: "proj-2",
  });

  assert.equal(stub.moveCalls.length, 0,
    "moveScheduleToProject must not be called without scheduledTasks permission");
  assert.ok(errors.length > 0, "non-permitted user should receive an error");
});

test("3a: schedule_move allowed for user with scheduledTasks permission", function() {
  var stub = makeCtx();
  stub.ctx.usersModule.getEffectivePermissions = function(user) {
    return user && user.permissions ? user.permissions : {};
  };
  var moveCalls = [];
  stub.ctx.moveScheduleToProject = function() { moveCalls.push(true); return { ok: true }; };

  // Stub getHubSchedules (used in the ok branch)
  stub.ctx.getHubSchedules = function() { return []; };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.adminUser };  // adminUser: { permissions: { scheduledTasks: true } }
  h.handleSessionsMessage(ws, {
    type: "schedule_move",
    recordId: "sched-1",
    fromSlug: "proj-1",
    toSlug: "proj-2",
  });

  assert.equal(moveCalls.length, 1,
    "moveScheduleToProject should be called when scheduledTasks permission is granted");
});

// ---------------------------------------------------------------------------
// 3b — set_session_visibility: canAccessSession gate
// ---------------------------------------------------------------------------

test("3b: set_session_visibility denied for user who cannot access target session", function() {
  var stub = makeCtx();
  var errors = [];
  stub.ctx.sendTo = function(ws, msg) { if (msg.type === "error") errors.push(msg); };
  // regular user (user-1) trying to change otherSession (owned by user-9)
  stub.ctx.usersModule.canAccessSession = function(userId, session) {
    return session.ownerId === userId;
  };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, {
    type: "set_session_visibility",
    sessionId: 99,         // otherSession.localId
    visibility: "shared",
  });

  assert.equal(stub.visCalls.length, 0,
    "setSessionVisibility must not be called for a session the user cannot access");
});

test("3b: set_session_visibility allowed for user who owns the session", function() {
  var stub = makeCtx();
  stub.ctx.usersModule.canAccessSession = function(userId, session) {
    return session.ownerId === userId;
  };

  var h = attachSessions(stub.ctx);
  var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
  h.handleSessionsMessage(ws, {
    type: "set_session_visibility",
    sessionId: 1,          // wsSession.localId — owned by regularUser
    visibility: "shared",
  });

  assert.equal(stub.visCalls.length, 1,
    "setSessionVisibility should proceed when user owns the session");
  assert.equal(stub.visCalls[0].vis, "shared");
});

// ---------------------------------------------------------------------------
// 3c — kill_process: admin-only in multi-user mode
// ---------------------------------------------------------------------------

test("3c: kill_process denied for non-admin in multi-user mode", function() {
  var killed = [];
  var errors = [];
  // Patch process.kill to spy without actually killing anything
  var origKill = process.kill.bind(process);
  process.kill = function(pid, sig) { killed.push({ pid: pid, sig: sig }); };

  var stub = makeCtx();
  stub.ctx.sendTo = function(ws, msg) { if (msg.type === "error") errors.push(msg); };

  try {
    var h = attachSessions(stub.ctx);
    var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
    h.handleSessionsMessage(ws, { type: "kill_process", pid: 99999 });

    assert.equal(killed.length, 0,
      "process.kill must not be called for non-admin in multi-user mode");
    assert.ok(errors.length > 0,
      "non-admin should receive an error response");
  } finally {
    process.kill = origKill;
  }
});

test("3c: kill_process allowed for admin in multi-user mode", function() {
  var killed = [];
  var origKill = process.kill.bind(process);
  process.kill = function(pid, sig) { killed.push({ pid: pid, sig: sig }); };

  var stub = makeCtx();
  stub.ctx.sdk.isClaudeProcess = function() { return true; };

  try {
    var h = attachSessions(stub.ctx);
    var ws = { _session: stub.wsSession, _clayUser: stub.adminUser };
    h.handleSessionsMessage(ws, { type: "kill_process", pid: 99999 });

    assert.equal(killed.length, 1,
      "process.kill should be called when admin issues kill_process");
    assert.equal(killed[0].pid, 99999);
    assert.equal(killed[0].sig, "SIGTERM");
  } finally {
    process.kill = origKill;
  }
});

test("3c: kill_process allowed in single-user mode (no auth required)", function() {
  var killed = [];
  var origKill = process.kill.bind(process);
  process.kill = function(pid, sig) { killed.push({ pid: pid, sig: sig }); };

  var stub = makeCtx();
  // Single-user mode
  stub.ctx.usersModule.isMultiUser = function() { return false; };
  stub.ctx.sdk.isClaudeProcess = function() { return true; };

  try {
    var h = attachSessions(stub.ctx);
    var ws = { _session: stub.wsSession, _clayUser: stub.regularUser };
    h.handleSessionsMessage(ws, { type: "kill_process", pid: 99999 });

    assert.equal(killed.length, 1,
      "kill_process should work without auth in single-user mode");
  } finally {
    process.kill = origKill;
  }
});
