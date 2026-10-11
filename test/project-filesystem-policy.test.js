// The WebSocket file handlers (lib/project-filesystem.js) and the file-scope
// policy they share with the HTTP route and the watchers
// (lib/project-file-scope.js, lib/project-git.js).
//
// Real modules and a real git repository throughout; the only fakes are the
// socket, the session store and the OS-user helper (fsAsUser), which would
// need root and real accounts.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-fs-policy-"));
process.env.HOME = path.join(SANDBOX, "home");
fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
process.env.CLAGENTIC_CONSOLE_HOME = path.join(SANDBOX, "data");

var { attachPermissions } = require("../lib/users-permissions");
var { attachFilesystem } = require("../lib/project-filesystem");
var { createFileAccess, resolveGitPath } = require("../lib/project-file-scope");
var projectGit = require("../lib/project-git");
var { validateEnvString } = require("../lib/project");

var REPO = path.join(SANDBOX, "repo");
var OUTSIDE = path.join(SANDBOX, "outside.txt");
var HASH = null;

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO, encoding: "utf8",
    env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
  });
}

test.before(function () {
  fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
  fs.writeFileSync(OUTSIDE, "outside");
  git(["init", "-q"]);
  fs.writeFileSync(path.join(REPO, "src", "a.txt"), "one\n");
  git(["add", "src/a.txt"]);
  git(["commit", "-q", "-m", "first"]);
  fs.writeFileSync(path.join(REPO, "src", "a.txt"), "one\ntwo\n");
  git(["commit", "-q", "-am", "second"]);
  HASH = git(["rev-parse", "HEAD"]).trim();
});

test.after(function () {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

var USERS = {
  admin: { id: "u-admin", username: "admin", role: "admin" },
  member: { id: "u-member", username: "member", role: "user", permissions: { projectSettings: true } },
  nofiles: { id: "u-nofiles", username: "nofiles", role: "user", permissions: { fileBrowser: false } },
  osmember: { id: "u-os", username: "osmember", role: "user", linuxUser: "osmember", permissions: { fileBrowser: true } },
};

var usersModule = attachPermissions({
  loadUsers: function () { return { users: Object.keys(USERS).map(function (k) { return USERS[k]; }) }; },
  saveUsers: function () {},
  findUserById: function (id) {
    return Object.keys(USERS).map(function (k) { return USERS[k]; }).filter(function (u) { return u.id === id; })[0] || null;
  },
});

function fakeSocket(user, osInfo) {
  return { readyState: 1, _clagenticUser: user || null, osInfo: osInfo || null, sent: [] };
}

// A project's filesystem handler wired as lib/project.js wires it.
function build(options) {
  options = options || {};
  var calls = { env: [], sharedEnv: [], fsAsUser: [], watch: [], unwatch: 0, dirWatch: [] };
  var sessions = new Map();
  var osUsers = !!options.osUsers;
  function getOsUserInfoForWs(ws) { return osUsers ? ws.osInfo : null; }
  function fsAsUser(op, args, info) {
    calls.fsAsUser.push({ op: op, args: args, info: info });
    if (op === "stat") return { size: 5 };
    if (op === "read") return { size: 5, content: "as-user" };
    if (op === "list") return [{ name: "listed.txt", isDir: false }];
    return { ok: true };
  }
  var fileAccess = createFileAccess({
    osUsers: osUsers, usersModule: usersModule, fsAsUser: fsAsUser,
    getOsUserInfoForWs: getOsUserInfoForWs,
    binaryExts: new Set([".png"]), maxSize: 512 * 1024,
  });
  var handlers = attachFilesystem({
    cwd: REPO, slug: "mine", osUsers: osUsers,
    sm: { sessions: sessions, readSessionHistoryFromDisk: function (s) { return s.history; } },
    send: function () {},
    sendTo: function (ws, obj) { ws.sent.push(obj); },
    fileAccess: fileAccess,
    getOsUserInfoForWs: getOsUserInfoForWs,
    startFileWatch: function (ws, p) { calls.watch.push(p); },
    stopFileWatch: function () { calls.unwatch++; },
    startDirWatch: function (ws, p) { calls.dirWatch.push(p); },
    usersModule: usersModule, fsAsUser: fsAsUser, validateEnvString: validateEnvString,
    opts: {
      onGetProjectEnv: function (s) { calls.env.push(["get", s]); return { envrc: "A=1" }; },
      onSetProjectEnv: function (s, e) { calls.env.push(["set", s, e]); return { ok: true }; },
      onGetSharedEnv: function () { calls.sharedEnv.push("get"); return { envrc: "S=1" }; },
      onSetSharedEnv: function (e) { calls.sharedEnv.push(["set", e]); return { ok: true }; },
    },
    IGNORED_DIRS: new Set([".git", "node_modules"]),
    IMAGE_EXTS: new Set([".png"]),
  });
  return { handlers: handlers, calls: calls, sessions: sessions };
}

function send(ws, rig, msg) {
  var handled = rig.handlers.handleFilesystemMessage(ws, msg);
  return { handled: handled, last: ws.sent[ws.sent.length - 1] };
}

// --- Project env uses the authorized slug ----------------------------------

test("project env messages act on the project they arrive in, whatever slug they carry", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  var got = send(ws, rig, { type: "get_project_env", slug: "someone-elses" }).last;
  assert.equal(got.slug, "mine");
  var set = send(ws, rig, { type: "set_project_env", slug: "someone-elses", envrc: "B=2" }).last;
  assert.equal(set.slug, "mine");
  assert.deepEqual(rig.calls.env, [["get", "mine"], ["set", "mine", "B=2"]]);
});

test("project env refuses a value that is not text", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  var res = send(ws, rig, { type: "set_project_env", envrc: { split: 1 } }).last;
  assert.equal(res.ok, false);
  assert.deepEqual(rig.calls.env, []);
});

test("project env still needs the projectSettings permission", function () {
  var rig = build();
  var res = send(fakeSocket(USERS.nofiles), rig, { type: "get_project_env" }).last;
  assert.equal(res.type, "error");
  assert.deepEqual(rig.calls.env, []);
});

// --- Global settings are administrator-only ----------------------------------

test("the global CLAUDE.md and the shared environment are for administrators only", function () {
  var globalMd = path.join(process.env.HOME, ".claude", "CLAUDE.md");
  fs.writeFileSync(globalMd, "original");
  var rig = build();
  var member = fakeSocket(USERS.member);
  ["read_global_claude_md", "write_global_claude_md", "get_shared_env", "set_shared_env"].forEach(function (type) {
    var res = send(member, rig, { type: type, content: "pwned", envrc: "X=1" }).last;
    assert.equal(res.type, "error", type + " is refused to a member who holds projectSettings");
    assert.match(res.text, /admin/i);
  });
  var anonymous = fakeSocket(null);
  assert.equal(send(anonymous, rig, { type: "read_global_claude_md" }).last.type, "error");
  assert.equal(fs.readFileSync(globalMd, "utf8"), "original");
  assert.deepEqual(rig.calls.sharedEnv, []);

  var admin = fakeSocket(USERS.admin);
  assert.equal(send(admin, rig, { type: "read_global_claude_md" }).last.content, "original");
  assert.equal(send(admin, rig, { type: "write_global_claude_md", content: "updated" }).last.ok, true);
  assert.equal(fs.readFileSync(globalMd, "utf8"), "updated");
  assert.equal(send(admin, rig, { type: "get_shared_env" }).last.envrc, "S=1");
  assert.equal(send(admin, rig, { type: "set_shared_env", envrc: "S=2" }).last.ok, true);
});

// --- The file gate covers every fs_* message but fs_unwatch ------------------

test("every fs_ message except fs_unwatch needs the fileBrowser permission", function () {
  var rig = build();
  var denied = fakeSocket(USERS.nofiles);
  var messages = [
    { type: "fs_list", path: "." },
    { type: "fs_read", path: "src/a.txt" },
    { type: "fs_write", path: "src/a.txt", content: "x" },
    { type: "fs_search", query: "a" },
    { type: "fs_watch", path: "src/a.txt" },
    { type: "fs_file_history", path: "src/a.txt" },
    { type: "fs_git_diff", path: "src/a.txt", hash: HASH },
    { type: "fs_file_at", path: "src/a.txt", hash: HASH },
    { type: "fs_delete", path: "src/a.txt" },
    { type: "fs_rename", path: "src/a.txt" },
    { type: "fs_mkdir", path: "d" },
    { type: "fs_upload", path: "d" },
  ];
  messages.forEach(function (msg) {
    var res = send(denied, rig, msg);
    assert.equal(res.handled, true, msg.type + " is answered");
    assert.equal(res.last.type, msg.type + "_result", msg.type);
    assert.match(res.last.error, /not permitted/, msg.type);
  });
  assert.deepEqual(rig.calls.watch, [], "no watch was started");
  assert.equal(fs.readFileSync(path.join(REPO, "src", "a.txt"), "utf8"), "one\ntwo\n", "nothing was written");

  send(denied, rig, { type: "fs_unwatch" });
  assert.equal(rig.calls.unwatch, 1, "fs_unwatch still releases what the connection holds");
});

test("a user with the fileBrowser permission lists, reads, searches and watches", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  assert.deepEqual(send(ws, rig, { type: "fs_list", path: "src" }).last.entries.map(function (e) { return e.name; }), ["a.txt"]);
  assert.equal(send(ws, rig, { type: "fs_read", path: "src/a.txt" }).last.content, "one\ntwo\n");
  assert.equal(send(ws, rig, { type: "fs_search", query: "a.t" }).last.entries[0].path, "src/a.txt");
  send(ws, rig, { type: "fs_watch", path: "src/a.txt" });
  assert.deepEqual(rig.calls.watch, ["src/a.txt"]);
  assert.deepEqual(rig.calls.dirWatch, ["src"], "listing registers a watch for this connection");
});

test("paths that are not strings, or leave the project, are refused rather than thrown on", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  [undefined, null, 5, {}, ["a"], "../outside.txt", "src/../../outside.txt", "src/a.txt\u0000x", OUTSIDE].forEach(function (bad) {
    ["fs_read", "fs_write", "fs_list"].forEach(function (type) {
      // A listing with no path lists the project root, which is not an escape.
      if (type === "fs_list" && (bad === undefined || bad === null)) return;
      var res = send(ws, rig, { type: type, path: bad, content: "x" }).last;
      assert.ok(res.error, type + " " + JSON.stringify(bad) + " is refused");
    });
  });
  assert.equal(fs.readFileSync(OUTSIDE, "utf8"), "outside");
  assert.equal(send(ws, rig, { type: "fs_search", query: { trim: 1 } }).last.entries.length, 0);
});

test("a symlink that leaves the project is not followed", function () {
  var link = path.join(REPO, "escape");
  fs.symlinkSync(SANDBOX, link);
  try {
    var rig = build();
    var res = send(fakeSocket(USERS.member), rig, { type: "fs_read", path: "escape/outside.txt" }).last;
    assert.match(res.error, /denied/i);
  } finally {
    fs.unlinkSync(link);
  }
});

// --- Git: revisions and paths are validated ---------------------------------

test("a revision that git could read as an option is refused before git runs", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  var marker = path.join(SANDBOX, "option-injection-marker");
  var hostile = ["--output=" + marker, "-p", "--help", "HEAD", "main", "abc;ls", "", "0x12", "12", "g".repeat(8), 123, { a: 1 }, ["abc1234"]];
  hostile.forEach(function (hash) {
    var diff = send(ws, rig, { type: "fs_git_diff", path: "src/a.txt", hash: hash || "x", hash2: hash === "" ? null : undefined }).last;
    assert.ok(diff.error, "fs_git_diff " + JSON.stringify(hash));
    var secondOperand = send(ws, rig, { type: "fs_git_diff", path: "src/a.txt", hash: HASH, hash2: hash || "x" }).last;
    assert.ok(secondOperand.error, "fs_git_diff hash2 " + JSON.stringify(hash));
    var at = send(ws, rig, { type: "fs_file_at", path: "src/a.txt", hash: hash || "x" }).last;
    assert.ok(at.error, "fs_file_at " + JSON.stringify(hash));
  });
  assert.equal(fs.existsSync(marker), false, "git was never handed an option");
});

test("a hex revision and a project-relative path still produce the diff and the file at that commit", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  var diff = send(ws, rig, { type: "fs_git_diff", path: "src/a.txt", hash: HASH }).last;
  assert.equal(diff.error, undefined);
  assert.match(diff.diff, /\+two/);
  var short = send(ws, rig, { type: "fs_git_diff", path: "src/a.txt", hash: HASH.slice(0, 8) }).last;
  assert.match(short.diff, /\+two/);
  var at = send(ws, rig, { type: "fs_file_at", path: "src/a.txt", hash: HASH }).last;
  assert.equal(at.content, "one\ntwo\n");
  var history = send(ws, rig, { type: "fs_file_history", path: "src/a.txt" }).last;
  assert.equal(history.entries.filter(function (e) { return e.source === "git"; }).length, 2);
});

test("git paths must be inside the project", function () {
  var rig = build();
  var ws = fakeSocket(USERS.member);
  ["../outside.txt", "/etc/passwd", OUTSIDE, "src/../../x", "src/a.txt\u0000", ".", ""].forEach(function (bad) {
    var msgs = [
      { type: "fs_git_diff", path: bad || "x", hash: HASH },
      { type: "fs_file_at", path: bad || "x", hash: HASH },
      { type: "fs_file_history", path: bad || "x" },
    ];
    msgs.forEach(function (msg) {
      if (bad === "" ) return;
      var res = send(ws, rig, msg).last;
      assert.ok(res.error, msg.type + " " + JSON.stringify(bad) + " is refused");
    });
  });
  assert.equal(resolveGitPath(REPO, "src/a.txt"), "src/a.txt");
  assert.equal(resolveGitPath(REPO, "./src/../src/a.txt"), "src/a.txt");
  assert.equal(resolveGitPath(REPO, REPO + "/src/a.txt"), "src/a.txt");
  assert.equal(resolveGitPath(REPO, ".."), null);
  assert.equal(resolveGitPath(REPO, 5), null);
});

// --- File history leaves out sessions the user cannot read -------------------

function editSession(localId, ownerId, visibility, title, filePath) {
  return {
    localId: localId, ownerId: ownerId, sessionVisibility: visibility, title: title,
    createdAt: 1000, lastActivity: 2000,
    history: [
      { type: "user_message", text: "change " + title },
      { type: "tool_executing", id: "t" + localId, name: "Edit", input: { file_path: filePath, old_string: "one", new_string: "two" } },
    ],
  };
}

test("file history includes edits from sessions the user can read and leaves out the rest", function () {
  var rig = build();
  var file = path.join(REPO, "src", "a.txt");
  rig.sessions.set(1, editSession(1, USERS.member.id, "private", "members-own", file));
  rig.sessions.set(2, editSession(2, USERS.admin.id, "private", "admins-private", file));
  rig.sessions.set(3, editSession(3, USERS.admin.id, "shared", "admins-shared", file));
  var res = send(fakeSocket(USERS.member), rig, { type: "fs_file_history", path: "src/a.txt" }).last;
  var titles = res.entries.filter(function (e) { return e.source === "session"; }).map(function (e) { return e.sessionTitle; }).sort();
  assert.deepEqual(titles, ["admins-shared", "members-own"]);

  var asAdmin = send(fakeSocket(USERS.admin), rig, { type: "fs_file_history", path: "src/a.txt" }).last;
  var adminTitles = asAdmin.entries.filter(function (e) { return e.source === "session"; }).map(function (e) { return e.sessionTitle; }).sort();
  assert.deepEqual(adminTitles, ["admins-private", "admins-shared"], "the owner of a private session still sees it");
});

// --- os-users mode: no privileged fallback -----------------------------------

test("in os-users mode a user without an OS identity is refused and no read happens as the daemon", function () {
  var rig = build({ osUsers: true });
  var ws = fakeSocket(USERS.admin, null);
  ["fs_list", "fs_read", "fs_write", "fs_search", "fs_watch", "fs_file_history", "fs_git_diff", "fs_file_at"].forEach(function (type) {
    var res = send(ws, rig, { type: type, path: "src/a.txt", content: "x", query: "a", hash: HASH }).last;
    assert.match(res.error, /OS user identity/, type);
  });
  assert.deepEqual(rig.calls.fsAsUser, []);
  assert.deepEqual(rig.calls.watch, []);
  assert.equal(fs.readFileSync(path.join(REPO, "src", "a.txt"), "utf8"), "one\ntwo\n");
});

test("in os-users mode files are read, listed and written as the user's own identity", function () {
  var rig = build({ osUsers: true });
  var info = { uid: 4242, gid: 4242, home: "/home/osmember" };
  var ws = fakeSocket(USERS.osmember, info);
  assert.equal(send(ws, rig, { type: "fs_read", path: "src/a.txt" }).last.content, "as-user");
  assert.equal(send(ws, rig, { type: "fs_list", path: "src" }).last.entries[0].name, "listed.txt");
  assert.equal(send(ws, rig, { type: "fs_write", path: "src/a.txt", content: "w" }).last.ok, true);
  assert.ok(rig.calls.fsAsUser.length >= 3);
  rig.calls.fsAsUser.forEach(function (c) { assert.deepEqual(c.info, info); });
  assert.equal(fs.readFileSync(path.join(REPO, "src", "a.txt"), "utf8"), "one\ntwo\n", "the daemon wrote nothing itself");
});

test("git runs as the user's OS identity in os-users mode and refuses without one", function (t) {
  assert.throws(function () { projectGit.runGit(["status"], { cwd: REPO, osUsers: true, osUserInfo: null }); }, /OS user identity/);
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("needs root to run git as another uid");
    return;
  }
  var me = { uid: 0, gid: 0, home: SANDBOX };
  assert.match(projectGit.runGit(["log", "--format=%s", "-1"], { cwd: REPO, osUsers: true, osUserInfo: me }), /second/);
  assert.equal(projectGit.runGit(["config", "--get", "safe.directory"], { cwd: REPO, osUsers: true, osUserInfo: me }).trim(), REPO);
  var nobody = { uid: 65534, gid: 65534, home: SANDBOX };
  assert.throws(function () {
    projectGit.runGit(["log", "-1"], { cwd: REPO, osUsers: true, osUserInfo: nobody });
  }, "an identity that cannot read the repository cannot read its history");
});
