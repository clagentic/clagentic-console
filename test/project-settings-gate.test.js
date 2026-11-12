"use strict";
// Every project- or folder-scoped setting write needs the projectSettings
// permission AND access to the project it lands on, answered by the one rule
// in lib/project-settings-gate.js. One row per handler; each row runs for a
// caller without the permission, a caller with it but no access to the target
// project, the project owner and an administrator. A refusal stores nothing,
// broadcasts nothing, is logged and answers one fixed error. Single-user mode
// keeps working.

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
  // Member of the project, but the permission is off.
  noperm: { id: "u-noperm", username: "noperm", role: "user" },
  // Holds the permission, is not on the project.
  noaccess: { id: "u-noaccess", username: "noaccess", role: "user", permissions: { projectSettings: true } },
};

function userList() { return Object.keys(USERS).map(function (k) { return USERS[k]; }); }

var usersModule = attachPermissions({
  loadUsers: function () { return { users: userList() }; },
  saveUsers: noop,
  findUserById: function (id) { return userList().filter(function (u) { return u.id === id; })[0] || null; },
});

// A private project owned by u-owner, with u-noperm on its member list.
function onGetProjectAccess(slug) {
  if (slug !== TARGET && slug !== HOME_SLUG) return null;
  return { ownerId: USERS.owner.id, visibility: "private", allowedUsers: [USERS.noperm.id] };
}

// Which daemon callback stores the write, and the message that triggers it.
// scope "slug": the handler acts on msg.slug; "conn": on the connection's project.
var ROWS = [
  { type: "set_project_title", msg: { slug: TARGET, title: "T" }, optName: "onSetProjectTitle", scope: "slug" },
  { type: "set_project_icon", msg: { slug: TARGET, icon: "x" }, optName: "onSetProjectIcon", scope: "slug" },
  { type: "set_project_preferred_agent", msg: { slug: TARGET, agent: null }, optName: "onSetProjectPreferredAgent", scope: "slug" },
  { type: "set_project_folder", msg: { slug: TARGET, folderName: "f" }, optName: "onSetProjectFolder", scope: "slug" },
  { type: "rename_project_folder", msg: { oldName: "a", newName: "b" }, optName: "onRenameProjectFolder", scope: "conn" },
  { type: "set_folder_icon", msg: { folderName: "f", icon: "x" }, optName: "onSetFolderIcon", scope: "conn" },
  { type: "set_project_default_model", msg: { model: "opus" }, optName: "onSetProjectDefaultModel", scope: "conn" },
  { type: "set_project_default_effort", msg: { effort: "high" }, optName: "onSetProjectDefaultEffort", scope: "conn" },
  { type: "set_project_default_betas", msg: { betas: ["b1"] }, optName: "onSetProjectDefaultBetas", scope: "conn" },
  { type: "set_project_default_mode", msg: { mode: "plan" }, optName: "onSetProjectDefaultMode", scope: "conn" },
  { type: "set_project_env", msg: { envrc: "A=1" }, optName: "onSetProjectEnv", scope: "conn", fs: true },
];

function build(row, multiUser) {
  var sent = [];
  var broadcast = [];
  var calls = [];
  var opts = {};
  opts[row.optName] = function () { calls.push(Array.prototype.slice.call(arguments)); return { ok: true }; };
  var projectAccess = createProjectAccess({
    users: usersModule, onGetProjectAccess: onGetProjectAccess, isMultiUser: function () { return multiUser; },
  });
  var sendTo = function (ws, m) { sent.push(m); };
  var send = function (m) { broadcast.push(m); };
  if (row.fs) {
    var fsHandlers = attachFilesystem({
      cwd: "/tmp/test-project-settings-gate", slug: HOME_SLUG, osUsers: false, sm: { sessions: new Map() },
      send: send, sendTo: sendTo, getOsUserInfoForWs: function () { return null; },
      startFileWatch: noop, stopFileWatch: noop, startDirWatch: noop,
      usersModule: usersModule, fsAsUser: noop, validateEnvString: function () { return null; },
      getEnvOwnerId: function () { return USERS.owner.id; },
      projectAccess: projectAccess, opts: opts, IGNORED_DIRS: new Set(), IMAGE_EXTS: new Set(),
    });
    return { sent: sent, broadcast: broadcast, calls: calls, handle: fsHandlers.handleFilesystemMessage };
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
    opts: opts, usersModule: usersModule, userPresence: { setPresence: noop }, pushModule: null,
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
  var handlers = attachSessions(ctx);
  return { sent: sent, broadcast: broadcast, calls: calls, sm: sm, handle: handlers.handleSessionsMessage };
}

function socket(user) {
  return { readyState: 1, send: noop, _clagenticUser: user, _clagenticAuthenticated: true };
}

function run(row, multiUser, user) {
  var t = build(row, multiUser);
  var warnings = [];
  var original = console.warn;
  console.warn = function (line) { warnings.push(String(line)); };
  try {
    t.handle(socket(user), Object.assign({ type: row.type }, row.msg));
  } finally {
    console.warn = original;
  }
  t.warnings = warnings;
  return t;
}

function assertRefused(row, t, expectedSlug) {
  assert.deepEqual(t.calls, [], row.type + ": nothing is stored");
  assert.deepEqual(t.broadcast, [], row.type + ": nothing is broadcast");
  if (t.sm) {
    assert.equal(t.sm.currentModel, "sonnet", row.type + ": in-memory model unchanged");
    assert.equal(t.sm.currentEffort, "medium", row.type + ": in-memory effort unchanged");
    assert.deepEqual(t.sm.currentBetas, [], row.type + ": in-memory betas unchanged");
  }
  assert.equal(t.sent.length, 1, row.type + ": one reply");
  assert.deepEqual(t.sent[0], { type: "error", text: "Project settings access is not permitted" });
  var lines = t.warnings.filter(function (w) { return w.indexOf("refused " + row.type + " for \"" + expectedSlug + "\"") !== -1; });
  assert.equal(lines.length, 1, row.type + ": the refusal is logged with the type and slug");
}

function assertAllowed(row, t) {
  assert.equal(t.calls.length, 1, row.type + ": the write is made once");
  assert.ok(t.sent.every(function (m) { return m.type !== "error"; }), row.type + ": no refusal");
  assert.deepEqual(t.warnings, [], row.type + ": nothing logged");
}

ROWS.forEach(function (row) {
  var slug = row.scope === "slug" ? TARGET : HOME_SLUG;

  test(row.type + ": refused without the projectSettings permission", function () {
    assertRefused(row, run(row, true, USERS.noperm), slug);
  });

  test(row.type + ": refused with the permission but no access to the target project", function () {
    assertRefused(row, run(row, true, USERS.noaccess), slug);
  });

  test(row.type + ": the project owner's write works", function () {
    assertAllowed(row, run(row, true, USERS.owner));
  });

  test(row.type + ": an administrator's write works", function () {
    assertAllowed(row, run(row, true, USERS.admin));
  });

  test(row.type + ": single-user mode is unchanged", function () {
    assertAllowed(row, run(row, false, null));
  });
});

test("a multi-user connection with no user is refused", function () {
  var row = ROWS[0];
  assertRefused(row, run(row, true, null), TARGET);
});

test("a slug-taking setter checks the slug in the message, not the connection's project", function () {
  var row = { type: "set_project_title", msg: { slug: "other-project", title: "T" }, optName: "onSetProjectTitle" };
  assertRefused(row, run(row, true, USERS.owner), "other-project");
});
