"use strict";
/**
 * One table for the multi-user project-access rules of the project-management
 * messages: browse_dir, add_project, remove_project, remove_project_check,
 * remove_project with moveTasksTo, and transfer_project_owner, plus the
 * ownerLocked flag of the connect-time info message.
 *
 * Each row drives the real attachSessions() handler (or attachConnection())
 * with the real access resolver and permission module, and states what the
 * caller is refused or allowed. A refusal row also asserts that nothing the
 * message would have changed was touched.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachSessions } = require("../lib/project-sessions");
var { createProjectAccess } = require("../lib/project-access");
var { attachPermissions } = require("../lib/users-permissions");
var { getProjectAccessRecord, registerWorktreeSlug } = require("../lib/daemon-projects");
var osUsersLib = require("../lib/os-users");

// --- fixtures ---------------------------------------------------------------

var ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-access-")));
var HOMES = { alice: path.join(ROOT, "alice"), bob: path.join(ROOT, "bob") };
var OUTSIDE = path.join(ROOT, "outside");
[
  path.join(HOMES.alice, "proj"), path.join(HOMES.bob, "secret"), path.join(OUTSIDE, "loot"),
  path.join(HOMES.alice + "-x", "proj"),
].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
fs.symlinkSync(OUTSIDE, path.join(HOMES.alice, "escape"));

var realGetLinuxUserHome = osUsersLib.getLinuxUserHome;
test.before(function () {
  osUsersLib.getLinuxUserHome = function (u) { return HOMES[u] || "/home/" + u; };
});
test.after(function () {
  osUsersLib.getLinuxUserHome = realGetLinuxUserHome;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

var USERS = {
  adm: { id: "adm", role: "admin", username: "adm" },
  alice: { id: "alice", role: "user", username: "alice", linuxUser: "alice", permissions: { deleteProject: true, createProject: true } },
  mal: { id: "mal", role: "user", username: "mal", permissions: { deleteProject: true, createProject: true } },
  noperm: { id: "noperm", role: "user", username: "noperm", permissions: { createProject: false, deleteProject: false } },
  nolinux: { id: "nolinux", role: "user", username: "nolinux", permissions: { createProject: true } },
};

var CONFIG = {
  osUsers: false,
  projects: [
    { slug: "proj-a", visibility: "private", ownerId: "alice", allowedUsers: [] },
    { slug: "proj-a2", visibility: "private", ownerId: "alice", allowedUsers: [] },
    { slug: "proj-m", visibility: "private", ownerId: "mal", allowedUsers: [] },
    { slug: "proj-pub", visibility: "public", ownerId: "alice", allowedUsers: [] },
  ],
};
registerWorktreeSlug("proj-a", "proj-a--wt");

var permissions = attachPermissions({
  loadUsers: function () { return { users: [] }; },
  saveUsers: function () {},
  findUserById: function (id) { return USERS[id] || null; },
});
var usersModule = {
  getEffectivePermissions: permissions.getEffectivePermissions,
  canAccessProject: permissions.canAccessProject,
  canAccessSession: permissions.canAccessSession,
  findUserById: function (id) { return USERS[id] || null; },
};

function makeHarness(o) {
  var replies = [];
  var calls = { onAddProject: [], onRemoveProject: [], moveAll: [], scheduleCount: [], setOwner: [], ownerChanged: [] };
  var noop = function () {};
  var ctx = {
    cwd: o.cwd || "/srv/projects/proj-a",
    slug: "proj-a",
    osUsers: !!o.osUsers,
    currentVersion: "0.0.0",
    sm: { sessions: new Map() },
    sdk: null,
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (m) { replies.push(m); },
    sendTo: function (ws, m) { replies.push(m); },
    sendToAdmins: noop,
    sendToSession: noop,
    sendToSessionOthers: noop,
    opts: {
      onAddProject: function (abs) { calls.onAddProject.push(abs); return { ok: true, slug: "new" }; },
      onRemoveProject: function (slug) { calls.onRemoveProject.push(slug); return { ok: true }; },
      onProjectOwnerChanged: function (s, id) { calls.ownerChanged.push(id); },
    },
    usersModule: usersModule,
    projectAccess: createProjectAccess({
      users: usersModule,
      onGetProjectAccess: function (slug) { return getProjectAccessRecord(CONFIG, slug); },
      isMultiUser: function () { return true; },
    }),
    userPresence: { setPresence: noop },
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (x) { return x; },
    onProcessingChanged: noop,
    broadcastPresence: noop,
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function (s) { calls.scheduleCount.push(s); return 3; },
    moveScheduleToProject: noop,
    moveAllSchedulesToProject: function (from, to) { calls.moveAll.push([from, to]); },
    getHubSchedules: function () { return []; },
    fetchVersion: noop,
    isNewer: function () { return false; },
    onCreateWorktree: null,
    IGNORED_DIRS: new Set(),
    scheduleMessage: noop,
    cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return o.ownerId || null; },
    setProjectOwnerId: function (id) { calls.setOwner.push(id); },
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; },
    setLatestVersion: noop,
  };
  return { ctx: ctx, replies: replies, calls: calls };
}

function reply(h, type) {
  return h.replies.find(function (m) { return m.type === type; });
}
function untouched(h) {
  assert.deepEqual(h.calls.onAddProject, [], "no project entry is created");
  assert.deepEqual(h.calls.onRemoveProject, [], "no project is removed");
  assert.deepEqual(h.calls.moveAll, [], "no schedule is moved");
  assert.deepEqual(h.calls.scheduleCount, [], "no schedule count is read");
  assert.deepEqual(h.calls.setOwner, [], "ownership is unchanged");
  assert.deepEqual(h.calls.ownerChanged, [], "ownership change is not persisted");
}
// A refusal names nothing about the target: no slug, no count.
function discloses(h, needles) {
  var text = JSON.stringify(h.replies);
  return needles.filter(function (n) { return text.indexOf(n) !== -1; });
}

// --- the table --------------------------------------------------------------
// h: harness options; user: key of USERS; msg: the message; check(h): assertions.

var inAlice = function (p) { return path.join(HOMES.alice, p); };

var ROWS = [
  // AC1: browse_dir outside the caller's own home is refused.
  { name: "AC1 browse_dir: another user's home is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: HOMES.bob + "/" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries, []); assert.ok(reply(h, "browse_dir_result").error); } },
  { name: "AC1 browse_dir: a system directory is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: "/etc/" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries, []); assert.ok(reply(h, "browse_dir_result").error); } },
  { name: "AC1 browse_dir: a symlink out of the home is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: inAlice("escape") + "/" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries, []); assert.ok(reply(h, "browse_dir_result").error); } },
  { name: "AC1 browse_dir: a '..' escape is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: HOMES.alice + "/../bob/" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries, []); assert.ok(reply(h, "browse_dir_result").error); } },
  { name: "AC1 browse_dir: a typed prefix beside the home is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: HOMES.alice + "-x/pro" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries, []); assert.ok(reply(h, "browse_dir_result").error); } },

  // AC2 / AC3 / AC4: add_project.
  { name: "AC2 add_project: another user's home is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "add_project", path: path.join(HOMES.bob, "secret") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, false); untouched(h); } },
  { name: "AC2 add_project: a system directory is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "add_project", path: "/etc" },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, false); untouched(h); } },
  { name: "AC2 add_project: a symlink out of the home is refused", h: { osUsers: true }, user: "alice",
    msg: { type: "add_project", path: path.join(inAlice("escape"), "loot") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, false); untouched(h); } },
  { name: "AC3 add_project: a user with no Linux account is refused", h: { osUsers: true }, user: "nolinux",
    msg: { type: "add_project", path: path.join(HOMES.alice, "proj") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, false); untouched(h); } },
  { name: "AC4 add_project: a caller without createProject is refused", h: { osUsers: false }, user: "noperm",
    msg: { type: "add_project", path: path.join(HOMES.alice, "proj") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, false); untouched(h); } },

  // AC5: a deleteProject holder who is neither owner nor admin.
  { name: "AC5 remove_project: a non-owner is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "proj-a" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); assert.deepEqual(discloses(h, ["proj-a", "3"]), []); } },
  { name: "AC5 remove_project: a non-owner of a public project is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "proj-pub" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); } },
  { name: "AC5 remove_project: an unknown slug is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "no-such" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); } },
  { name: "AC5 remove_project_check: a non-owner learns nothing", h: {}, user: "mal",
    msg: { type: "remove_project_check", slug: "proj-a", name: "Alice" },
    check: function (h) {
      assert.equal(reply(h, "remove_project_check_result"), undefined);
      assert.ok(reply(h, "error"), "the client shows the refusal");
      untouched(h);
      assert.deepEqual(discloses(h, ["proj-a", "Alice", "count"]), []);
    } },
  { name: "AC5 moveTasksTo: a project the caller cannot reach is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "proj-m", moveTasksTo: "proj-a" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); } },

  // AC6: worktree slugs are judged by their parent project.
  { name: "AC6 remove_project: a worktree of another's project is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "proj-a--wt" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); } },
  { name: "AC6 remove_project_check: a worktree of another's project is refused", h: {}, user: "mal",
    msg: { type: "remove_project_check", slug: "proj-a--wt" },
    check: function (h) { assert.equal(reply(h, "remove_project_check_result"), undefined); assert.ok(reply(h, "error")); untouched(h); } },
  { name: "AC6 moveTasksTo: a worktree of another's project is refused", h: {}, user: "mal",
    msg: { type: "remove_project", slug: "proj-m", moveTasksTo: "proj-a--wt" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, false); untouched(h); } },

  // AC7: the owner lock on a project under /home/<user>/.
  { name: "AC7 transfer_project_owner: refused for a non-admin in os-users mode under /home", h: { osUsers: true, cwd: "/home/alice/proj", ownerId: "alice" }, user: "alice",
    msg: { type: "transfer_project_owner", userId: "mal" },
    check: function (h) { assert.ok(reply(h, "error")); assert.equal(reply(h, "project_owner_changed"), undefined); untouched(h); } },

  // AC8: no change for an admin, and for an owner inside their own home.
  { name: "AC8 browse_dir: an owner lists their own home", h: { osUsers: true }, user: "alice",
    msg: { type: "browse_dir", path: HOMES.alice + "/" },
    check: function (h) { var r = reply(h, "browse_dir_result"); assert.equal(r.error, undefined); assert.deepEqual(r.entries.map(function (e) { return e.name; }).sort(), ["proj"]); } },
  { name: "AC8 browse_dir: an admin lists any directory", h: { osUsers: true }, user: "adm",
    msg: { type: "browse_dir", path: HOMES.bob + "/" },
    check: function (h) { assert.deepEqual(reply(h, "browse_dir_result").entries.map(function (e) { return e.name; }), ["secret"]); } },
  { name: "AC8 add_project: an owner adds a directory in their own home", h: { osUsers: true }, user: "alice",
    msg: { type: "add_project", path: path.join(HOMES.alice, "proj") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, true); assert.deepEqual(h.calls.onAddProject, [path.join(HOMES.alice, "proj")]); } },
  { name: "AC8 add_project: an admin adds any directory", h: { osUsers: true }, user: "adm",
    msg: { type: "add_project", path: path.join(HOMES.bob, "secret") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, true); assert.deepEqual(h.calls.onAddProject, [path.join(HOMES.bob, "secret")]); } },
  { name: "AC8 add_project: a caller with createProject adds a directory outside os-users mode", h: { osUsers: false }, user: "mal",
    msg: { type: "add_project", path: path.join(HOMES.bob, "secret") },
    check: function (h) { assert.equal(reply(h, "add_project_result").ok, true); assert.equal(h.calls.onAddProject.length, 1); } },
  { name: "AC8 remove_project: an admin removes any project", h: {}, user: "adm",
    msg: { type: "remove_project", slug: "proj-a" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, true); assert.deepEqual(h.calls.onRemoveProject, ["proj-a"]); } },
  { name: "AC8 remove_project: an owner removes their project", h: {}, user: "alice",
    msg: { type: "remove_project", slug: "proj-a" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, true); assert.deepEqual(h.calls.onRemoveProject, ["proj-a"]); } },
  { name: "AC8 remove_project: an owner removes a worktree of their project", h: {}, user: "alice",
    msg: { type: "remove_project", slug: "proj-a--wt" },
    check: function (h) { assert.equal(reply(h, "remove_project_result").ok, true); assert.deepEqual(h.calls.onRemoveProject, ["proj-a--wt"]); } },
  { name: "AC8 remove_project_check: an owner gets the schedule count", h: {}, user: "alice",
    msg: { type: "remove_project_check", slug: "proj-a", name: "A" },
    check: function (h) { assert.equal(reply(h, "remove_project_check_result").count, 3); } },
  { name: "AC8 remove_project_check: an admin gets the schedule count", h: {}, user: "adm",
    msg: { type: "remove_project_check", slug: "proj-a", name: "A" },
    check: function (h) { assert.equal(reply(h, "remove_project_check_result").count, 3); } },
  { name: "AC8 moveTasksTo: an owner moves tasks to another project they reach", h: {}, user: "alice",
    msg: { type: "remove_project", slug: "proj-a", moveTasksTo: "proj-a2" },
    check: function (h) { assert.deepEqual(h.calls.moveAll, [["proj-a", "proj-a2"]]); assert.deepEqual(h.calls.onRemoveProject, ["proj-a"]); } },
  { name: "AC8 moveTasksTo: an admin moves tasks anywhere", h: {}, user: "adm",
    msg: { type: "remove_project", slug: "proj-a", moveTasksTo: "proj-m" },
    check: function (h) { assert.deepEqual(h.calls.moveAll, [["proj-a", "proj-m"]]); } },
  { name: "AC8 transfer_project_owner: an admin transfers a project outside /home", h: { osUsers: true, cwd: "/srv/projects/proj-a", ownerId: "alice" }, user: "adm",
    msg: { type: "transfer_project_owner", userId: "mal" },
    check: function (h) { assert.equal(reply(h, "project_owner_changed").ownerId, "mal"); } },
  { name: "AC8 transfer_project_owner: an owner transfers a project outside /home", h: { osUsers: false, cwd: "/srv/projects/proj-a", ownerId: "alice" }, user: "alice",
    msg: { type: "transfer_project_owner", userId: "mal" },
    check: function (h) { assert.equal(reply(h, "project_owner_changed").ownerId, "mal"); } },
];

ROWS.forEach(function (row) {
  test(row.name, function () {
    var h = makeHarness(row.h);
    var ws = { readyState: 1, send: function () {}, _clagenticUser: USERS[row.user], _clagenticAuthenticated: true };
    var handled = attachSessions(h.ctx).handleSessionsMessage(ws, row.msg);
    assert.equal(handled, true);
    row.check(h);
  });
});

// --- AC7, connect side: ownerLocked on the info message ---------------------

function infoFor(o) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-access-conn-"));
  try {
    ["../lib/config", "../lib/sessions", "../lib/users", "../lib/utils", "../lib/store", "../lib/users-auth",
      "../lib/users-permissions", "../lib/users-preferences", "../lib/user-presence", "../lib/lite-detect",
      "../lib/project-connection"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    var prev = process.env.CLAGENTIC_HOME;
    process.env.CLAGENTIC_HOME = home;
    var sessionsModule, connModule;
    try {
      sessionsModule = require("../lib/sessions");
      connModule = require("../lib/project-connection");
    } finally {
      if (prev === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = prev;
    }
    var sm = sessionsModule.createSessionManager({ cwd: home, send: function () {}, sendTo: function () {}, sendEach: null });
    var sent = [];
    var noop = function () {};
    var attachment = connModule.attachConnection({
      cwd: o.cwd, slug: "test-project", isMate: false, osUsers: o.osUsers, debug: false,
      dangerouslySkipPermissionsConfigured: false, currentVersion: "0.0.0", lanHost: null,
      sm: sm, tm: { list: function () { return []; } }, nm: { list: function () { return []; } },
      clients: new Set(), send: noop, sendTo: function (ws, m) { sent.push(m); }, opts: {},
      loopState: {}, loopRegistry: {},
      _loop: { loopState: {}, loopRegistry: {}, resumeLoop: noop, sendConnectionState: noop },
      _mcp: null, _notifications: null, hydrateImageRefs: function (x) { return x; },
      broadcastClientCount: noop, broadcastPresence: noop,
      getProjectList: function () { return []; }, getHubSchedules: function () { return []; },
      loadContextSources: function () { return []; }, stopFileWatch: noop, stopAllDirWatches: noop,
      getProjectOwnerId: function () { return null; }, setProjectOwnerId: noop,
      getLatestVersion: function () { return null; }, getTitle: function () { return "T"; },
      getProject: function () { return "test-project"; }, warmup: null,
    });
    attachment.handleConnection({ on: noop, readyState: 1, send: noop }, null, noop, noop);
    return sent.find(function (m) { return m.type === "info"; });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

[
  { name: "AC7 info: ownerLocked is true for an os-users project under /home/<user>/", o: { osUsers: true, cwd: "/home/alice/proj" }, locked: true },
  { name: "AC8 info: ownerLocked is false for an os-users project outside /home", o: { osUsers: true, cwd: "/srv/projects/proj" }, locked: false },
  { name: "AC8 info: ownerLocked is false outside os-users mode", o: { osUsers: false, cwd: "/home/alice/proj" }, locked: false },
].forEach(function (row) {
  test(row.name, function () {
    assert.equal(infoFor(row.o).ownerLocked, row.locked);
  });
});

// --- AC10: the os-users flag is a boolean, never tested with .length --------

test("AC10 no lib/ site tests the os-users flag with .length", function () {
  var libDir = path.join(__dirname, "..", "lib");
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name)) return;
      fs.readFileSync(p, "utf8").split("\n").forEach(function (line, i) {
        if (/[oO]sUsers\w*\)?\??\.length/.test(line)) hits.push(path.relative(libDir, p) + ":" + (i + 1));
      });
    });
  })(libDir);
  assert.deepEqual(hits, []);
});
