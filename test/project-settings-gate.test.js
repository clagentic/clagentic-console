"use strict";
// Every project- or folder-scoped setting message needs the projectSettings
// permission AND access to what it writes to, answered by the one rule in
// lib/project-settings-gate.js. One table row per message type, one test per
// row; each row runs its callers (no permission, no access, access to the
// connection project only, owner, administrator, single-user mode, no user).
// A refusal stores nothing, broadcasts nothing, is logged and answers one
// fixed error. A folder setter must reach every project in the named folder.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");
var { attachFilesystem } = require("../lib/project-filesystem");
var { createProjectAccess } = require("../lib/project-access");
var { attachPermissions } = require("../lib/users-permissions");

var noop = function () {};
var TARGET = "target";
var HOME_SLUG = "home";

var USERS = {
  owner: { id: "u-owner", username: "owner", role: "user", permissions: { projectSettings: true } },
  admin: { id: "u-admin", username: "admin", role: "admin" },
  // Member of both projects, but the permission is off.
  noperm: { id: "u-noperm", username: "noperm", role: "user" },
  // Holds the permission, is on neither project.
  noaccess: { id: "u-noaccess", username: "noaccess", role: "user", permissions: { projectSettings: true } },
  // Holds the permission and is on the connection's project, not on TARGET.
  partial: { id: "u-partial", username: "partial", role: "user", permissions: { projectSettings: true } },
};

function userList() { return Object.keys(USERS).map(function (k) { return USERS[k]; }); }

var usersModule = attachPermissions({
  loadUsers: function () { return { users: userList() }; },
  saveUsers: noop,
  findUserById: function (id) { return userList().filter(function (u) { return u.id === id; })[0] || null; },
});

// Two private projects owned by u-owner; "partial" is on HOME_SLUG only.
function onGetProjectAccess(slug) {
  if (slug === TARGET) return { ownerId: USERS.owner.id, visibility: "private", allowedUsers: [USERS.noperm.id] };
  if (slug === HOME_SLUG) {
    return { ownerId: USERS.owner.id, visibility: "private", allowedUsers: [USERS.noperm.id, USERS.partial.id] };
  }
  return null;
}

// Folders are server-wide: folder "f" holds both projects.
var FOLDERS = { f: [HOME_SLUG, TARGET], empty: [], solo: [HOME_SLUG] };
function getFolderProjectSlugs(name) { return FOLDERS[name] || []; }

// scope "slug": acts on msg.slug; "conn": on the connection's project;
// "folder": on every project in the named folder. handlers: "fs" runs the
// filesystem handler, "chain" runs it and then the sessions handler (the
// order the project runs them in); the default is the sessions handler.
// ownerOnly: the handler's own rule limits it to the owner and administrators
// after the gate, so the connection-project member is not exercised for it.
// noSingleUser: the handler needs a user record.
var ROWS = [
  { type: "set_project_title", msg: { slug: TARGET, title: "T" }, optName: "onSetProjectTitle", scope: "slug" },
  { type: "set_project_icon", msg: { slug: TARGET, icon: "x" }, optName: "onSetProjectIcon", scope: "slug" },
  { type: "set_project_preferred_agent", msg: { slug: TARGET, agent: null }, optName: "onSetProjectPreferredAgent", scope: "slug" },
  { type: "set_project_folder", msg: { slug: TARGET, folderName: "f" }, optName: "onSetProjectFolder", scope: "slug" },
  { type: "rename_project_folder", msg: { oldName: "f", newName: "b" }, optName: "onRenameProjectFolder", scope: "folder", folder: "f" },
  { type: "set_folder_icon", msg: { folderName: "f", icon: "x" }, optName: "onSetFolderIcon", scope: "folder", folder: "f" },
  { type: "set_project_default_model", msg: { model: "opus" }, optName: "onSetProjectDefaultModel", scope: "conn" },
  { type: "set_project_default_effort", msg: { effort: "high" }, optName: "onSetProjectDefaultEffort", scope: "conn" },
  { type: "set_project_default_betas", msg: { betas: ["b1"] }, optName: "onSetProjectDefaultBetas", scope: "conn" },
  { type: "set_project_default_mode", msg: { mode: "plan" }, optName: "onSetProjectDefaultMode", scope: "conn", ownerOnly: true },
  { type: "set_project_env", msg: { envrc: "A=1" }, optName: "onSetProjectEnv", scope: "conn", handlers: "fs", ownerOnly: true },
  { type: "get_project_env", msg: {}, optName: "onGetProjectEnv", scope: "conn", handlers: "fs", ownerOnly: true },
  {
    type: "transfer_project_owner", msg: { userId: USERS.noperm.id }, optName: "onProjectOwnerChanged",
    scope: "conn", handlers: "chain", ownerOnly: true, noSingleUser: true,
  },
];

function build(row, multiUser) {
  var sent = [];
  var broadcast = [];
  var calls = [];
  var opts = { getFolderProjectSlugs: getFolderProjectSlugs };
  opts[row.optName] = function () { calls.push(Array.prototype.slice.call(arguments)); return { ok: true }; };
  var projectAccess = createProjectAccess({
    users: usersModule, onGetProjectAccess: onGetProjectAccess, isMultiUser: function () { return multiUser; },
  });
  var sendTo = function (ws, m) { sent.push(m); };
  var send = function (m) { broadcast.push(m); };
  var fsHandle = null;
  if (row.handlers === "fs" || row.handlers === "chain") {
    fsHandle = attachFilesystem({
      cwd: "/tmp/test-project-settings-gate", slug: HOME_SLUG, osUsers: false, sm: { sessions: new Map() },
      send: send, sendTo: sendTo, getOsUserInfoForWs: function () { return null; },
      startFileWatch: noop, stopFileWatch: noop, startDirWatch: noop,
      usersModule: usersModule, fsAsUser: noop, validateEnvString: function () { return null; },
      getEnvOwnerId: function () { return USERS.owner.id; },
      projectAccess: projectAccess, opts: opts, IGNORED_DIRS: new Set(), IMAGE_EXTS: new Set(),
    }).handleFilesystemMessage;
    if (row.handlers === "fs") {
      return { sent: sent, broadcast: broadcast, calls: calls, handle: fsHandle };
    }
  }
  var sm = {
    sessions: new Map(), currentModel: "sonnet", _savedDefaultModel: "sonnet", currentEffort: "medium",
    currentBetas: [], currentPermissionMode: "default", _savedDefaultMode: "default",
  };
  var ctx = {
    cwd: "/tmp/test-project-settings-gate", slug: HOME_SLUG, osUsers: false, currentVersion: "0.0.0",
    sm: sm,
    sdk: { setPermissionMode: function () { return Promise.resolve(true); }, checkModeFor: function () { return { ok: true }; } },
    tm: { list: function () { return []; } }, clients: new Set(),
    send: send, sendTo: sendTo,
    sendToAdmins: noop, sendToSession: noop, sendToSessionOthers: noop,
    opts: opts,
    // transfer_project_owner looks the new owner up on the users module.
    usersModule: Object.assign({}, usersModule, {
      findUserById: function (id) { return userList().filter(function (u) { return u.id === id; })[0] || null; },
    }),
    userPresence: { setPresence: noop }, pushModule: null,
    getSessionForWs: function () { return null; }, getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop, getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; }, onProcessingChanged: noop, broadcastPresence: noop,
    adapter: null, getProjectList: function () { return []; }, getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; }, moveScheduleToProject: noop, moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; }, fetchVersion: noop, isNewer: function () { return false; },
    IGNORED_DIRS: new Set(), scheduleMessage: noop, cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return USERS.owner.id; }, setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; }, setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; }, setLatestVersion: noop,
    projectAccess: projectAccess,
  };
  var sessionsHandle = attachSessions(ctx).handleSessionsMessage;
  var handle = fsHandle
    ? function (ws, msg) { return fsHandle(ws, msg) || sessionsHandle(ws, msg); }
    : sessionsHandle;
  return { sent: sent, broadcast: broadcast, calls: calls, sm: sm, handle: handle };
}

function socket(user) {
  return { readyState: 1, send: noop, _clagenticUser: user, _clagenticAuthenticated: true };
}

function run(row, multiUser, user, msgOverride) {
  var t = build(row, multiUser);
  var warnings = [];
  var original = console.warn;
  console.warn = function (line) { warnings.push(String(line)); };
  try {
    t.handle(socket(user), Object.assign({ type: row.type }, msgOverride || row.msg));
  } finally {
    console.warn = original;
  }
  t.warnings = warnings;
  return t;
}

// The target the refusal log names.
function labelOf(row) {
  if (row.scope === "folder") return "folder \"" + row.folder + "\"";
  return "\"" + (row.scope === "slug" ? TARGET : HOME_SLUG) + "\"";
}

function assertRefused(who, row, t, label) {
  var what = row.type + " / " + who;
  assert.deepEqual(t.calls, [], what + ": nothing is stored");
  assert.deepEqual(t.broadcast, [], what + ": nothing is broadcast");
  if (t.sm) {
    assert.equal(t.sm.currentModel, "sonnet", what + ": in-memory model unchanged");
    assert.equal(t.sm.currentEffort, "medium", what + ": in-memory effort unchanged");
    assert.deepEqual(t.sm.currentBetas, [], what + ": in-memory betas unchanged");
  }
  assert.equal(t.sent.length, 1, what + ": one reply");
  assert.deepEqual(t.sent[0], { type: "error", text: "Project settings access is not permitted" }, what);
  var lines = t.warnings.filter(function (w) { return w.indexOf("refused " + row.type + " for " + label) !== -1; });
  assert.equal(lines.length, 1, what + ": the refusal is logged with the type and target");
}

function assertAllowed(who, row, t) {
  var what = row.type + " / " + who;
  assert.equal(t.calls.length, 1, what + ": the write is made once");
  assert.ok(t.sent.every(function (m) { return m.type !== "error"; }), what + ": no refusal");
  assert.deepEqual(t.warnings, [], what + ": nothing logged");
}

ROWS.forEach(function (row) {
  test(row.type + ": gated by permission and access to its target, by caller", function () {
    var label = labelOf(row);
    assertRefused("no permission", row, run(row, true, USERS.noperm), label);
    assertRefused("no access", row, run(row, true, USERS.noaccess), label);
    assertRefused("no user", row, run(row, true, null), label);
    if (!row.ownerOnly) {
      // Access to the connection's project is enough only where the write
      // lands on that project alone.
      if (row.scope === "conn") assertAllowed("connection-project member", row, run(row, true, USERS.partial));
      else assertRefused("connection-project member", row, run(row, true, USERS.partial), label);
    }
    assertAllowed("owner", row, run(row, true, USERS.owner));
    assertAllowed("administrator", row, run(row, true, USERS.admin));
    if (!row.noSingleUser) assertAllowed("single-user", row, run(row, false, null));
  });
});

test("folder setters fail closed for a folder that is empty or unknown, and admins pass", function () {
  ["rename_project_folder", "set_folder_icon"].forEach(function (type) {
    var row = ROWS.filter(function (r) { return r.type === type; })[0];
    var key = type === "rename_project_folder" ? "oldName" : "folderName";
    ["empty", "missing"].forEach(function (name) {
      var msg = Object.assign({}, row.msg);
      msg[key] = name;
      var label = "folder \"" + name + "\"";
      assertRefused(type + " " + name, row, run(row, true, USERS.owner, msg), label);
      assertRefused(type + " " + name, row, run(row, true, USERS.noaccess, msg), label);
      assertAllowed(type + " " + name, row, run(row, true, USERS.admin, msg));
    });
    // A folder holding only the connection project is within the member's reach.
    var solo = Object.assign({}, row.msg);
    solo[key] = "solo";
    assertAllowed(type + " solo", row, run(row, true, USERS.partial, solo));
  });
});

test("set_project_default_mode keeps the owner's right without the permission", function () {
  var row = ROWS.filter(function (r) { return r.type === "set_project_default_mode"; })[0];
  var ownerWithoutPermission = { id: USERS.owner.id, username: "owner", role: "user" };
  assertAllowed("owner without permission", row, run(row, true, ownerWithoutPermission));
});

test("a slug-taking setter checks the slug in the message, not the connection's project", function () {
  var row = { type: "set_project_title", msg: { slug: "other-project", title: "T" }, optName: "onSetProjectTitle" };
  assertRefused("owner", row, run(row, true, USERS.owner), "\"other-project\"");
});
