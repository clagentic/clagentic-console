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
var { createProjectAccess } = require("../lib/project-access");
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

// A connection that passed the WebSocket upgrade's login check, which is what
// marks it authenticated. `unproven` builds one that never did.
function fakeSocket(user, osInfo, unproven) {
  return { readyState: 1, _clagenticUser: user || null, _clagenticAuthenticated: !unproven, osInfo: osInfo || null, sent: [] };
}

// A project's filesystem handler wired as lib/project.js wires it.
//   options.osUsers     os-users mode
//   options.multiUser   the daemon's mode; single-user otherwise, where a socket
//                       with no user is the implicit owner
function build(options) {
  options = options || {};
  var calls = { env: [], sharedEnv: [], fsAsUser: [], watch: [], unwatch: 0, dirWatch: [] };
  var sessions = new Map();
  var osUsers = !!options.osUsers;
  var projectAccess = createProjectAccess({
    users: usersModule,
    onGetProjectAccess: null,
    isMultiUser: function () { return !!options.multiUser; },
  });
  function getOsUserInfoForWs(ws) { return osUsers ? ws.osInfo : null; }
  function fsAsUser(op, args, info) {
    calls.fsAsUser.push({ op: op, args: args, info: info });
    if (op === "stat") return { size: 5 };
    if (op === "read") return { size: 5, content: "as-user" };
    if (op === "list") return [{ name: "listed.txt", isDir: false }];
    return { ok: true };
  }
  var fileAccess = createFileAccess({
    osUsers: osUsers, usersModule: usersModule, fsAsUser: fsAsUser, projectAccess: projectAccess,
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
    projectAccess: projectAccess,
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
  var rig = build({ multiUser: true });
  var member = fakeSocket(USERS.member);
  ["read_global_claude_md", "write_global_claude_md", "get_shared_env", "set_shared_env"].forEach(function (type) {
    var res = send(member, rig, { type: type, content: "pwned", envrc: "X=1" }).last;
    assert.equal(res.type, "error", type + " is refused to a member who holds projectSettings");
    assert.match(res.text, /admin/i);
  });
  var anonymous = fakeSocket(null);
  ["read_global_claude_md", "write_global_claude_md", "get_shared_env", "set_shared_env"].forEach(function (type) {
    var res = send(anonymous, rig, { type: type, content: "pwned", envrc: "X=1" }).last;
    assert.equal(res.type, "error", type + " is refused when there is no user in multi-user mode");
  });
  assert.equal(fs.readFileSync(globalMd, "utf8"), "original");
  assert.deepEqual(rig.calls.sharedEnv, []);

  var admin = fakeSocket(USERS.admin);
  assert.equal(send(admin, rig, { type: "read_global_claude_md" }).last.content, "original");
  assert.equal(send(admin, rig, { type: "write_global_claude_md", content: "updated" }).last.ok, true);
  assert.equal(fs.readFileSync(globalMd, "utf8"), "updated");
  assert.equal(send(admin, rig, { type: "get_shared_env" }).last.envrc, "S=1");
  assert.equal(send(admin, rig, { type: "set_shared_env", envrc: "S=2" }).last.ok, true);
});

// --- Single-user mode: the connection with no user is the owner -------------------

test("single-user mode, no user: the owner reads and writes the global CLAUDE.md and the shared environment", function () {
  var globalMd = path.join(process.env.HOME, ".claude", "CLAUDE.md");
  fs.writeFileSync(globalMd, "owner-original");
  var rig = build();
  var owner = fakeSocket(null);
  assert.equal(send(owner, rig, { type: "read_global_claude_md" }).last.content, "owner-original");
  assert.equal(send(owner, rig, { type: "write_global_claude_md", content: "owner-updated" }).last.ok, true);
  assert.equal(fs.readFileSync(globalMd, "utf8"), "owner-updated");
  assert.equal(send(owner, rig, { type: "get_shared_env" }).last.envrc, "S=1");
  assert.equal(send(owner, rig, { type: "set_shared_env", envrc: "S=3" }).last.ok, true);
  assert.deepEqual(rig.calls.sharedEnv, ["get", ["set", "S=3"]]);
});

test("single-user mode, no user: project env, files, search, watch, history, diff and file-at all work", function () {
  var rig = build();
  var owner = fakeSocket(null);
  assert.equal(send(owner, rig, { type: "get_project_env", slug: "someone-elses" }).last.slug, "mine");
  assert.equal(send(owner, rig, { type: "set_project_env", envrc: "B=2" }).last.ok, true);
  assert.deepEqual(send(owner, rig, { type: "fs_list", path: "src" }).last.entries.map(function (e) { return e.name; }), ["a.txt"]);
  assert.equal(send(owner, rig, { type: "fs_read", path: "src/a.txt" }).last.content, "one\ntwo\n");
  assert.equal(send(owner, rig, { type: "fs_search", query: "a.t" }).last.entries[0].path, "src/a.txt");
  send(owner, rig, { type: "fs_watch", path: "src/a.txt" });
  assert.deepEqual(rig.calls.watch, ["src/a.txt"]);
  var file = path.join(REPO, "src", "a.txt");
  rig.sessions.set(1, editSession(1, "someone", "private", "legacy-private", file));
  var history = send(owner, rig, { type: "fs_file_history", path: "src/a.txt" }).last;
  assert.equal(history.entries.filter(function (e) { return e.source === "git"; }).length, 2);
  assert.deepEqual(history.entries.filter(function (e) { return e.source === "session"; }).map(function (e) { return e.sessionTitle; }), ["legacy-private"], "the owner sees every session's edits");
  assert.match(send(owner, rig, { type: "fs_git_diff", path: "src/a.txt", hash: HASH }).last.diff, /\+two/);
  assert.equal(send(owner, rig, { type: "fs_file_at", path: "src/a.txt", hash: HASH }).last.content, "one\ntwo\n");
});

test("multi-user mode, no user: every file, settings and git message is refused and nothing throws", function () {
  var rig = build({ multiUser: true });
  var stranger = fakeSocket(null);
  ["read_global_claude_md", "get_shared_env"].forEach(function (type) {
    assert.equal(send(stranger, rig, { type: type }).last.type, "error", type);
  });
  assert.equal(send(stranger, rig, { type: "set_shared_env", envrc: "X=1" }).last.type, "error");
  ["fs_list", "fs_read", "fs_write", "fs_search", "fs_watch", "fs_file_history", "fs_git_diff", "fs_file_at"].forEach(function (type) {
    var res = send(stranger, rig, { type: type, path: "src/a.txt", content: "x", query: "a", hash: HASH }).last;
    assert.match(res.error, /Authentication required/, type);
  });
  assert.deepEqual(rig.calls.sharedEnv, []);
  assert.deepEqual(rig.calls.watch, []);
  assert.equal(fs.readFileSync(path.join(REPO, "src", "a.txt"), "utf8"), "one\ntwo\n", "nothing was written");
});

test("single-user mode, no user and no proof of login: every file, settings and git message is refused", function () {
  var rig = build();
  var stranger = fakeSocket(null, null, true);
  ["read_global_claude_md", "write_global_claude_md", "get_shared_env", "set_shared_env"].forEach(function (type) {
    assert.equal(send(stranger, rig, { type: type, content: "x", envrc: "X=1" }).last.type, "error", type);
  });
  ["fs_list", "fs_read", "fs_write", "fs_search", "fs_watch", "fs_file_history", "fs_git_diff", "fs_file_at"].forEach(function (type) {
    var res = send(stranger, rig, { type: type, path: "src/a.txt", content: "x", query: "a", hash: HASH }).last;
    assert.match(res.error, /Authentication required/, type);
  });
  assert.deepEqual(rig.calls.sharedEnv, []);
  assert.deepEqual(rig.calls.watch, []);
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

// --- Git runs as the repository's owner, with repo-driven programs off --------

function recordingExec() {
  var calls = [];
  function exec(bin, argv, execOpts) { calls.push({ bin: bin, argv: argv, opts: execOpts }); return ""; }
  exec.calls = calls;
  return exec;
}

test("in os-users mode git runs as the uid that owns the repository, never as the viewer, with no safe.directory override", function () {
  var exec = recordingExec();
  projectGit.runGit(["log", "-1"], { cwd: REPO, osUsers: true, exec: exec, osUserInfo: { uid: 4242, gid: 4242, home: "/home/viewer" } });
  var st = fs.statSync(path.join(REPO, ".git"));
  var call = exec.calls[0];
  assert.equal(call.opts.uid, st.uid, "the owner's uid, not the viewer's 4242");
  assert.equal(call.opts.gid, st.gid);
  assert.ok(call.opts.uid !== 4242);
  assert.equal(JSON.stringify(call).indexOf("safe.directory"), -1, "no safe.directory in argv or env");
  assert.equal(call.opts.env.GIT_CONFIG_COUNT, undefined);
  assert.notEqual(call.opts.env.HOME, "/home/viewer");
});

test("outside os-users mode git keeps the daemon's identity", function () {
  var exec = recordingExec();
  projectGit.runGit(["log", "-1"], { cwd: REPO, osUsers: false, exec: exec });
  assert.equal(exec.calls[0].opts.uid, undefined);
  assert.equal(exec.calls[0].opts.gid, undefined);
});

test("a repository whose owner cannot be established fails closed", function () {
  var exec = recordingExec();
  var noRepo = path.join(SANDBOX, "not-a-repo");
  fs.mkdirSync(noRepo, { recursive: true });
  assert.throws(function () { projectGit.runGit(["log", "-1"], { cwd: noRepo, osUsers: true, exec: exec }); }, /repository owner/);
  assert.throws(function () { projectGit.repositoryOwner(path.join(SANDBOX, "missing-dir")); }, /repository owner/);
  assert.equal(exec.calls.length, 0, "git was not started");
});

test("a project in a subdirectory of its repository runs git as the repository's owner", function () {
  var exec = recordingExec();
  var sub = path.join(REPO, "src");
  var st = fs.statSync(path.join(REPO, ".git"));
  assert.equal(projectGit.findRepositoryRoot(sub), REPO);
  assert.equal(projectGit.findRepositoryRoot(REPO), REPO);
  assert.deepEqual(projectGit.repositoryOwner(sub), { uid: st.uid, gid: st.gid });
  projectGit.runGit(["log", "-1"], { cwd: sub, osUsers: true, exec: exec });
  assert.equal(exec.calls[0].opts.uid, st.uid);
  assert.equal(exec.calls[0].opts.gid, st.gid);
  assert.equal(exec.calls[0].opts.cwd, sub, "git still runs in the project directory");
});

test("the nearest enclosing repository decides the owner, and a .git file counts", function () {
  var outer = fs.mkdtempSync(path.join(SANDBOX, "nested-"));
  fs.mkdirSync(path.join(outer, ".git"));
  var inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, ".git"), "gitdir: ../elsewhere\n");
  var deep = path.join(inner, "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(projectGit.findRepositoryRoot(deep), inner, "a worktree's .git file is the nearest entry");
  assert.equal(projectGit.findRepositoryRoot(path.join(outer, "other-dir-that-does-not-exist")), outer);
});

test("a directory with no repository above it is refused, and so is an unreadable one", function () {
  var exec = recordingExec();
  var bare = fs.mkdtempSync(path.join(SANDBOX, "bare-"));
  assert.equal(projectGit.findRepositoryRoot(bare), null);
  assert.throws(function () { projectGit.runGit(["log", "-1"], { cwd: path.join(bare, "sub"), osUsers: true, exec: exec }); }, /repository owner/);
  assert.equal(exec.calls.length, 0);
});

test("every call switches off the programs a repository can name, and diff rendering skips external drivers and textconv", function () {
  var exec = recordingExec();
  ["diff", "show", "log"].forEach(function (sub) {
    projectGit.runGit([sub, "x"], { cwd: REPO, exec: exec });
  });
  projectGit.runGit(["status"], { cwd: REPO, exec: exec });
  exec.calls.forEach(function (call) {
    var joined = call.argv.join(" ");
    assert.match(joined, /-c core\.fsmonitor=false/);
    assert.match(joined, /-c core\.hooksPath=\/dev\/null/);
    assert.match(joined, /-c diff\.external= /);
  });
  exec.calls.slice(0, 3).forEach(function (call) {
    assert.ok(call.argv.indexOf("--no-ext-diff") > -1 && call.argv.indexOf("--no-textconv") > -1, call.argv[6]);
  });
  assert.equal(exec.calls[3].argv.indexOf("--no-ext-diff"), -1);
});

// A repository whose own config tries to run a program in every way git allows.
function hostileRepo() {
  var dir = fs.mkdtempSync(path.join(SANDBOX, "hostile-"));
  var markers = path.join(dir, "..", path.basename(dir) + "-markers");
  fs.mkdirSync(markers);
  // One program per mechanism, each leaving a marker named for it.
  function program(name, body) {
    var file = path.join(SANDBOX, "mark-" + path.basename(dir) + "-" + name + ".sh");
    fs.writeFileSync(file, "#!/bin/sh\ntouch \"" + markers + "/" + name + "\"\n" + (body || ""), { mode: 0o755 });
    return file;
  }
  function g(args) {
    return execFileSync("git", args, {
      cwd: dir, encoding: "utf8",
      env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
    });
  }
  g(["init", "-q"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=evil\n");
  g(["add", "f.txt", ".gitattributes"]);
  g(["commit", "-q", "-m", "first"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "one\ntwo\n");
  g(["commit", "-q", "-am", "second"]);
  var scripts = [program("textconv", "cat \"$1\"\n"), program("external"), program("fsmonitor")];
  g(["config", "diff.evil.textconv", scripts[0]]);
  g(["config", "diff.external", scripts[1]]);
  g(["config", "core.fsmonitor", scripts[2]]);
  return { dir: dir, markers: markers, scripts: scripts, git: g, hash: g(["rev-parse", "HEAD"]).trim() };
}

test("a repository whose config names textconv, diff.external and fsmonitor programs never runs them during history, diff or file-at", function () {
  var repo = hostileRepo();

  // The repository is hostile: git run without the hardening does run its programs.
  repo.git(["diff", "HEAD~1", "HEAD"]);
  repo.git(["diff", "--no-ext-diff", "--textconv", "HEAD~1", "HEAD"]);
  repo.git(["status"]);
  assert.deepEqual(fs.readdirSync(repo.markers).sort(), ["external", "fsmonitor", "textconv"], "the control run fires the configured programs");
  fs.readdirSync(repo.markers).forEach(function (m) { fs.unlinkSync(path.join(repo.markers, m)); });

  var calls = [
    ["log", "--format=%H|%at|%an|%s", "--follow", "--", "f.txt"],
    ["diff", repo.hash + "~1", repo.hash, "--", "f.txt"],
    ["show", repo.hash, "--format=", "--", "f.txt"],
    ["show", repo.hash + ":f.txt"],
    ["status"],
  ];
  calls.forEach(function (args) {
    projectGit.runGit(args, { cwd: repo.dir });
  });
  assert.deepEqual(fs.readdirSync(repo.markers), [], "no program named by the repository's config ran");
});

test("the same hostile repository stays inert through the WebSocket handlers", function () {
  var repo = hostileRepo();
  var handlers = attachFilesystem({
    cwd: repo.dir, slug: "mine", osUsers: false,
    sm: { sessions: new Map(), readSessionHistoryFromDisk: function () { return []; } },
    send: function () {}, sendTo: function (ws, obj) { ws.sent.push(obj); },
    fileAccess: createFileAccess({
      osUsers: false, usersModule: usersModule, fsAsUser: function () {},
      getOsUserInfoForWs: function () { return null; }, binaryExts: new Set(), maxSize: 512 * 1024,
    }),
    getOsUserInfoForWs: function () { return null; },
    startFileWatch: function () {}, stopFileWatch: function () {}, startDirWatch: function () {},
    usersModule: usersModule, fsAsUser: function () {}, validateEnvString: validateEnvString,
    projectAccess: createProjectAccess({ users: usersModule, onGetProjectAccess: null, isMultiUser: function () { return false; } }),
    opts: {}, IGNORED_DIRS: new Set([".git"]), IMAGE_EXTS: new Set(),
  });
  var ws = fakeSocket(null);
  ["fs_file_history", "fs_git_diff", "fs_file_at"].forEach(function (type) {
    handlers.handleFilesystemMessage(ws, { type: type, path: "f.txt", hash: repo.hash });
  });
  var diff = ws.sent.filter(function (m) { return m.type === "fs_git_diff_result"; })[0];
  assert.match(diff.diff, /\+two/, "the diff is still produced from the committed blobs");
  assert.deepEqual(fs.readdirSync(repo.markers), []);
});

test("as another user: git runs as the repository's owner and its config programs stay inert", function (t) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("needs root to run git as another uid");
    return;
  }
  var repo = hostileRepo();
  var OWNER = 65534;
  execFileSync("chown", ["-R", OWNER + ":" + OWNER, repo.dir, repo.markers]);
  fs.chmodSync(SANDBOX, 0o755);
  // The daemon (root) does not own this repository; git would refuse it as
  // "dubious ownership" unless it runs as the owner.
  assert.throws(function () { projectGit.runGit(["log", "-1"], { cwd: repo.dir, osUsers: false }); });
  var out = projectGit.runGit(["log", "--format=%s", "-1"], { cwd: repo.dir, osUsers: true });
  assert.match(out, /second/);
  projectGit.runGit(["diff", repo.hash + "~1", repo.hash, "--", "f.txt"], { cwd: repo.dir, osUsers: true });
  projectGit.runGit(["status"], { cwd: repo.dir, osUsers: true });
  assert.deepEqual(fs.readdirSync(repo.markers), [], "no marker was created by any program");
});

test("as another user: a project in a repository subdirectory still reads its history as the repository's owner", function (t) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("needs root to run git as another uid");
    return;
  }
  var repo = hostileRepo();
  var sub = path.join(repo.dir, "pkg");
  fs.mkdirSync(sub);
  var OWNER = 65534;
  execFileSync("chown", ["-R", OWNER + ":" + OWNER, repo.dir, repo.markers]);
  fs.chmodSync(SANDBOX, 0o755);
  var out = projectGit.runGit(["log", "--format=%s", "-1"], { cwd: sub, osUsers: true });
  assert.match(out, /second/);
  assert.deepEqual(fs.readdirSync(repo.markers), [], "no marker was created by any program");
});
