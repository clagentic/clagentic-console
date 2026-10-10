"use strict";
// A client with no stored presence is restored into the most recently active
// session. lastActivity has millisecond resolution and the session manager
// creates a blank initial session at construction, so a session created right
// after it commonly ties on lastActivity. The newer session must win the tie;
// the blank one winning restored clients into the wrong session on fast hosts.
//
// The tie is forced explicitly here rather than hoped for from timing, so the
// test fails deterministically on the old strict-greater comparison.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

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

function loadModules(tmpHome) {
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  try {
    return {
      sessionsModule: require("../lib/sessions"),
      connModule: require("../lib/project-connection"),
    };
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
}

function makeCtx(cwd, sm, sendTo) {
  return {
    cwd: cwd, slug: "test-project", isMate: false, osUsers: false, debug: false,
    dangerouslySkipPermissionsConfigured: false, currentVersion: "0.0.0", lanHost: null,
    clients: new Set(), send: function () {}, sendTo: sendTo, opts: {},
    loopState: {}, loopRegistry: {},
    _loop: { loopState: {}, loopRegistry: {}, resumeLoop: function () {}, sendConnectionState: function () {} },
    _mcp: null, _notifications: null, sm: sm,
    tm: { list: function () { return []; } },
    nm: { list: function () { return []; } },
    hydrateImageRefs: function (o) { return o; },
    broadcastClientCount: function () {}, broadcastPresence: function () {},
    getProjectList: function () { return []; }, getHubSchedules: function () { return []; },
    loadContextSources: function () { return []; },
    stopFileWatch: function () {}, stopAllDirWatches: function () {},
    getProjectOwnerId: function () { return null; }, setProjectOwnerId: function () {},
    getLatestVersion: function () { return null; },
    getTitle: function () { return "Test Project"; }, getProject: function () { return "test-project"; },
    warmup: null,
  };
}

function connect(tmpHome, mutate) {
  bustRequireCache();
  var mods = loadModules(tmpHome);
  var sm = mods.sessionsModule.createSessionManager({
    cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null,
  });
  mutate(sm);
  var sent = [];
  var attachment = mods.connModule.attachConnection(makeCtx(tmpHome, sm, function (ws, msg) { sent.push(msg); }));
  attachment.handleConnection({ on: function () {}, readyState: 1, send: function () {} }, null, function () {}, function () {});
  return sent;
}

test("restore picks the newer session when two sessions tie on lastActivity", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-restore-tie-"));
  try {
    var newer;
    var sent = connect(tmpHome, function (sm) {
      var blank = sm.sessions.values().next().value;
      newer = sm.createSessionRaw({});
      blank.lastActivity = 1000;
      newer.lastActivity = 1000;
    });
    var switched = sent.find(function (m) { return m.type === "session_switched"; });
    assert.ok(switched, "expected a session_switched message on connect");
    assert.equal(switched.id, newer.localId, "the newer session must win a lastActivity tie");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("restore still picks the strictly more recent session regardless of creation order", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-restore-recent-"));
  try {
    var blank;
    var sent = connect(tmpHome, function (sm) {
      blank = sm.sessions.values().next().value;
      var newer = sm.createSessionRaw({});
      blank.lastActivity = 2000;
      newer.lastActivity = 1000;
    });
    var switched = sent.find(function (m) { return m.type === "session_switched"; });
    assert.ok(switched, "expected a session_switched message on connect");
    assert.equal(switched.id, blank.localId);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
