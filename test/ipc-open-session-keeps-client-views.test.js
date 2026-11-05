"use strict";
// An IPC open_session (open-session, send-input that opens a session, the file
// drop) creates and lists a session without moving any connected browser tab.
// A browser "new session" still moves only the tab that asked. Real session
// manager and real session-input over two fake clients on one project.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { removeTempHome } = require("./helpers/remove-temp-home");
var { createSessionInput } = require("../lib/session-input");

test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

function makeWorld() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-ipc-open-"));
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  var origLegacyHome = process.env.CLAGENTIC_HOME;
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  delete process.env.CLAGENTIC_HOME;
  var sessionsModule = require("../lib/sessions");

  var clients = [];
  function makeClient(name) {
    var c = { name: name, readyState: 1, frames: [], _clagenticUser: null, _clagenticActiveSession: null };
    c.send = function (data) { c.frames.push(typeof data === "string" ? JSON.parse(data) : data); };
    clients.push(c);
    return c;
  }
  var sm = sessionsModule.createSessionManager({
    cwd: home,
    send: function (obj) { clients.forEach(function (c) { c.send(JSON.stringify(obj)); }); },
    sendTo: function (ws, obj) { ws.send(JSON.stringify(obj)); },
    sendEach: function (fn) { clients.forEach(function (c) { fn(c); }); },
  });
  var first = sm.getActiveSession();
  var project = {
    cwd: home,
    sm: sm,
    sdk: { startQuery: function () {} },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    checkPermissionModeFor: function () { return { ok: true }; },
  };
  return {
    sm: sm,
    project: project,
    first: first,
    makeClient: makeClient,
    cleanup: function () {
      if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
      if (origLegacyHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origLegacyHome;
      removeTempHome(home);
    },
  };
}

function twoClientsOnFirst(world) {
  var a = world.makeClient("one");
  var b = world.makeClient("two");
  a._clagenticActiveSession = world.first.localId;
  b._clagenticActiveSession = world.first.localId;
  return [a, b];
}

function types(client) { return client.frames.map(function (f) { return f.type; }); }

function lastSessionList(client) {
  var lists = client.frames.filter(function (f) { return f.type === "session_list"; });
  return lists.length ? lists[lists.length - 1] : null;
}

test("IPC open_session leaves both clients on their session, with no switch or replay, and lists the new one", function () {
  var world = makeWorld();
  try {
    var clients = twoClientsOnFirst(world);
    var activeBefore = world.sm.activeSessionId;
    var input = createSessionInput({
      getProject: function (slug) { return slug === "p" ? world.project : null; },
      agentCatalog: function () { return []; },
      getPermissionSettings: function () { return null; },
    });
    var r = input.openSession({ projectSlug: "p", prompt: "go" });
    assert.equal(r.result, "opened");
    var newId = Number(r.consoleSessionId);
    assert.notEqual(newId, world.first.localId);
    clients.forEach(function (c) {
      assert.equal(c._clagenticActiveSession, world.first.localId, c.name + " stays on its session");
      var t = types(c);
      assert.ok(!t.includes("session_switched"), c.name + " gets no session_switched");
      assert.ok(!t.includes("history_meta") && !t.includes("history_done"), c.name + " gets no history replay");
      var list = lastSessionList(c);
      assert.ok(list, c.name + " gets a session list");
      assert.ok(list.sessions.some(function (s) { return s.id === newId; }), c.name + " list holds the new session");
    });
    assert.equal(world.sm.activeSessionId, activeBefore, "the project default active session is unchanged");
  } finally { world.cleanup(); }
});

test("a browser new session switches only the client that asked", function () {
  var world = makeWorld();
  try {
    var clients = twoClientsOnFirst(world);
    var s = world.sm.createSession({}, clients[0]);
    assert.equal(clients[0]._clagenticActiveSession, s.localId);
    assert.equal(clients[1]._clagenticActiveSession, world.first.localId);
    assert.ok(types(clients[0]).includes("session_switched"));
    assert.ok(!types(clients[1]).includes("session_switched"));
    assert.ok(!types(clients[1]).includes("history_done"));
  } finally { world.cleanup(); }
});

test("createSession with no ws and no option still switches every client (loop callers unchanged)", function () {
  var world = makeWorld();
  try {
    var clients = twoClientsOnFirst(world);
    var s = world.sm.createSession();
    clients.forEach(function (c) { assert.equal(c._clagenticActiveSession, s.localId); });
  } finally { world.cleanup(); }
});

test("createSession with activate:false lists the session and changes no client binding or active id", function () {
  var world = makeWorld();
  try {
    var clients = twoClientsOnFirst(world);
    var s = world.sm.createSession({ activate: false });
    assert.ok(world.sm.sessions.has(s.localId));
    assert.equal(world.sm.activeSessionId, world.first.localId);
    clients.forEach(function (c) {
      assert.equal(c._clagenticActiveSession, world.first.localId);
      assert.ok(lastSessionList(c).sessions.some(function (x) { return x.id === s.localId; }));
    });
  } finally { world.cleanup(); }
});
