"use strict";
// Regression tests for lr-690b: commit dca60a7 (lr-ec2d) over-eagerly blocked
// switchSession() for no-auth / single-user connections by treating null
// _clayUser as "Access denied", which left ws._clayActiveSession unset and
// broke live message broadcast (doSendAndRecord filters on _clayActiveSession).
//
// 1. no-auth ws (null _clayUser) — switchSession must still bind _clayActiveSession
//    so live deltas reach the client without requiring a manual session round-trip.
// 2. multi-user ws whose user lacks access — must still be denied AND must NOT
//    bind _clayActiveSession (the multi-user gate must remain intact).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// Helpers: isolated session manager (mirrors session-lifecycle-lr-e0de.test.js)
// ---------------------------------------------------------------------------

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-690b-"));
}

function makeSessionManager(tmpHome, extraOpts) {
  // Bust require cache so a fresh instance picks up the temp CLAGENTIC_HOME.
  ["../lib/config", "../lib/sessions", "../lib/users", "../lib/utils",
   "../lib/store", "../lib/users-auth", "../lib/users-permissions",
   "../lib/users-preferences"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try {
    sessionsModule = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessionsModule.createSessionManager(Object.assign({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: null,   // single-ws mode by default; tests override as needed
  }, extraOpts || {}));
}

// ---------------------------------------------------------------------------
// Test 1 — no-auth connection (null _clayUser): _clayActiveSession must be set
// ---------------------------------------------------------------------------

test("lr-690b-1: switchSession binds _clayActiveSession for null _clayUser (no-auth)", function () {
  var tmpHome = makeTempHome();
  var errors = [];
  var sm = makeSessionManager(tmpHome, {
    sendTo: function (ws, msg) {
      if (msg && msg.type === "error") errors.push(msg);
    },
  });

  // The manager initialises with one session; grab its localId.
  var active = sm.getActiveSession();
  assert.ok(active, "session manager must have an initial active session");
  var localId = active.localId;

  // Simulate a no-auth WebSocket connection — _clayUser is null.
  var ws = { _clayUser: null, readyState: 1, send: function () {} };

  sm.switchSession(localId, ws);

  assert.equal(errors.length, 0,
    "null _clayUser must not produce an error in no-auth mode");
  assert.equal(ws._clayActiveSession, localId,
    "_clayActiveSession must be bound so live broadcast reaches this ws");
});

// ---------------------------------------------------------------------------
// Test 2 — authenticated user who lacks access: still denied, no binding
// ---------------------------------------------------------------------------

test("lr-690b-2: switchSession denies authenticated user without access and does not bind _clayActiveSession", function () {
  var tmpHome = makeTempHome();

  // We need sendTo + sendEach to exercise the multi-user path.
  var errors = [];
  var sm = makeSessionManager(tmpHome, {
    sendTo: function (ws, msg) {
      if (msg && msg.type === "error") errors.push(msg);
    },
    sendEach: function (fn) {
      // No connected clients in this test — just a no-op iterator.
    },
  });

  // Prime the session manager with a session owned by "owner-id".
  var session = sm.getActiveSession();
  assert.ok(session, "session manager must have an initial active session");
  session.ownerId = "owner-id";
  session.sessionVisibility = "private";
  var localId = session.localId;

  // Simulate a different authenticated user who should NOT have access.
  var ws = {
    _clayUser: { id: "other-user-id", role: "user" },
    readyState: 1,
    send: function () {},
  };
  // _clayActiveSession is deliberately absent / undefined before the call.

  sm.switchSession(localId, ws);

  assert.ok(errors.length > 0,
    "authenticated user lacking access must receive an error");
  assert.notEqual(ws._clayActiveSession, localId,
    "_clayActiveSession must NOT be bound when the user is denied");
});
