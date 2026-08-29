"use strict";
// Regression coverage for lr-c4da07: lib/server.js's getAllProjectSessions()
// fed the Home Hub's hub_recent_sessions_list with ONLY a `!s.hidden` filter
// — no per-project access gate, no sessionVisibility === "private" filter.
// Found by BOBBIE during the PR #386 security audit, verified by holden
// (comment #1). Root cause: the function took no userId parameter at all, so
// user identity never reached it, unlike getProjectList(userId) twelve lines
// above in the same file which already applies the correct gate via
// onGetProjectAccess + users.canAccessProject.
//
// THE FIX (holden comment #1, do not re-derive): thread userId through
// getAllProjectSessions(includeSelf, userId) from its single caller
// (lib/project-loop.js's hub_recent_sessions_list handler), and reuse the
// EXISTING predicate lib/users-permissions.js's canAccessSession(userId,
// session, project) — not a new one — matching the pattern
// broadcastSessionList (lib/sessions.js:794-795) already uses. Fails CLOSED
// when userId is absent (no legitimate no-auth caller reaches this path —
// the WS upgrade handler in lib/server.js rejects any unauthenticated
// connection with 401 before ws._clagenticUser can be set, in every mode
// including single-user/PIN).
//
// DO NOT confuse with the prior, opposite-direction defect in this same
// function: the lazy-history-length filter that OVER-filtered and hid
// legitimate cross-project sessions (retro-hub-recent-sessions-lazy-
// history-filter, engrams 7396778 / 7399380). That is resolved — the
// session-level filter is `!s.hidden`, nothing keyed on history length —
// and this suite's fixtures intentionally include sessions with empty
// history arrays to prove this fix does not resurrect that bug.
//
// TEST-STRATEGY REWORK (holden bounce on PR #388 comment #2, 2026-08-10):
// the original version of this suite paired a harness reimplementation of
// getAllProjectSessions's project-iteration loop with fixed-width source-
// text-window assertions meant to prove the harness matched lib/server.js's
// real shape. That inverted the dependency: the seven behavioral tests
// exercised only the harness copy, and the brittle byte-offset windows were
// the ONLY thing tying it to shipped behavior — a mechanism that stops
// covering anything, silently, the moment source above it drifts past the
// window (recorded precedent: lr-255e, lr-9bcd7b).
//
// Fix: lib/server.js's getAllProjectSessions project-iteration + access-
// filter logic was extracted into lib/server-hub-sessions.js's
// computeAllProjectSessions(deps) — a small, exported, injectable pure
// function. lib/server.js's getAllProjectSessions is now a thin call into
// it. Every behavioral test below calls that REAL function directly. No
// harness, no source-text window standing in for real coverage.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { computeAllProjectSessions } = require("../lib/server-hub-sessions");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var PROJECT_LOOP_JS = readMod("lib/project-loop.js");

// ---------------------------------------------------------------------------
// Structural invariant: lib/project-loop.js threads the connecting client's
// userId into getAllProjectSessions. This is a wiring fact at the caller
// (lib/server.js's addProject ctx -> lib/project-loop.js), not a claim about
// the filter's own behavior (that's covered end-to-end by the attachLoop
// functional tests below, and directly by the computeAllProjectSessions
// tests). Matched against the whole file, no fixed-width slice.
// ---------------------------------------------------------------------------

test("lib/project-loop.js: hub_recent_sessions_list threads the connecting client's userId into getAllProjectSessions", function () {
  assert.match(
    PROJECT_LOOP_JS,
    /getAllProjectSessions\s*\(\s*true\s*,\s*hubUserId\s*\)/,
    "expected getAllProjectSessions(true, hubUserId) — userId threaded from the connecting ws"
  );
  assert.match(
    PROJECT_LOOP_JS,
    /var hubUserId\s*=\s*ws\._clagenticUser\s*\?\s*ws\._clagenticUser\.id\s*:\s*null;/,
    "expected hubUserId to be derived from ws._clagenticUser.id, null when absent (fail-closed input)"
  );
});

// ---------------------------------------------------------------------------
// computeAllProjectSessions (lib/server-hub-sessions.js): real production
// code, called directly. Real users.js predicate (canAccessProject /
// canAccessSession), real on-disk user records.
// ---------------------------------------------------------------------------

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-hub-access-"));
}

function loadRealUsers(tmpHome) {
  ["../lib/config", "../lib/users", "../lib/users-auth", "../lib/users-permissions", "../lib/users-preferences", "../lib/store"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var users;
  try {
    users = require("../lib/users");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return users;
}

// Minimal projects-map stand-in: computeAllProjectSessions only calls
// .forEach(fn(ctx, slug)) on it, matching the real `projects` Map's
// interface in lib/server.js -- not a reimplementation of the filter itself.
function makeProjectsMap(projectsBySlug, sessionsBySlug) {
  var map = new Map();
  Object.keys(projectsBySlug).forEach(function (pSlug) {
    var status = { isWorktree: false, title: null, project: pSlug, icon: null };
    var sm = { sessions: sessionsBySlug[pSlug] || [] };
    map.set(pSlug, {
      getStatus: function () { return status; },
      getSessionManager: function () { return sm; },
    });
  });
  return map;
}

function makeFixture() {
  var tmpHome = makeTempHome();
  var users = loadRealUsers(tmpHome);

  var owner = users.createUser({ username: "owner-a", pin: "111111", role: "user" }).user;
  var outsider = users.createUser({ username: "outsider-b", pin: "222222", role: "user" }).user;
  var admin = users.createUser({ username: "admin-c", pin: "333333", role: "admin" }).user;

  var projectsBySlug = {
    "project-shared": { slug: "project-shared", visibility: "public", ownerId: owner.id, allowedUsers: [] },
    "project-private-x": { slug: "project-private-x", visibility: "private", ownerId: owner.id, allowedUsers: [] },
  };
  var onGetProjectAccess = function (slug) {
    return projectsBySlug[slug] || { error: "Project not found" };
  };

  var sessionsBySlug = {
    "project-shared": [
      { localId: 1, ownerId: owner.id, sessionVisibility: "shared", hidden: false, history: [] },
      { localId: 2, ownerId: owner.id, sessionVisibility: "private", hidden: false, history: [] },
    ],
    "project-private-x": [
      { localId: 1, ownerId: owner.id, sessionVisibility: "shared", hidden: false, history: [] },
    ],
  };

  var projects = makeProjectsMap(projectsBySlug, sessionsBySlug);

  return {
    users: users, owner: owner, outsider: outsider, admin: admin,
    projects: projects, onGetProjectAccess: onGetProjectAccess,
    cleanup: function () { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {} },
  };
}

test("a user with no access to a private project does not see that project's sessions in their payload", function () {
  var f = makeFixture();
  try {
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.outsider.id,
    });
    var fromPrivateProject = result.filter(function (s) { return s._projectSlug === "project-private-x"; });
    assert.strictEqual(fromPrivateProject.length, 0, "outsider must not see any session from a private project they have no access to");
  } finally {
    f.cleanup();
  }
});

test("a private session owned by user A is absent from user B's payload", function () {
  var f = makeFixture();
  try {
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.outsider.id,
    });
    // project-shared is public, so outsider sees it, but session 2 is private to owner.
    var sharedSessions = result.filter(function (s) { return s._projectSlug === "project-shared"; });
    var privateSessIds = sharedSessions.map(function (s) { return s.localId; });
    assert.ok(privateSessIds.indexOf(1) !== -1, "the shared session (localId 1) must be visible to a project member");
    assert.strictEqual(privateSessIds.indexOf(2), -1, "the private session (localId 2, owned by owner-a) must NOT be visible to outsider-b");
  } finally {
    f.cleanup();
  }
});

test("that same private session IS present in the owning user's own payload", function () {
  var f = makeFixture();
  try {
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.owner.id,
    });
    var sharedSessions = result.filter(function (s) { return s._projectSlug === "project-shared"; });
    var ids = sharedSessions.map(function (s) { return s.localId; });
    assert.ok(ids.indexOf(2) !== -1, "the owner must see their own private session (localId 2) in their own Home Hub payload");
  } finally {
    f.cleanup();
  }
});

test("no userId (unauthenticated) returns no sessions at all -- fail closed", function () {
  var f = makeFixture();
  try {
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: null,
    });
    assert.deepStrictEqual(result, [], "an absent/unauthenticated userId must yield zero sessions, not an unfiltered list");
  } finally {
    f.cleanup();
  }
});

test("admin can see a private project's sessions via canAccessProject's admin bypass (real predicate, not reimplemented)", function () {
  var f = makeFixture();
  try {
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.admin.id,
    });
    var fromPrivateProject = result.filter(function (s) { return s._projectSlug === "project-private-x"; });
    assert.strictEqual(fromPrivateProject.length, 1, "admin must see the private project's session via users.canAccessProject's real admin bypass");
  } finally {
    f.cleanup();
  }
});

test("does not resurrect the lazy-history-length over-filtering bug: sessions with empty history arrays are still returned", function () {
  var f = makeFixture();
  try {
    // Every fixture session already has history: [] -- if a history.length
    // gate were reintroduced, all of them would vanish from an accessible
    // user's own payload. Assert the opposite: they're present.
    var result = computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: f.onGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.owner.id,
    });
    assert.ok(result.length > 0, "sessions with empty history must still be returned to a user who has access to them");
    result.forEach(function (s) {
      assert.deepStrictEqual(s.history, [], "fixture sessions carry empty history -- confirms no history.length filter is gating the result");
    });
  } finally {
    f.cleanup();
  }
});

test("per-project access is resolved once per project: onGetProjectAccess is called exactly once per project, not once per session", function () {
  var f = makeFixture();
  try {
    var calls = [];
    var spyOnGetProjectAccess = function (slug) {
      calls.push(slug);
      return f.onGetProjectAccess(slug);
    };
    computeAllProjectSessions({
      projects: f.projects, users: f.users, onGetProjectAccess: spyOnGetProjectAccess,
      callerSlug: "current-project", includeSelf: true, userId: f.owner.id,
    });
    // project-shared has 2 sessions, project-private-x has 1 -- if access
    // were re-resolved per session this would be 3 calls, not 2 (one per
    // project). A call-counting spy on the injected accessor, exercising
    // the real function -- strictly better than the old fixed-width
    // source-text window this replaces.
    var perProjectCounts = {};
    calls.forEach(function (s) { perProjectCounts[s] = (perProjectCounts[s] || 0) + 1; });
    assert.strictEqual(perProjectCounts["project-shared"], 1, "onGetProjectAccess must be called exactly once for project-shared, not once per session");
    assert.strictEqual(perProjectCounts["project-private-x"], 1, "onGetProjectAccess must be called exactly once for project-private-x");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Functional test via attachLoop (real production project-loop.js code):
// proves hub_recent_sessions_list actually threads ws._clagenticUser.id through,
// end to end, using a getAllProjectSessions stub that asserts on its args.
// ---------------------------------------------------------------------------

function makeTempHomeLoop() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-hub-access-loop-"));
}

function makeCtx(cwd, getAllProjectSessionsStub) {
  var noop = function () {};
  var sentTo = [];
  return {
    _sentTo: sentTo,
    cwd: cwd,
    slug: "current-project",
    sm: { sessions: new Map(), setResolveLoopInfo: noop, broadcastSessionList: noop },
    sdk: { startQuery: noop },
    send: noop,
    sendTo: function (ws, msg) { sentTo.push([ws, msg]); },
    sendToSession: noop,
    pushModule: null,
    notificationsModule: null,
    getHubSchedules: function () { return []; },
    getAllProjectSessions: getAllProjectSessionsStub,
    getSessionUnread: function () { return 0; },
    getStatus: noop,
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: noop,
    hydrateImageRefs: noop,
  };
}

function makeEngine(cwd, getAllProjectSessionsStub) {
  var tmpHome = makeTempHomeLoop();
  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var engine, ctx, mod;
  try {
    mod = require("../lib/project-loop");
    ctx = makeCtx(cwd || tmpHome, getAllProjectSessionsStub);
    engine = mod.attachLoop(ctx);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  engine.stopTimer();
  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
  return { engine: engine, ctx: ctx, cleanup: cleanup };
}

test("project-loop.js hub_recent_sessions_list: getAllProjectSessions is called with (true, authenticated userId), not just (true)", function () {
  var cwd = makeTempHomeLoop();
  var calls = [];
  var stub = function (includeSelf, userId) {
    calls.push([includeSelf, userId]);
    return [];
  };
  var { engine, ctx, cleanup } = makeEngine(cwd, stub);
  try {
    var ws = { _clagenticUser: { id: "user-real-123" } };
    var handled = engine.handleLoopMessage(ws, { type: "hub_recent_sessions_list" });
    assert.strictEqual(handled, true);
    assert.strictEqual(calls.length, 1, "expected exactly one getAllProjectSessions call");
    assert.deepStrictEqual(calls[0], [true, "user-real-123"], "expected getAllProjectSessions(true, userId) with the connecting client's real userId");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test("project-loop.js hub_recent_sessions_list: an unauthenticated ws (no _clagenticUser) still calls getAllProjectSessions but with a null userId -- server-side fails closed, does not crash", function () {
  var cwd = makeTempHomeLoop();
  var calls = [];
  var stub = function (includeSelf, userId) {
    calls.push([includeSelf, userId]);
    return [];
  };
  var { engine, ctx, cleanup } = makeEngine(cwd, stub);
  try {
    var ws = {}; // no _clagenticUser
    var handled = engine.handleLoopMessage(ws, { type: "hub_recent_sessions_list" });
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(calls[0], [true, null], "expected a null userId to be passed through explicitly, not a crash or a silently-omitted arg");

    var call = ctx._sentTo.find(function (c) { return c[1].type === "hub_recent_sessions"; });
    assert.ok(call, "expected a hub_recent_sessions reply even in the unauthenticated case");
    assert.deepStrictEqual(call[1].sessions, [], "unauthenticated payload must be empty, matching the fail-closed contract");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});
