"use strict";
// One journal line per socket connect and disconnect, with matching client ids,
// and a per-project open-socket count in the activity diagnostics.

var test = require("node:test");
var assert = require("node:assert/strict");
var EventEmitter = require("events");

var { attachConnection } = require("../lib/project-connection");
var { buildActivityDiagnosticsResponse } = require("../lib/sdk-bridge");

function makeFakeWs() {
  var ws = new EventEmitter();
  ws.readyState = 1;
  ws._sent = [];
  ws.send = function (data) { ws._sent.push(data); };
  ws.terminate = function () { ws._terminated = true; };
  ws.close = function () { ws._closed = true; };
  return ws;
}

function makeSession(id) {
  return {
    localId: id,
    cliSessionId: null,
    history: [],
    isProcessing: false,
    pendingPermissions: {},
    hidden: false,
    lastActivity: Date.now(),
  };
}

function makeCtx(overrides) {
  var clients = new Set();
  var sessions = new Map();

  var ctx = Object.assign({
    cwd: "/tmp/test-fbb7",
    slug: "test-fbb7",
    isMate: false,
    osUsers: false,
    debug: false,
    dangerouslySkipPermissions: false,
    currentVersion: "0.0.0",
    lanHost: null,
    sm: {
      sessions: sessions,
      activeSessionId: null,
      defaultVendor: "claude",
      availableModels: [],
      modelsByVendor: {},
      currentModel: null,
      slashCommands: null,
      capabilitiesByVendor: {},
      createSession: function (opts, ws) {
        var s = makeSession(1);
        sessions.set(1, s);
        return s;
      },
      saveSessionFile: function () {},
      loadSessionHistory: function () {},
      replayHistory: function () {},
      buildSessionSwitchedMessage: function (s, hasHistory) {
        return { type: "session_switched", id: s.localId, hasHistory: !!hasHistory, isProcessing: !!s.isProcessing };
      },
      mapSessionForClient: function (s) { return s; },
      // lr-041af8: connect-path hydration now calls sm.effectiveSessionModel()
      // instead of reading sm.currentModel directly — mirror the real
      // session-model-first-else-default fallback (see sessions.js).
      effectiveSessionModel: function (session) {
        return (session && session.model) || this.currentModel || "";
      },
    },
    tm: { list: function () { return []; }, detachAll: function () {} },
    nm: { list: function () { return []; } },
    clients: clients,
    send: function () {},
    sendTo: function (ws, msg) { ws._sent.push(msg); },
    opts: {},
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
    getLatestVersion: function () { return "0.0.0"; },
    getTitle: function () { return "Test Project"; },
    getProject: function () { return "test-fbb7"; },
    warmup: null,
  }, overrides);

  return ctx;
}


function captureLog(fn) {
  var lines = [];
  var orig = console.log;
  console.log = function () { lines.push(Array.prototype.join.call(arguments, " ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.filter(function (l) { return l.indexOf("[connection]") === 0; });
}

function field(line, key) {
  var m = new RegExp(" " + key + "=(\\S+)").exec(line);
  return m && m[1];
}

// A project with one existing session, the common case: a connecting client
// is restored into it.
function ctxWithSession(slug) {
  var ctx = makeCtx({ slug: slug });
  var s = makeSession(5);
  s.ownerId = "user-7";
  ctx.sm.sessions.set(5, s);
  return ctx;
}

function connect(conn, ws, user) {
  conn.handleConnection(ws, user, function () {}, function () {});
}

test("one connect and one disconnect line per socket, with matching client ids", function () {
  var conn = attachConnection(ctxWithSession("ws-log-a"));
  var ws = makeFakeWs();
  var lines = captureLog(function () {
    connect(conn, ws, { id: "user-7" });
    conn.handleDisconnection(ws);
    conn.handleDisconnection(ws);
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[connection\] connect: /);
  assert.match(lines[1], /^\[connection\] disconnect: /);
  assert.equal(field(lines[0], "project"), "ws-log-a");
  assert.equal(field(lines[0], "user"), "user-7");
  assert.equal(field(lines[0], "session"), "5");
  assert.match(field(lines[0], "client"), /^c-[0-9a-f]{8}$/);
  assert.equal(field(lines[1], "client"), field(lines[0], "client"));
  assert.equal(field(lines[1], "user"), "user-7");
  assert.equal(field(lines[1], "session"), "5");
  assert.match(field(lines[1], "duration_s"), /^\d+$/);
});

test("two sockets get different client ids", function () {
  var conn = attachConnection(makeCtx({ slug: "ws-log-b" }));
  var a = makeFakeWs();
  var b = makeFakeWs();
  var lines = captureLog(function () { connect(conn, a, null); connect(conn, b, null); });
  assert.equal(lines.length, 2);
  assert.notEqual(field(lines[0], "client"), field(lines[1], "client"));
  assert.equal(field(lines[0], "user"), "-");
  conn.handleDisconnection(a);
  conn.handleDisconnection(b);
});

test("no credential text appears when the request carries a ticket and a cookie", function () {
  var conn = attachConnection(makeCtx({ slug: "ws-log-c" }));
  var ws = makeFakeWs();
  ws.upgradeReq = {
    url: "/p/ws-log-c/ws?ticket=TICKET-SECRET-123",
    headers: { cookie: "session=COOKIE-SECRET-456", authorization: "Bearer HEADER-SECRET-789" },
    socket: { remoteAddress: "203.0.113.77" },
  };
  ws._socket = { remoteAddress: "203.0.113.77" };
  var lines = captureLog(function () {
    connect(conn, ws, { id: "user-9", username: "alice-login", email: "alice@example.com" });
    conn.handleDisconnection(ws);
  });
  assert.equal(lines.length, 2);
  lines.forEach(function (l) {
    ["TICKET-SECRET", "COOKIE-SECRET", "HEADER-SECRET", "203.0.113.77", "alice-login", "alice@example.com"].forEach(function (bad) {
      assert.ok(l.indexOf(bad) === -1, "line must not contain " + bad);
    });
  });
});

test("the open-socket count rises and falls per project", function () {
  var conn = attachConnection(makeCtx({ slug: "ws-log-d" }));
  var a = makeFakeWs();
  var b = makeFakeWs();
  captureLog(function () { connect(conn, a, null); connect(conn, b, null); });
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-d"], 2);
  captureLog(function () { conn.handleDisconnection(a); });
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-d"], 1);
  captureLog(function () { conn.handleDisconnection(b); });
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-d"], undefined);
});

// The two tests below drive the real project context, so the session field
// comes from the real session manager rather than a stand-in.
var fs = require("fs");
var os = require("os");
var path = require("path");

function withRealProject(t, slug) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-wslog-home-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-wslog-cwd-"));
  var prevHome = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  ["../lib/config", "../lib/sessions", "../lib/utils", "../lib/project"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var ctx = require("../lib/project").createProjectContext({
    cwd: cwd, slug: slug, title: slug, debug: false, currentVersion: "0.0.0",
  });
  t.after(function () {
    try { ctx.destroy({ reason: "test" }); } catch (e) { /* already destroyed by the test */ }
    if (prevHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return ctx;
}

test("a fresh connect that auto-creates a session logs the same session on connect and disconnect", function (t) {
  var ctx = withRealProject(t, "ws-log-e");
  var ws = makeFakeWs();
  var lines = captureLog(function () {
    ctx.handleConnection(ws, null);
    ctx.handleDisconnection(ws);
  });
  assert.equal(lines.length, 2);
  assert.notEqual(field(lines[0], "session"), "-");
  assert.equal(field(lines[1], "session"), field(lines[0], "session"));
  assert.equal(field(lines[1], "session"), String(ws._clagenticActiveSession));
});

test("when the session bind is refused, connect and disconnect log the same value", function () {
  var ctx = makeCtx({ slug: "ws-log-f" });
  // The stand-in session manager creates a session without binding it to the
  // socket, as the real one does when its access check refuses.
  var conn = attachConnection(ctx);
  var ws = makeFakeWs();
  var lines = captureLog(function () {
    connect(conn, ws, null);
    conn.handleDisconnection(ws);
  });
  assert.equal(lines.length, 2);
  assert.equal(field(lines[1], "session"), field(lines[0], "session"));
});

test("destroying a project drops its sockets from the open-socket count", function (t) {
  var ctx = withRealProject(t, "ws-log-g");
  var a = makeFakeWs();
  var b = makeFakeWs();
  var lines = captureLog(function () { ctx.handleConnection(a, null); ctx.handleConnection(b, null); });
  assert.equal(lines.length, 2);
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-g"], 2);
  var out = captureLog(function () { ctx.destroy({ reason: "test" }); });
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-g"], undefined);
  assert.equal(out.filter(function (l) { return l.indexOf("[connection] disconnect:") === 0; }).length, 2);
  // The close events arriving after the destroy change nothing.
  var late = captureLog(function () { a.emit("close"); b.emit("close"); });
  assert.equal(late.length, 0);
  assert.equal(buildActivityDiagnosticsResponse().openSockets["ws-log-g"], undefined);
});
