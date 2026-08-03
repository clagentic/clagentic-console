"use strict";
// Regression test for lr-fbb7: client WebSockets registered only 'message'
// and 'close' handlers. The ws library emits 'error' on socket faults
// (e.g. ECONNRESET). With no 'error' listener, Node's EventEmitter re-throws
// the error, which reaches the daemon's uncaughtException handler and calls
// gracefulShutdown() — tearing down every project/session for a single
// client's network blip.
//
// Fix: register ws.on('error', ...) in handleConnection (project-connection.js)
// so a per-client socket fault only logs and drops that socket.
//
// This test drives the real attachConnection().handleConnection against a
// minimal stub ctx and asserts:
//   1. Emitting 'error' on the ws does NOT throw (i.e. a listener is present).
//   2. Only the errored socket is affected — other clients are untouched.
//   3. No daemon-level teardown hook is invoked.

var test = require("node:test");
var assert = require("node:assert/strict");
var EventEmitter = require("events");

var { attachConnection } = require("../lib/project-connection");

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
      mapSessionForClient: function (s) { return s; },
      // lr-041af8: connect-path hydration now calls sm.effectiveSessionModel()
      // instead of reading sm.currentModel directly — mirror the real
      // session-model-first-else-default fallback (see sessions.js).
      effectiveSessionModel: function (session) {
        return (session && session.model) || this.currentModel || "";
      },
    },
    tm: { list: function () { return []; } },
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

test("lr-fbb7: ws 'error' listener is registered so socket errors do not throw", function () {
  var ctx = makeCtx();
  var conn = attachConnection(ctx);
  var ws = makeFakeWs();

  var handleMessageCalls = [];
  var handleDisconnectionCalls = [];

  conn.handleConnection(
    ws,
    { id: "user-1" },
    function (w, msg) { handleMessageCalls.push(msg); },
    function (w) { handleDisconnectionCalls.push(w); }
  );

  assert.equal(ws.listenerCount("error"), 1, "handleConnection must register exactly one 'error' listener");

  // Simulating ECONNRESET must not throw (no listener = EventEmitter re-throws).
  assert.doesNotThrow(function () {
    ws.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  }, "a per-client socket error must not propagate as an uncaught exception");

  assert.ok(ws._terminated, "the errored socket should be terminated");
});

test("lr-fbb7: a socket error on one client does not affect other clients", function () {
  var ctx = makeCtx();
  var conn = attachConnection(ctx);

  var wsA = makeFakeWs();
  var wsB = makeFakeWs();

  conn.handleConnection(wsA, { id: "user-a" }, function () {}, function () {});
  // Second connection reuses the session created for the first (sm.sessions
  // already populated), matching real multi-client behavior for one project.
  conn.handleConnection(wsB, { id: "user-b" }, function () {}, function () {});

  // Fault only wsA.
  wsA.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

  assert.ok(wsA._terminated, "errored socket should be terminated");
  assert.ok(!wsB._terminated, "unrelated socket must be unaffected by another client's socket error");
  assert.equal(wsB.listenerCount("error"), 1, "unrelated socket keeps its own error listener intact");
});

test("lr-fbb7: a socket error does not invoke process-level teardown (no gracefulShutdown proxy called)", function () {
  var ctx = makeCtx();
  var conn = attachConnection(ctx);
  var ws = makeFakeWs();

  var teardownCalls = [];
  // Simulate the daemon's uncaughtException -> gracefulShutdown path as an
  // external hook. It must never be reached for a per-client socket fault.
  var fakeGracefulShutdown = function () { teardownCalls.push(true); };
  var uncaughtHandler = function (err) {
    // Mirrors daemon.js: anything not AbortError/EIO/EPIPE calls gracefulShutdown.
    var msg = err && err.message ? err.message : String(err);
    var isAbort = msg.indexOf("AbortError") !== -1;
    var isIOError = msg.indexOf("EIO") !== -1 || msg.indexOf("EPIPE") !== -1;
    if (!isAbort && !isIOError) fakeGracefulShutdown();
  };
  process.on("uncaughtException", uncaughtHandler);

  try {
    conn.handleConnection(ws, { id: "user-1" }, function () {}, function () {});
    ws.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  } finally {
    process.removeListener("uncaughtException", uncaughtHandler);
  }

  assert.equal(teardownCalls.length, 0, "gracefulShutdown-equivalent must not be triggered by a per-client socket error");
});
