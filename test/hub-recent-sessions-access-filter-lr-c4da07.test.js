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
// connection with 401 before ws._clayUser can be set, in every mode
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
// lib/server.js's getAllProjectSessions is defined inline inside
// createServer()'s addProject() closure. createServer() stands up a real
// HTTP+WS server with dozens of required callback opts and is not a
// practical direct-require unit-test target (see the identical rationale in
// test/server-cross-project-unread-per-session-lr-0aa7b6.test.js, which this
// suite matches). Following that established convention: this suite drives
// REAL production code for (a) users.js's canAccessProject/canAccessSession
// (the actual predicate, required verbatim, never reimplemented, backed by
// real on-disk user records created via users.createUser in a temp
// CLAGENTIC_HOME) and (b) lib/project-loop.js's hub_recent_sessions_list
// handler via attachLoop with a mocked ctx — while pairing a harness
// reimplementation of getAllProjectSessions's own orchestration loop (the
// project-iteration shape only, not the predicate) with source-text
// assertions that prove the harness matches lib/server.js's real
// implementation shape.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var SERVER_JS = readMod("lib/server.js");
var PROJECT_LOOP_JS = readMod("lib/project-loop.js");

// ---------------------------------------------------------------------------
// Source-text presence checks: prove the real implementation has the shape
// this suite's harness/functional tests assume.
// ---------------------------------------------------------------------------

test("lib/server.js: getAllProjectSessions accepts userId and fails closed with no userId or no onGetProjectAccess", function () {
  var idx = SERVER_JS.indexOf("getAllProjectSessions: function (includeSelf, userId)");
  assert.ok(idx !== -1, "expected getAllProjectSessions(includeSelf, userId) signature");
  var block = SERVER_JS.slice(idx, idx + 1600);
  assert.match(
    block,
    /if\s*\(\s*!userId\s*\|\|\s*!onGetProjectAccess\s*\)\s*return\s+allSessions;/,
    "expected an early fail-closed return when userId or onGetProjectAccess is absent"
  );
});

test("lib/server.js: getAllProjectSessions reuses users.canAccessSession, not a new predicate", function () {
  var idx = SERVER_JS.indexOf("getAllProjectSessions: function (includeSelf, userId)");
  var block = SERVER_JS.slice(idx, idx + 1600);
  assert.match(
    block,
    /users\.canAccessSession\s*\(\s*userId\s*,\s*s\s*,\s*access\s*\)/,
    "expected the session-level filter to call users.canAccessSession(userId, s, access) — the existing predicate, reused"
  );
  assert.match(
    block,
    /users\.canAccessProject\s*\(\s*userId\s*,\s*access\s*\)/,
    "expected a per-project users.canAccessProject(userId, access) gate before iterating that project's sessions"
  );
});

test("lib/server.js: getAllProjectSessions resolves per-project access ONCE per project, not once per session (no repeated-resolution in the inner loop)", function () {
  var idx = SERVER_JS.indexOf("getAllProjectSessions: function (includeSelf, userId)");
  var end = SERVER_JS.indexOf("getHubSchedules: function ()", idx);
  var block = SERVER_JS.slice(idx, end);

  var innerLoopIdx = block.indexOf("pSm.sessions.forEach");
  assert.ok(innerLoopIdx !== -1, "expected a pSm.sessions.forEach inner loop");
  var outerBlock = block.slice(0, innerLoopIdx);
  var innerBlock = block.slice(innerLoopIdx);

  assert.match(
    outerBlock,
    /var access\s*=\s*onGetProjectAccess\s*\(\s*pSlug\s*\)/,
    "onGetProjectAccess(pSlug) must be called in the OUTER per-project scope, not inside the per-session inner loop"
  );
  assert.doesNotMatch(
    innerBlock,
    /onGetProjectAccess\s*\(/,
    "onGetProjectAccess must not be re-resolved inside the per-session inner loop — that would be an N-query/repeated-resolution pattern"
  );
});

test("lib/server.js: the session-level filter is still `!s.hidden` (does not resurrect the lazy-history-length over-filtering bug)", function () {
  var idx = SERVER_JS.indexOf("getAllProjectSessions: function (includeSelf, userId)");
  var block = SERVER_JS.slice(idx, idx + 1600);
  assert.match(
    block,
    /if\s*\(\s*!s\.hidden\s*&&\s*users\.canAccessSession/,
    "expected the session-level filter to combine !s.hidden with canAccessSession, not a history-length check"
  );
  assert.doesNotMatch(
    block,
    /history\.length/,
    "must not reintroduce a history.length-based filter — that was the prior, opposite-direction (over-filtering) bug"
  );
});

test("lib/project-loop.js: hub_recent_sessions_list threads the connecting client's userId into getAllProjectSessions", function () {
  var idx = PROJECT_LOOP_JS.indexOf('msg.type === "hub_recent_sessions_list"');
  assert.ok(idx !== -1, "expected the hub_recent_sessions_list handler to exist");
  var block = PROJECT_LOOP_JS.slice(idx, idx + 1200);
  assert.match(
    block,
    /getAllProjectSessions\s*\(\s*true\s*,\s*hubUserId\s*\)/,
    "expected getAllProjectSessions(true, hubUserId) — userId threaded from the connecting ws"
  );
  assert.match(
    block,
    /ws\._clayUser\s*\?\s*ws\._clayUser\.id\s*:\s*null/,
    "expected hubUserId to be derived from ws._clayUser.id, null when absent (fail-closed input)"
  );
});

// ---------------------------------------------------------------------------
// Functional harness: real users.js predicate (canAccessProject /
// canAccessSession), real on-disk user records, reimplemented ONLY the
// project-iteration shape (verified above to match lib/server.js).
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

// Reimplements ONLY getAllProjectSessions's project-iteration shape (matches
// the source-text-verified real implementation above); the actual access
// decision is made by the REAL users.canAccessProject/canAccessSession.
function getAllProjectSessionsHarness(users, projectsBySlug, sessionsBySlug, onGetProjectAccess, includeSelf, callerSlug, userId) {
  var allSessions = [];
  if (!userId || !onGetProjectAccess) return allSessions;
  Object.keys(projectsBySlug).forEach(function (pSlug) {
    if (!includeSelf && pSlug === callerSlug) return;
    var access = onGetProjectAccess(pSlug);
    if (!access || access.error) return;
    if (!users.canAccessProject(userId, access)) return;
    (sessionsBySlug[pSlug] || []).forEach(function (s) {
      if (!s.hidden && users.canAccessSession(userId, s, access)) {
        allSessions.push(Object.assign({}, s, { _projectSlug: pSlug }));
      }
    });
  });
  return allSessions;
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

  return {
    users: users, owner: owner, outsider: outsider, admin: admin,
    projectsBySlug: projectsBySlug, sessionsBySlug: sessionsBySlug,
    onGetProjectAccess: onGetProjectAccess,
    cleanup: function () { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {} },
  };
}

test("a user with no access to a private project does not see that project's sessions in their payload", function () {
  var f = makeFixture();
  try {
    var result = getAllProjectSessionsHarness(
      f.users, f.projectsBySlug, f.sessionsBySlug, f.onGetProjectAccess,
      true, "current-project", f.outsider.id
    );
    var fromPrivateProject = result.filter(function (s) { return s._projectSlug === "project-private-x"; });
    assert.strictEqual(fromPrivateProject.length, 0, "outsider must not see any session from a private project they have no access to");
  } finally {
    f.cleanup();
  }
});

test("a private session owned by user A is absent from user B's payload", function () {
  var f = makeFixture();
  try {
    var result = getAllProjectSessionsHarness(
      f.users, f.projectsBySlug, f.sessionsBySlug, f.onGetProjectAccess,
      true, "current-project", f.outsider.id
    );
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
    var result = getAllProjectSessionsHarness(
      f.users, f.projectsBySlug, f.sessionsBySlug, f.onGetProjectAccess,
      true, "current-project", f.owner.id
    );
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
    var result = getAllProjectSessionsHarness(
      f.users, f.projectsBySlug, f.sessionsBySlug, f.onGetProjectAccess,
      true, "current-project", null
    );
    assert.deepStrictEqual(result, [], "an absent/unauthenticated userId must yield zero sessions, not an unfiltered list");
  } finally {
    f.cleanup();
  }
});

test("admin can see a private project's sessions via canAccessProject's admin bypass (real predicate, not reimplemented)", function () {
  var f = makeFixture();
  try {
    var result = getAllProjectSessionsHarness(
      f.users, f.projectsBySlug, f.sessionsBySlug, f.onGetProjectAccess,
      true, "current-project", f.admin.id
    );
    var fromPrivateProject = result.filter(function (s) { return s._projectSlug === "project-private-x"; });
    assert.strictEqual(fromPrivateProject.length, 1, "admin must see the private project's session via users.canAccessProject's real admin bypass");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Functional test via attachLoop (real production project-loop.js code):
// proves hub_recent_sessions_list actually threads ws._clayUser.id through,
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
    var ws = { _clayUser: { id: "user-real-123" } };
    var handled = engine.handleLoopMessage(ws, { type: "hub_recent_sessions_list" });
    assert.strictEqual(handled, true);
    assert.strictEqual(calls.length, 1, "expected exactly one getAllProjectSessions call");
    assert.deepStrictEqual(calls[0], [true, "user-real-123"], "expected getAllProjectSessions(true, userId) with the connecting client's real userId");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test("project-loop.js hub_recent_sessions_list: an unauthenticated ws (no _clayUser) still calls getAllProjectSessions but with a null userId -- server-side fails closed, does not crash", function () {
  var cwd = makeTempHomeLoop();
  var calls = [];
  var stub = function (includeSelf, userId) {
    calls.push([includeSelf, userId]);
    return [];
  };
  var { engine, ctx, cleanup } = makeEngine(cwd, stub);
  try {
    var ws = {}; // no _clayUser
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
