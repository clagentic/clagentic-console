"use strict";
// set_permission_settings: the WebSocket message that changes the server-wide
// permission settings. Admin only (like the server default mode), only known
// settings of the right type, the mode through the shared check, and the new
// values announced to every client.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var { createProjectAccess } = require("../lib/project-access");

var client = world.client;

function setup(server) {
  var stored = { autoApproveReadOnly: true, openedSessionMode: "acceptEdits" };
  var sets = [];
  var announced = [];
  var access = createProjectAccess({
    users: { canAccessProject: function () { return true; }, canAccessSession: function () { return true; } },
    isMultiUser: function () { return true; },
  });
  var ctx = Object.assign({}, server.handlerContext, {
    projectAccess: access,
    getProjectOwnerId: function () { return "owner-1"; },
    opts: {
      onGetPermissionSettings: function () { return Object.assign({}, stored); },
      onSetPermissionSettings: function (values) { sets.push(values); Object.assign(stored, values); return { ok: true }; },
      broadcastAll: function (msg) { announced.push(msg); },
    },
  });
  server.sm.capabilitiesByVendor = { claude: claudeCapabilities() };
  return { handlers: require(world.LIB_ROOT + "/project-sessions").attachSessions(ctx), sets: sets, announced: announced, stored: stored };
}

function who(server, user) {
  var c = client();
  c.ws._clagenticUser = user;
  c.ws._clagenticAuthenticated = true;
  server.connect(c.ws);
  c.inbox.length = 0;
  return c;
}

function errors(c) { return c.inbox.filter(function (m) { return m.type === "error"; }); }

test("only an admin may change the permission settings; the project owner and a user may not", async function () {
  var server = await world.createServer();
  try {
    var s = setup(server);
    var warn = console.warn;
    console.warn = function () {};
    try {
      [{ id: "owner-1", role: "user" }, { id: "u9", role: "user" }, null].forEach(function (user) {
        var c = who(server, user);
        s.handlers.handleSessionsMessage(c.ws, { type: "set_permission_settings", autoApproveReadOnly: false });
        assert.equal(errors(c).length, 1, JSON.stringify(user));
      });
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(s.sets, []);
    assert.equal(s.stored.autoApproveReadOnly, true);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("an admin's change is stored and announced to every client with both values", async function () {
  var server = await world.createServer();
  try {
    var s = setup(server);
    var admin = who(server, { id: "a1", role: "admin" });
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_permission_settings", autoApproveReadOnly: false });
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_permission_settings", openedSessionMode: "plan" });
    assert.deepEqual(s.sets, [{ autoApproveReadOnly: false }, { openedSessionMode: "plan" }]);
    assert.deepEqual(s.announced[s.announced.length - 1], { type: "permission_settings", autoApproveReadOnly: false, openedSessionMode: "plan" });
    assert.equal(errors(admin).length, 0);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("an unknown setting, a wrong type, or a mode the shared check refuses changes nothing", async function () {
  var server = await world.createServer();
  try {
    var s = setup(server);
    var admin = who(server, { id: "a1", role: "admin" });
    var warn = console.warn;
    console.warn = function () {};
    try {
      [
        { autoApproveReadOnly: "false" },
        { autoApproveReadOnly: false, extra: 1 },
        { openedSessionMode: 5 },
        { openedSessionMode: "bypassPermissions" },
        { openedSessionMode: "nonsense" },
      ].forEach(function (body) {
        s.handlers.handleSessionsMessage(admin.ws, Object.assign({ type: "set_permission_settings" }, body));
      });
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(s.sets, []);
    assert.equal(errors(admin).length, 5);
    assert.deepEqual(s.announced, []);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});
