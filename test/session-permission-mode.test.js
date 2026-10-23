"use strict";
// A session's permission mode is its own: saved with the session, restored on
// load and resume, shown to clients from the session (never from the project
// default), and moved by a change of the project default only when the person
// chose "Apply to running sessions" for that change.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");
var world = require("./prompt-harness-world");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var { createProjectAccess } = require("../lib/project-access");

var client = world.client;

function lastConfigState(c) {
  var all = c.inbox.filter(function (m) { return m.type === "config_state"; });
  return all[all.length - 1];
}

// ---------------------------------------------------------------------------
// Saved with the session
// ---------------------------------------------------------------------------

test("a session's mode is written to its meta line and read back after a restart", async function () {
  var first = await world.createServer();
  var home = first.home;
  try {
    await first.bridge.setPermissionMode(first.session, "plan");
    assert.equal(first.session.permissionMode, "plan");
    var meta = JSON.parse(fs.readFileSync(path.join(first.sm.sessionsDir, first.session.cliSessionId + ".jsonl"), "utf8").split("\n")[0]);
    assert.equal(meta.permissionMode, "plan", "saved with the session, not only held in memory");
    var cliSessionId = first.session.cliSessionId;
    first.shutdown();

    var second = await world.createServer({ home: home, cliSessionId: cliSessionId });
    assert.equal(second.session.permissionMode, "plan", "the restart keeps the session's own mode");
    second.sm._savedDefaultMode = "acceptEdits";
    second.sm.currentPermissionMode = "acceptEdits";
    assert.equal(second.sm.effectiveSessionMode(second.session), "plan", "not the project default");
    second.shutdown();
  } finally {
    world.removeHome(home);
  }
});

test("a mode that changes with a running query is saved too", async function () {
  var server = await world.createServer();
  try {
    await server.startQuery();
    await server.bridge.setPermissionMode(server.session, "acceptEdits");
    var meta = JSON.parse(fs.readFileSync(path.join(server.sm.sessionsDir, server.session.cliSessionId + ".jsonl"), "utf8").split("\n")[0]);
    assert.equal(meta.permissionMode, "acceptEdits");
    await server.endQuery();
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a new session takes the project default at creation and keeps it when the default changes", async function () {
  var server = await world.createServer();
  try {
    server.sm._savedDefaultMode = "plan";
    var made = server.sm.createSessionRaw({});
    assert.equal(made.permissionMode, "plan");
    server.sm._savedDefaultMode = "acceptEdits";
    assert.equal(made.permissionMode, "plan", "a later default does not move it");
    var named = server.sm.createSessionRaw({ permissionMode: "default" });
    assert.equal(named.permissionMode, "default", "the creator's mode wins over the default");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a session saved before sessions kept a mode takes the project default on load, and keeps it", async function () {
  var first = await world.createServer();
  var home = first.home;
  try {
    var id = first.session.cliSessionId;
    first.shutdown();
    // The file as an older build wrote it: no mode in the meta line.
    var file = path.join(first.sm.sessionsDir, id + ".jsonl");
    var lines = fs.readFileSync(file, "utf8").split("\n");
    var meta = JSON.parse(lines[0]);
    delete meta.permissionMode;
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(file, lines.join("\n"));

    var second = await world.createServer({ home: home, cliSessionId: id });
    assert.equal(second.session.permissionMode, undefined, "nothing saved");
    // What lib/project.js does once the project's default is known.
    second.sm.adoptDefaultMode("plan");
    assert.equal(second.session.permissionMode, "plan");
    second.sm._savedDefaultMode = "acceptEdits";
    assert.equal(second.session.permissionMode, "plan", "a later change of the default does not move it");
    second.sm.adoptDefaultMode("default");
    assert.equal(second.session.permissionMode, "plan", "a session that has a mode is not re-adopted");
    second.shutdown();
  } finally {
    world.removeHome(home);
  }
});

test("a saved mode the server does not allow loads as default and says so", async function () {
  var first = await world.createServer();
  var home = first.home;
  var warned = [];
  var warn = console.warn;
  try {
    var id = first.session.cliSessionId;
    first.shutdown();
    var file = path.join(first.sm.sessionsDir, id + ".jsonl");
    var lines = fs.readFileSync(file, "utf8").split("\n");
    var meta = JSON.parse(lines[0]);
    meta.permissionMode = "bypassPermissions";
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(file, lines.join("\n"));

    console.warn = function (line) { warned.push(String(line)); };
    var second = await world.createServer({ home: home, cliSessionId: id });
    assert.equal(second.session.permissionMode, "default");
    assert.ok(warned.some(function (l) { return l.indexOf("bypassPermissions") !== -1; }), "a log line says why");
    second.shutdown();
  } finally {
    console.warn = warn;
    world.removeHome(home);
  }
});

test("a resume from the stored record keeps the mode, and refuses one the server does not allow", async function () {
  var server = await world.createServer();
  try {
    var warn = console.warn;
    console.warn = function () {};
    try {
      var kept = server.sm.resumeSession("resumed-ok", { history: [], permissionMode: "plan" });
      assert.equal(kept.permissionMode, "plan");
      var refused = server.sm.resumeSession("resumed-bad", { history: [], permissionMode: "bypassPermissions" });
      assert.equal(refused.permissionMode, "default");
      // With the vendor's capabilities known, a mode that vendor cannot run is refused too.
      server.sm.capabilitiesByVendor = { claude: claudeCapabilities(), codex: { permissionModes: [] } };
      var onCodex = server.sm.resumeSession("resumed-codex", { history: [], vendor: "codex", permissionMode: "auto" });
      assert.equal(onCodex.permissionMode, "default");
      var onClaude = server.sm.resumeSession("resumed-claude", { history: [], vendor: "claude", permissionMode: "auto" });
      assert.equal(onClaude.permissionMode, "auto");
    } finally {
      console.warn = warn;
    }
    var resumeModule = require(world.LIB_ROOT + "/session-resume");
    var id = "stored-with-mode";
    var file = path.join(server.sm.sessionsDir, id + ".jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "meta", cliSessionId: id, title: "t", createdAt: 1, permissionMode: "dontAsk" }) + "\n");
    var resumed = await resumeModule.resumeStoredSession({ sm: server.sm, cwd: server.home }, id, { activate: false });
    assert.equal(resumed.permissionMode, "dontAsk");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// Shown to clients from the session
// ---------------------------------------------------------------------------

test("the session's effective mode is its own, then the project default, then default", function () {
  var { effectiveSessionMode } = require("../lib/sessions");
  assert.equal(effectiveSessionMode({ permissionMode: "plan" }, { currentPermissionMode: "acceptEdits" }), "plan");
  assert.equal(effectiveSessionMode({}, { currentPermissionMode: "acceptEdits" }), "acceptEdits");
  assert.equal(effectiveSessionMode(null, { currentPermissionMode: "acceptEdits" }), "acceptEdits");
  assert.equal(effectiveSessionMode({}, {}), "default");
  assert.equal(effectiveSessionMode(undefined, undefined), "default");
});

test("session_switched, switch_session and set_vendor carry the session's mode, not the project's", async function () {
  var server = await world.createServer();
  try {
    server.sm.currentPermissionMode = "acceptEdits";
    server.session.permissionMode = "plan";
    var c = client();
    server.connect(c.ws);
    var switched = c.inbox.filter(function (m) { return m.type === "session_switched"; }).pop();
    assert.equal(switched.mode, "plan");

    var handlers = defaultSetters(server).handlers;
    c.inbox.length = 0;
    handlers.handleSessionsMessage(c.ws, { type: "switch_session", id: server.session.localId });
    assert.equal(lastConfigState(c).mode, "plan");

    c.inbox.length = 0;
    handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: "claude" });
    assert.equal(lastConfigState(c).mode, "plan");

    c.inbox.length = 0;
    server.sm.capabilitiesByVendor = { claude: claudeCapabilities() };
    handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: "nonsense" });
    assert.equal(lastConfigState(c).mode, "plan", "a refused change puts the picker back on the session's mode");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a push about the effort, betas or a default model carries no mode, so no chip is moved to the project default", async function () {
  var server = await world.createServer();
  try {
    server.sm.currentPermissionMode = "acceptEdits";
    server.session.permissionMode = "plan";
    var c = client();
    server.connect(c.ws);
    c.inbox.length = 0;
    ["set_server_default_betas", "set_project_default_betas"].forEach(function (type) {
      server.handlers.handleSessionsMessage(c.ws, { type: type, betas: [] });
    });
    server.handlers.handleSessionsMessage(c.ws, { type: "set_server_default_model", model: "sonnet" });
    server.handlers.handleSessionsMessage(c.ws, { type: "set_thinking", thinking: "adaptive" });
    server.handlers.handleSessionsMessage(c.ws, { type: "set_server_default_effort", effort: "high" });
    var states = c.inbox.filter(function (m) { return m.type === "config_state"; });
    assert.ok(states.length >= 4);
    states.forEach(function (m) { assert.equal(m.mode, undefined, "no mode in a push that is not about one"); });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// Reconnect hydration
// ---------------------------------------------------------------------------

var REQUIRE_CACHE_MODULES = [
  "../lib/config", "../lib/sessions", "../lib/users", "../lib/utils",
  "../lib/store", "../lib/users-auth", "../lib/users-permissions",
  "../lib/users-preferences", "../lib/user-presence", "../lib/lite-detect",
  "../lib/project-connection",
];

test("a reconnect shows the restored session's mode in config_state and session_switched", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-session-mode-"));
  var origHome = process.env.CLAGENTIC_HOME;
  var origConsoleHome = process.env.CLAGENTIC_CONSOLE_HOME;
  try {
    REQUIRE_CACHE_MODULES.forEach(function (m) { delete require.cache[require.resolve(m)]; });
    process.env.CLAGENTIC_HOME = tmpHome;
    process.env.CLAGENTIC_CONSOLE_HOME = tmpHome;
    var sessionsModule = require("../lib/sessions");
    var connModule = require("../lib/project-connection");
    var sm = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null });
    sm.currentPermissionMode = "acceptEdits";
    sm._savedDefaultMode = "acceptEdits";

    var session = sm.createSessionRaw({ permissionMode: "plan" });
    session.cliSessionId = "sess-mode-hydrate";
    sm.sendAndRecord(session, { type: "user_message", text: "hello" });
    sm.saveSessionFile(session);

    // The daemon restarts: a fresh manager over the same store.
    var restarted = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: null });
    restarted.currentPermissionMode = "acceptEdits";
    restarted.adoptDefaultMode("acceptEdits");

    var seen = [];
    var noop = function () {};
    var ctx = {
      cwd: tmpHome, slug: "test-project", isMate: false, osUsers: false, debug: false,
      dangerouslySkipPermissionsConfigured: false, currentVersion: "0.0.0", lanHost: null,
      clients: new Set(), send: noop, sendTo: function (ws, msg) { seen.push(msg); },
      opts: {}, loopState: {}, loopRegistry: {},
      _loop: { loopState: {}, loopRegistry: {}, resumeLoop: noop, sendConnectionState: noop },
      _mcp: null, _notifications: null, hydrateImageRefs: function (o) { return o; },
      broadcastClientCount: noop, broadcastPresence: noop, getProjectList: function () { return []; },
      getHubSchedules: function () { return []; }, loadContextSources: function () { return []; },
      stopFileWatch: noop, stopAllDirWatches: noop, getProjectOwnerId: function () { return null; },
      setProjectOwnerId: noop, getLatestVersion: function () { return null; },
      getTitle: function () { return "Test Project"; }, getProject: function () { return "test-project"; },
      warmup: null, sm: restarted,
      tm: { list: function () { return []; } }, nm: { list: function () { return []; } },
    };
    connModule.attachConnection(ctx).handleConnection({ on: noop, readyState: 1, send: noop }, null, noop, noop);

    var cs = seen.find(function (m) { return m.type === "config_state"; });
    assert.equal(cs.mode, "plan", "config_state on connect shows the session's mode, not the project's");
    var sw = seen.find(function (m) { return m.type === "session_switched"; });
    assert.equal(sw.mode, "plan");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origHome;
    if (origConsoleHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origConsoleHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Changing a default
// ---------------------------------------------------------------------------

function defaultSetters(server) {
  var calls = [];
  var access = createProjectAccess({
    users: { canAccessProject: function () { return true; }, canAccessSession: function () { return true; } },
    isMultiUser: function () { return true; },
  });
  var ctx = Object.assign({}, server.handlerContext, {
    projectAccess: access,
    userPresence: { setPresence: function () {} },
    getProjectOwnerId: function () { return "owner-1"; },
    opts: {
      onSetProjectDefaultMode: function (slug, mode) { calls.push(["project", mode]); },
      onSetServerDefaultMode: function (mode) { calls.push(["server", mode]); },
    },
  });
  return { handlers: require(world.LIB_ROOT + "/project-sessions").attachSessions(ctx), calls: calls };
}

function adminClient(server) {
  var c = client();
  c.ws._clagenticUser = { id: "a1", role: "admin" };
  c.ws._clagenticAuthenticated = true;
  server.connect(c.ws);
  c.inbox.length = 0;
  return c;
}

async function twoSessions(server) {
  server.sm.capabilitiesByVendor = { claude: claudeCapabilities(), codex: {} };
  server.sm._savedDefaultMode = "default";
  server.sm.currentPermissionMode = "default";
  server.session.permissionMode = "default";
  var other = server.sm.createSessionRaw({});
  other.permissionMode = "plan";
  return other;
}

test("changing the project default leaves running sessions alone and changes what new sessions start in", async function () {
  var server = await world.createServer();
  try {
    var other = await twoSessions(server);
    var s = defaultSetters(server);
    var admin = adminClient(server);
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_project_default_mode", mode: "acceptEdits" });
    await world.flush();
    assert.deepEqual(s.calls, [["project", "acceptEdits"]]);
    assert.equal(server.session.permissionMode, "default");
    assert.equal(other.permissionMode, "plan");
    assert.equal(server.sm._savedDefaultMode, "acceptEdits");
    assert.equal(server.sm.currentPermissionMode, "acceptEdits");
    assert.equal(admin.inbox.some(function (m) { return m.type === "permission_mode_applied"; }), false);

    s.handlers.handleSessionsMessage(admin.ws, { type: "new_session" });
    var created = Array.from(server.sm.sessions.values()).pop();
    assert.equal(created.permissionMode, "acceptEdits", "a new session starts in the new default and has it saved");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("the server default behaves the same: new sessions only", async function () {
  var server = await world.createServer();
  try {
    var other = await twoSessions(server);
    var s = defaultSetters(server);
    var admin = adminClient(server);
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_server_default_mode", mode: "acceptEdits" });
    await world.flush();
    assert.deepEqual(s.calls, [["server", "acceptEdits"]]);
    assert.equal(server.session.permissionMode, "default", "not even the focused session");
    assert.equal(other.permissionMode, "plan");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("picking 'Apply to running sessions' re-modes every session, each through the check for its own vendor, and reports the refusals", async function () {
  var server = await world.createServer();
  try {
    var other = await twoSessions(server);
    var codexSession = server.sm.createSessionRaw({ vendor: "codex" });
    codexSession.permissionMode = "default";
    var s = defaultSetters(server);
    var admin = adminClient(server);
    var warn = console.warn;
    console.warn = function () {};
    try {
      s.handlers.handleSessionsMessage(admin.ws, { type: "set_project_default_mode", mode: "auto", applyToRunning: true });
      await world.flush();
      await world.flush();
    } finally {
      console.warn = warn;
    }
    assert.equal(server.session.permissionMode, "auto");
    assert.equal(other.permissionMode, "auto");
    assert.equal(codexSession.permissionMode, "default", "the vendor that lacks auto is skipped, not forced");
    var report = admin.inbox.filter(function (m) { return m.type === "permission_mode_applied"; })[0];
    assert.equal(report.mode, "auto");
    // Every session the project holds but the one on the vendor without auto.
    assert.equal(report.applied, server.sm.sessions.size - 1);
    server.sm.sessions.forEach(function (held) {
      if (held !== codexSession) assert.equal(held.permissionMode, "auto", "session " + held.localId);
    });
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].sessionId, codexSession.localId);
    assert.match(report.skipped[0].reason, /does not support the auto/);
    assert.equal(lastConfigState(admin).mode, "auto", "each client is told its own session's mode");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("only a literal true applies: the choice is per change, not a stored setting", async function () {
  var server = await world.createServer();
  try {
    var other = await twoSessions(server);
    var s = defaultSetters(server);
    var admin = adminClient(server);
    ["yes", 1, "true", null].forEach(function (v) {
      s.handlers.handleSessionsMessage(admin.ws, { type: "set_project_default_mode", mode: "acceptEdits", applyToRunning: v });
    });
    await world.flush();
    assert.equal(server.session.permissionMode, "default");
    assert.equal(other.permissionMode, "plan");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a default change is refused for someone who may not set it, and apply does not bypass that", async function () {
  var server = await world.createServer();
  try {
    var other = await twoSessions(server);
    var s = defaultSetters(server);
    var c = client();
    c.ws._clagenticUser = { id: "u9", role: "user" };
    c.ws._clagenticAuthenticated = true;
    server.connect(c.ws);
    s.handlers.handleSessionsMessage(c.ws, { type: "set_project_default_mode", mode: "plan", applyToRunning: true });
    s.handlers.handleSessionsMessage(c.ws, { type: "set_server_default_mode", mode: "plan", applyToRunning: true });
    await world.flush();
    assert.deepEqual(s.calls, []);
    assert.equal(server.session.permissionMode, "default");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// The settings-page picker
// ---------------------------------------------------------------------------

test("the default-mode picker lists Don't ask and Auto only for an agent that declares them", async function () {
  var mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "mode-options.js")).href);
  var values = function (list) { return list.map(function (o) { return o.value; }); };
  assert.deepEqual(values(mod.capabilityModeOptions(undefined)), []);
  assert.deepEqual(values(mod.capabilityModeOptions({})), []);
  assert.deepEqual(values(mod.capabilityModeOptions({ permissionModes: "auto" })), []);
  assert.deepEqual(values(mod.capabilityModeOptions({ permissionModes: ["default", "auto"] })), ["auto"]);
  assert.deepEqual(values(mod.capabilityModeOptions(claudeCapabilities())), ["dontAsk", "auto"]);
  mod.capabilityModeOptions(claudeCapabilities()).forEach(function (o) {
    assert.ok(o.label && o.desc, o.value + " has a label and a description");
  });
});
