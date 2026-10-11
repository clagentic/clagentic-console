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
var { createProjectAccess, canReadSession } = require("../lib/project-access");
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

function accessWith(table) {
  return createProjectAccess({
    users: users,
    onGetProjectAccess: function (slug) {
      if (slug === "throws") throw new Error("lookup exploded");
      return Object.prototype.hasOwnProperty.call(table, slug) ? table[slug] : { error: "Project not found" };
    },
  });
}

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
  assert.equal(canReadSession(users, PEOPLE.owner, { ownerId: "owner", sessionVisibility: "private" }), true);
  assert.equal(canReadSession(users, PEOPLE.member, { ownerId: "owner", sessionVisibility: "private" }), false);
  assert.equal(canReadSession(users, PEOPLE.member, { ownerId: "owner" }), true);
  assert.equal(canReadSession(users, PEOPLE.member, { ownerId: null }), false);
  assert.equal(canReadSession(users, PEOPLE.admin, { ownerId: null }), true);
  assert.equal(canReadSession(users, null, { ownerId: "owner" }), false);
  assert.equal(canReadSession(users, PEOPLE.owner, null), false);
});

// --- message gate -------------------------------------------------------------

function gateFor(projects, extra) {
  var contexts = {};
  Object.keys(projects).forEach(function (slug) { contexts[slug] = { slug: slug }; });
  var access = accessWith(projects);
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
