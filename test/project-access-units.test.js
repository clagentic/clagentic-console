// The access primitives: the project access resolver, the per-message gate,
// the permission module's visibility default, and the daemon's access record.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-access-units-"));
process.env.CLAGENTIC_CONSOLE_HOME = path.join(SANDBOX, "data");

var { attachPermissions } = require("../lib/users-permissions");
var { createProjectAccess } = require("../lib/project-access");
var realUsers = require("../lib/users");
var { createMessageGate, DENIED } = require("../lib/project-message-gate");
var daemonProjects = require("../lib/daemon-projects");

test.after(function () { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

var PEOPLE = {
  admin: { id: "admin", role: "admin" },
  owner: { id: "owner", role: "user" },
  member: { id: "member", role: "user" },
  other: { id: "other", role: "user" },
};
var users = attachPermissions({
  loadUsers: function () { return { users: [] }; },
  saveUsers: function () {},
  findUserById: function (id) { return PEOPLE[id] || null; },
});

// --- visibility -------------------------------------------------------------

test("a project record with no visibility is private, not public", function () {
  var record = { ownerId: "owner", allowedUsers: ["member"] };
  assert.equal(users.canAccessProject("other", record), false);
  assert.equal(users.canAccessProject("member", record), true);
  assert.equal(users.canAccessProject("owner", record), true);
  assert.equal(users.canAccessProject("admin", record), true);
  assert.equal(users.canAccessProject("other", { visibility: "something-new", ownerId: "owner" }), false);
  assert.equal(users.canAccessProject("other", { visibility: "public" }), true);
  assert.equal(users.canAccessProject("other", null), false);
});

// --- resolver ---------------------------------------------------------------

function accessWith(table, isMultiUser) {
  return createProjectAccess({
    users: users,
    isMultiUser: isMultiUser,
    onGetProjectAccess: function (slug) {
      if (slug === "throws") throw new Error("lookup exploded");
      return Object.prototype.hasOwnProperty.call(table, slug) ? table[slug] : { error: "Project not found" };
    },
  });
}

var SINGLE_USER = function () { return false; };
var MULTI_USER = function () { return true; };

test("a lookup that cannot be completed is a refusal, for every user including administrators", function () {
  var access = accessWith({ open: { visibility: "public" } });
  assert.equal(access.canAccess("member", "open"), true);
  assert.equal(access.canAccess("admin", "missing"), false);
  assert.equal(access.canAccess("admin", "throws"), false);
  assert.equal(access.canAccess("admin", undefined), false);
  assert.equal(access.canAccess("admin", {}), false);
  assert.equal(access.canAccess(null, "open"), false);
  assert.equal(access.canAccess("member", "__proto__"), false);
  assert.equal(access.canAccess("member", "constructor"), false);
});

test("with no lookup wired nothing is accessible", function () {
  var access = createProjectAccess({ users: users, onGetProjectAccess: null });
  assert.equal(access.canAccess("admin", "anything"), false);
  assert.deepEqual(access.filterProjectList("admin", [{ slug: "anything" }]), []);
});

test("a project list is filtered to what the user may see and is empty for no user", function () {
  var access = accessWith({
    open: { visibility: "public" },
    closed: { visibility: "private", ownerId: "owner" },
    unmarked: { ownerId: "owner" },
  });
  var list = [{ slug: "open" }, { slug: "closed" }, { slug: "unmarked" }, { slug: "gone" }, null];
  assert.deepEqual(access.filterProjectList("member", list).map(function (p) { return p.slug; }), ["open"]);
  assert.deepEqual(access.filterProjectList("owner", list).map(function (p) { return p.slug; }), ["open", "closed", "unmarked"]);
  assert.deepEqual(access.filterProjectList("admin", list).map(function (p) { return p.slug; }), ["open", "closed", "unmarked"]);
  assert.deepEqual(access.filterProjectList(null, list), []);
  assert.deepEqual(access.filterProjectList("member", "nope"), []);
});

test("a session is readable by its owner, by anyone when shared, and by an administrator when legacy", function () {
  var access = accessWith({}, MULTI_USER);
  var canReadSession = access.canReadSession;
  assert.equal(canReadSession(PEOPLE.owner, { ownerId: "owner", sessionVisibility: "private" }), true);
  assert.equal(canReadSession(PEOPLE.member, { ownerId: "owner", sessionVisibility: "private" }), false);
  assert.equal(canReadSession(PEOPLE.member, { ownerId: "owner" }), true);
  assert.equal(canReadSession(PEOPLE.member, { ownerId: null }), false);
  assert.equal(canReadSession(PEOPLE.admin, { ownerId: null }), true);
  assert.equal(canReadSession(null, { ownerId: "owner" }), false);
  assert.equal(canReadSession(PEOPLE.owner, null), false);
});

// --- mode: "no user" is decided by the daemon's mode, never by absence alone ----

test("in single-user mode a connection with no user is the implicit owner with admin rights and every project", function () {
  var access = accessWith({ open: { visibility: "public" }, closed: { visibility: "private", ownerId: "owner" } }, SINGLE_USER);
  var proof = { authenticated: true };
  var principal = access.principalFor(null, proof);
  assert.deepEqual({ id: principal.id, implicit: principal.implicit, admin: principal.admin }, { id: null, implicit: true, admin: true });
  assert.equal(access.isAdmin(null, proof), true);
  assert.equal(access.isAdmin(undefined, proof), true);
  assert.equal(access.canAccess(null, "open", proof), true);
  assert.equal(access.canAccess(null, "closed", proof), true);
  assert.equal(access.canAccess(null, "a--worktree", proof), true, "a worktree slug needs no lookup for the owner");
  assert.equal(access.canAccess(null, undefined, proof), false, "a slug that is not a name is still refused");
  assert.deepEqual(access.filterProjectList(null, [{ slug: "open" }, { slug: "closed" }, null], proof).map(function (p) { return p.slug; }), ["open", "closed"]);
  assert.equal(access.canReadSession(null, { ownerId: "someone", sessionVisibility: "private" }, proof), true);
  assert.equal(access.canReadSession(null, null, proof), false);
});

test("in single-user mode no user is nobody unless the caller proved the login, whatever the proof's shape", function () {
  var access = accessWith({ open: { visibility: "public" } }, SINGLE_USER);
  [undefined, null, {}, { authenticated: false }, { authenticated: "true" }, { authenticated: 1 }, "authenticated", true].forEach(function (proof) {
    var shown = JSON.stringify(proof);
    assert.equal(access.principalFor(null, proof), null, shown);
    assert.equal(access.isAdmin(null, proof), false, shown);
    assert.equal(access.canAccess(null, "open", proof), false, shown);
    assert.deepEqual(access.filterProjectList(null, [{ slug: "open" }], proof), [], shown);
    assert.equal(access.canReadSession(null, { ownerId: "owner" }, proof), false, shown);
  });
  assert.equal(access.principalFor(null), null, "no proof argument at all");
});

test("a named user needs no proof, and a proof alone does not make a user", function () {
  var access = accessWith({ open: { visibility: "public" } }, SINGLE_USER);
  assert.equal(access.principalFor(PEOPLE.member).id, "member");
  assert.equal(access.canAccess("member", "open"), true);
  assert.equal(access.principalFor({}, { authenticated: true }), null, "a record with no id stays refused");
});

test("authOf reads the proof a socket or request carries and nothing else", function () {
  var access = accessWith({}, SINGLE_USER);
  assert.deepEqual(access.authOf({ _clagenticAuthenticated: true }), { authenticated: true });
  [null, undefined, {}, { _clagenticAuthenticated: false }, { _clagenticAuthenticated: "true" }, { authenticated: true }, { _clagenticUser: PEOPLE.owner }].forEach(function (conn) {
    assert.deepEqual(access.authOf(conn), { authenticated: false }, JSON.stringify(conn));
  });
  assert.equal(access.canAccess(null, "x", access.authOf({ _clagenticAuthenticated: true })), true);
});

test("in single-user mode a named user keeps exactly the rights of that user", function () {
  var access = accessWith({ closed: { visibility: "private", ownerId: "owner" } }, SINGLE_USER);
  assert.equal(access.canAccess("member", "closed"), false);
  assert.equal(access.isAdmin(PEOPLE.member), false);
  assert.equal(access.isAdmin(PEOPLE.admin), true);
});

test("in multi-user mode, with no mode wired, or when the mode cannot be read, no user is a stranger", function () {
  [accessWith({ open: { visibility: "public" } }, MULTI_USER),
   accessWith({ open: { visibility: "public" } }, undefined),
   accessWith({ open: { visibility: "public" } }, function () { throw new Error("users.json unreadable"); })].forEach(function (access) {
    var proof = { authenticated: true };
    assert.equal(access.principalFor(null), null);
    assert.equal(access.principalFor(null, proof), null, "a proven login without a user is still nobody");
    assert.equal(access.principalFor(undefined, proof), null);
    assert.equal(access.principalFor({}, proof), null, "a record with no id is no principal");
    assert.equal(access.isAdmin(null, proof), false);
    assert.equal(access.canAccess(null, "open", proof), false);
    assert.deepEqual(access.filterProjectList(null, [{ slug: "open" }], proof), []);
    assert.equal(access.canReadSession(null, { ownerId: "owner" }, proof), false);
  });
});

test("the daemon's mode is read from the stored users and defaults to multi-user", function () {
  var dir = path.join(process.env.CLAGENTIC_CONSOLE_HOME, "console");
  fs.mkdirSync(dir, { recursive: true });
  var file = path.join(dir, "users.json");
  try {
    fs.rmSync(file, { force: true });
    assert.equal(realUsers.isMultiUser(), true, "no users file");
    fs.writeFileSync(file, JSON.stringify({ users: [] }));
    assert.equal(realUsers.isMultiUser(), true, "flag absent");
    fs.writeFileSync(file, JSON.stringify({ multiUser: false, users: [] }));
    assert.equal(realUsers.isMultiUser(), false);
    fs.writeFileSync(file, "{ not json");
    assert.throws(function () { realUsers.isMultiUser(); }, "a corrupt file is an error, which the resolver reads as multi-user");
    var viaResolver = createProjectAccess({ users: users, onGetProjectAccess: null, isMultiUser: realUsers.isMultiUser });
    assert.equal(viaResolver.principalFor(null, { authenticated: true }), null);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// --- message gate -------------------------------------------------------------

function gateFor(projects, extra) {
  return gateWith(projects, MULTI_USER, extra);
}

function gateWith(projects, isMultiUser, extra) {
  var contexts = {};
  Object.keys(projects).forEach(function (slug) { contexts[slug] = { slug: slug }; });
  var access = accessWith(projects, isMultiUser);
  return createMessageGate(Object.assign({
    slug: "here",
    canAccess: access.canAccess,
    getProject: function (s) { return Object.prototype.hasOwnProperty.call(contexts, s) ? contexts[s] : null; },
  }, extra || {}));
}

var TABLE = {
  here: { visibility: "public" },
  there: { visibility: "private", ownerId: "owner" },
  worktree: { visibility: "public" },
};

test("a message for the current project passes with its content untouched", function () {
  var gate = gateFor(TABLE);
  var msg = { type: "x", n: 1 };
  var r = gate.authorize({ _clagenticUser: PEOPLE.member }, msg);
  assert.equal(r.allowed, true);
  assert.equal(r.target, null);
  assert.deepEqual(r.message, msg);
});

test("the current project is re-checked on every message", function () {
  var gate = gateFor({ here: { visibility: "private", ownerId: "owner" } });
  var r = gate.authorize({ _clagenticUser: PEOPLE.member }, { type: "x" });
  assert.equal(r.allowed, false);
  assert.equal(r.error, DENIED);
  assert.equal(gate.authorize({ _clagenticUser: null }, { type: "x" }).allowed, false);
});

test("a targetSlug is authorized and resolved, and removed before the handler sees the message", function () {
  var gate = gateFor(TABLE);
  var r = gate.authorize({ _clagenticUser: PEOPLE.owner }, { type: "x", targetSlug: "there", id: 4 });
  assert.equal(r.allowed, true);
  assert.equal(r.target.slug, "there");
  assert.deepEqual(r.message, { type: "x", id: 4 });
  var own = gate.authorize({ _clagenticUser: PEOPLE.member }, { type: "x", targetSlug: "here" });
  assert.equal(own.allowed, true);
  assert.equal(own.target, null);
  assert.deepEqual(own.message, { type: "x" });
});

test("a targetSlug the user cannot use, that is unknown, or that is not a string is refused", function () {
  var gate = gateFor(TABLE);
  var ws = { _clagenticUser: PEOPLE.member };
  ["there", "nowhere", "__proto__", "constructor", 5, {}, ["there"], true].forEach(function (target) {
    var r = gate.authorize(ws, { type: "x", targetSlug: target });
    assert.equal(r.allowed, false, JSON.stringify(target));
    assert.equal(r.error, DENIED);
  });
});

test("a worktree slug is authorized through the same lookup", function () {
  var gate = gateFor(TABLE);
  assert.equal(gate.authorize({ _clagenticUser: PEOPLE.member }, { type: "x", targetSlug: "worktree" }).allowed, true);
});

test("a message that is not a JSON object is refused without an error to send", function () {
  var gate = gateFor(TABLE);
  [null, undefined, 5, "text", [1], true].forEach(function (bad) {
    var r = gate.authorize({ _clagenticUser: PEOPLE.member }, bad);
    assert.equal(r.allowed, false);
    assert.equal(r.error, null);
  });
});

test("the gate lets the single-user owner (no user record) act on the current and any other project", function () {
  var gate = gateWith(TABLE, SINGLE_USER);
  var owner = { _clagenticUser: null, _clagenticAuthenticated: true };
  var own = gate.authorize(owner, { type: "x" });
  assert.equal(own.allowed, true);
  var other = gate.authorize(owner, { type: "x", targetSlug: "there", id: 4 });
  assert.equal(other.allowed, true);
  assert.equal(other.target.slug, "there");
  assert.deepEqual(other.message, { type: "x", id: 4 });
  assert.equal(gate.authorize(owner, { type: "x", targetSlug: "nowhere" }).allowed, false, "a project that does not exist is still refused");
  assert.equal(gate.authorize(owner, { type: "x", targetSlug: 5 }).allowed, false);
});

test("the gate refuses a single-user connection that never passed the upgrade login check", function () {
  var gate = gateWith(TABLE, SINGLE_USER);
  [{ _clagenticUser: null }, { _clagenticUser: null, _clagenticAuthenticated: false }, {}, null].forEach(function (ws) {
    assert.equal(gate.authorize(ws, { type: "x" }).allowed, false, JSON.stringify(ws));
    assert.equal(gate.authorize(ws, { type: "x", targetSlug: "there" }).allowed, false, JSON.stringify(ws));
  });
});

test("the gate refuses a connection with no user in multi-user mode, on every message shape", function () {
  var gate = gateWith(TABLE, MULTI_USER);
  assert.equal(gate.authorize({ _clagenticUser: null }, { type: "x" }).allowed, false);
  assert.equal(gate.authorize({ _clagenticUser: null }, { type: "x", targetSlug: "there" }).allowed, false);
  assert.equal(gate.authorize({}, { type: "x" }).allowed, false);
  assert.equal(gate.authorize(null, { type: "x" }).allowed, false);
});

test("a context with no access policy handles its own messages but never forwards to another project", function () {
  var gate = createMessageGate({ slug: "here", canAccess: null, getProject: function () { return { slug: "there" }; } });
  assert.equal(gate.authorize({ _clagenticUser: null }, { type: "x" }).allowed, true);
  assert.equal(gate.authorize({ _clagenticUser: PEOPLE.admin }, { type: "x", targetSlug: "there" }).allowed, false);
});

// --- the daemon's access record -------------------------------------------------

test("the daemon gives a registered worktree its parent's access record", function () {
  var config = { osUsers: false, projects: [
    { slug: "parent", visibility: "private", ownerId: "owner", allowedUsers: ["member"] },
    { slug: "plain" },
  ] };
  daemonProjects.registerWorktreeSlug("parent", "parent--feature");
  var wt = daemonProjects.getProjectAccessRecord(config, "parent--feature");
  assert.equal(wt.error, undefined);
  assert.equal(wt.visibility, "private");
  assert.equal(wt.ownerId, "owner");
  assert.deepEqual(wt.allowedUsers, ["member"]);
  assert.ok(daemonProjects.getProjectAccessRecord(config, "unregistered--wt").error);
  assert.ok(daemonProjects.getProjectAccessRecord(config, "missing").error);
  assert.equal(daemonProjects.getProjectAccessRecord(config, "plain").visibility, "public");
  config.osUsers = true;
  assert.equal(daemonProjects.getProjectAccessRecord(config, "plain").visibility, "private");
  daemonProjects.unregisterWorktreeSlug("parent", "parent--feature");
  assert.ok(daemonProjects.getProjectAccessRecord(config, "parent--feature").error, "an unregistered worktree has no record");
});
