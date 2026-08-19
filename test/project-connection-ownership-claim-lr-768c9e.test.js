"use strict";
// Regression test for lr-768c9e: session history silently destroyed on first
// admin connection to an unowned session.
//
// Root cause (lib/project-connection.js, handleConnection): when an admin/user
// first connects to an unowned session (active.ownerId falsy), the old code
// claimed ownership and called sm.saveSessionFile(active) BEFORE
// sm.loadSessionHistory(active). If the session had been evicted from the LRU
// cache, active.history was [] in memory, so saveSessionFile rewrote the
// on-disk file with an empty history array — silently truncating it.
//
// Fix: sm.loadSessionHistory(active) now runs before the ownership-claim
// sm.saveSessionFile(active), so history is guaranteed to be populated from
// disk before any rewrite.
//
// This test drives the real attachConnection() + createSessionManager() code
// paths (no reimplementation of the ordering logic).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-768c9e-"));
}

// lr-ae85d5: project-connection.js also requires ../lib/lite-detect, which
// destructures CLAGENTIC_HOME/REAL_HOME from ../lib/config at module-load
// time (lib/lite-detect.js:10) -- the same module-level path-freezing
// pattern as USERS_FILE in lib/users.js. It was missing from this list, so
// on any process where ../lib/lite-detect had already been required once
// (e.g. by an earlier test in this same worker under a real/default
// CLAGENTIC_HOME) before this test's bustRequireCache() ran, detectLite()
// would keep resolving Lite's home dir against that stale HOME instead of
// this test's tmpHome for the lifetime of the process -- a real instance of
// the module-cache/env-var race this pattern is meant to guard against.
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

// Writes an admin user directly to users.json so canAccessSession() treats
// the connecting wsUser as authorized to see legacy/unowned sessions.
function seedAdminUser(tmpHome, userId) {
  var configDir = path.join(tmpHome, "console");
  fs.mkdirSync(configDir, { recursive: true });
  var usersData = {
    multiUser: true,
    setupCode: null,
    users: [{
      id: userId,
      username: "admin",
      email: null,
      displayName: "Admin",
      pinHash: "unused",
      role: "admin",
      mustChangePin: false,
      createdAt: Date.now(),
      linuxUser: null,
      profile: { name: "Admin", lang: "en-US", avatarColor: "#000", avatarStyle: "thumbs", avatarSeed: "x" },
    }],
    invites: [],
    smtp: null,
  };
  fs.writeFileSync(path.join(configDir, "users.json"), JSON.stringify(usersData, null, 2));
}

function makeSessionManager(tmpHome) {
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule, usersModule, userPresenceModule, connModule;
  try {
    sessionsModule = require("../lib/sessions");
    usersModule = require("../lib/users");
    userPresenceModule = require("../lib/user-presence");
    connModule = require("../lib/project-connection");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  var sm = sessionsModule.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: null,
  });
  return { sm: sm, usersModule: usersModule, userPresenceModule: userPresenceModule, connModule: connModule };
}

function findSessionFile(sessionsDir, cliSessionId) {
  return path.join(sessionsDir, cliSessionId + ".jsonl");
}

function makeConnectionCtx(overrides) {
  return Object.assign({
    cwd: overrides.cwd,
    slug: "test-project",
    isMate: false,
    osUsers: false,
    debug: false,
    dangerouslySkipPermissions: false,
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

// lr-a7b03e: re-enabled. The ~1/19 flake this test was quarantined for was
// measured on a broken harness (node --test --test-force-exit could silently
// drop whole ESM test files while exiting 0 -- see lr-795882). With that
// harness defect fixed, this test's flake rate was re-measured empirically
// under repeated full-suite runs before un-skipping (see PR body for the
// stress-run evidence); it did not reproduce.
test("lr-768c9e: admin connecting to an evicted, unowned session does not truncate on-disk history", function () {
  var tmpHome = makeTempHome();
  try {
    var adminId = "admin-user-1";
    seedAdminUser(tmpHome, adminId);
    bustRequireCache();
    var mods = makeSessionManager(tmpHome);
    var sm = mods.sm;
    var usersModule = mods.usersModule;
    var connModule = mods.connModule;

    // Fail loud, not silent: if any module in the require graph resolved
    // USERS_FILE against a stale CONFIG_DIR from an earlier require in this
    // process (the module-cache/env-var race this file's bustRequireCache()
    // exists to prevent), assert here with a clear diagnostic instead of
    // letting it surface later as a confusing "ownerId is null" failure.
    assert.ok(
      usersModule.USERS_FILE.indexOf(tmpHome) === 0,
      "USERS_FILE (" + usersModule.USERS_FILE + ") must resolve under this test's tmpHome (" +
        tmpHome + ") -- stale module-cache CONFIG_DIR detected"
    );

    // Build an unowned session with real history, persisted to disk.
    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-lr-768c9e";
    session.ownerId = null;
    sm.sendAndRecord(session, { type: "user_message", text: "important question" });
    sm.sendAndRecord(session, { type: "delta", text: "important answer" });
    sm.saveSessionFile(session);

    var sessionFile = findSessionFile(sm.sessionsDir, "sess-lr-768c9e");
    var linesBefore = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(linesBefore.length, 3, "meta + 2 history lines expected on disk before eviction");

    // Simulate LRU eviction: history unloaded from memory, disk is now the
    // sole source of truth (mirrors _lruEvictIfNeeded in lib/sessions.js).
    session.history = [];
    session._historyLoaded = false;

    // Simulate an admin's first WS connection to this unowned session.
    var sendToCalls = [];
    var ctx = makeConnectionCtx({
      cwd: tmpHome,
      sm: sm,
      tm: { list: function () { return []; } },
      nm: { list: function () { return []; } },
      sendTo: function (ws, msg) { sendToCalls.push(msg); },
      usersModule: usersModule,
    });
    // usersModule is required directly inside project-connection.js (not via
    // ctx), so it already resolves to the same instance returned above.

    // Fail loud, not silent: findUserById() drives canAccessSession(), which
    // gates whether allSessions includes this unowned session at all -- if it
    // doesn't, handleConnection() takes the autoCreated branch and never
    // reaches the ownership-claim code path this test exists to cover. If
    // this lookup itself is failing (e.g. a transient users.json read racing
    // under full-suite load), assert here with a clear diagnostic instead of
    // the confusing downstream "ownerId is null" symptom.
    var _seededAdmin = usersModule.findUserById(adminId);
    assert.ok(
      _seededAdmin && _seededAdmin.role === "admin",
      "findUserById(" + adminId + ") must return the seeded admin before handleConnection runs -- got: " +
        JSON.stringify(_seededAdmin)
    );

    var attachment = connModule.attachConnection(ctx);
    var ws = {
      on: function () {},
      readyState: 1,
      send: function () {},
    };
    var wsUser = { id: adminId, role: "admin" };

    attachment.handleConnection(ws, wsUser, function () {}, function () {});

    // Ownership should now be claimed by the connecting admin.
    assert.equal(session.ownerId, adminId, "admin claims ownership of the unowned session");

    // The regression: history on disk must still be present — NOT truncated
    // to just the meta line.
    var linesAfter = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(linesAfter.length, 3,
      "on-disk history must be preserved (meta + 2 lines); truncation bug would leave only 1 (meta)");

    // The in-memory session must also reflect the reloaded history, and the
    // session_switched message sent to the client must report hasHistory: true.
    assert.equal(session.history.length, 2, "in-memory history must be reloaded from disk before the claim save");

    var switched = sendToCalls.find(function (m) { return m.type === "session_switched"; });
    assert.ok(switched, "session_switched message must be sent");
    assert.equal(switched.hasHistory, true, "hasHistory must reflect the reloaded history, not an empty in-memory array");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
