// File and directory watches belong to the connection that opened them: a
// change is read as that connection's user and sent to that connection only.
// Real files and real fs.watch; the sockets are plain objects.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-watch-"));
process.env.HOME = path.join(SANDBOX, "home");
process.env.CLAGENTIC_CONSOLE_HOME = path.join(SANDBOX, "data");

var { attachFileWatch } = require("../lib/project-file-watch");
var { createFileAccess, safePath } = require("../lib/project-file-scope");

var ROOT = path.join(SANDBOX, "project");
var watchers = [];

test.before(function () {
  fs.mkdirSync(path.join(ROOT, "dir"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v0");
});

test.after(function () {
  watchers.forEach(function (w) { w.stopAll(); });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function socket(name, user, osInfo) {
  return { name: name, readyState: 1, _clagenticUser: user, osInfo: osInfo || null, sent: [] };
}

// A watch engine wired the way lib/project.js wires it.
function engine(options) {
  options = options || {};
  var asUserCalls = [];
  var fsAsUser = function (op, args, info) {
    asUserCalls.push({ op: op, file: args.file || args.dir, uid: info.uid });
    if (op === "stat") return { size: 4 };
    if (op === "read") return { size: 4, content: "uid" + info.uid };
    return [{ name: "seen-by-" + info.uid, isDir: false }];
  };
  var usersModule = {
    getEffectivePermissions: function (user) {
      return { fileBrowser: !(user && user.permissions && user.permissions.fileBrowser === false) };
    },
  };
  var osUsers = !!options.osUsers;
  var access = createFileAccess({
    osUsers: osUsers, usersModule: usersModule, fsAsUser: fsAsUser,
    getOsUserInfoForWs: function (ws) { return osUsers ? ws.osInfo : null; },
    binaryExts: new Set([".png"]), maxSize: 512 * 1024,
  });
  var w = attachFileWatch({
    cwd: ROOT,
    sendTo: function (ws, obj) { ws.sent.push(obj); },
    safePath: safePath,
    authorize: access.authorize,
    readFile: access.readFile,
    listDir: access.listDir,
    IGNORED_DIRS: new Set([".git"]),
  });
  watchers.push(w);
  w.asUserCalls = asUserCalls;
  return w;
}

function changed(ws) {
  return ws.sent.filter(function (m) { return m.type === "fs_file_changed"; });
}

test("a file change is sent to the connection that watches it and to no other", async function () {
  var w = engine();
  var watcher = socket("watcher", { id: "u1" });
  var bystander = socket("bystander", { id: "u2" });
  w.startFileWatch(watcher, "watched.txt");
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v1");
  await pause(700);
  assert.equal(changed(watcher).length >= 1, true);
  assert.equal(changed(watcher)[0].content, "v1");
  assert.equal(changed(bystander).length, 0);
  w.stopFileWatch(watcher);
});

test("two connections watching the same file are each sent the change", async function () {
  var w = engine();
  var a = socket("a", { id: "u1" });
  var b = socket("b", { id: "u2" });
  w.startFileWatch(a, "watched.txt");
  w.startFileWatch(b, "watched.txt");
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v2");
  await pause(700);
  assert.equal(changed(a)[0].content, "v2");
  assert.equal(changed(b)[0].content, "v2");
  w.stopFileWatch(a);
  assert.equal(a.sent.length > 0, true);
  var before = b.sent.length;
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v3");
  await pause(700);
  assert.equal(changed(a).filter(function (m) { return m.content === "v3"; }).length, 0, "a stopped watch sends nothing");
  assert.ok(b.sent.length > before, "the other connection's watch is unaffected");
  w.stopFileWatch(b);
});

test("a connection without the fileBrowser permission cannot start a watch", async function () {
  var w = engine();
  var denied = socket("denied", { id: "u3", permissions: { fileBrowser: false } });
  w.startFileWatch(denied, "watched.txt");
  w.startDirWatch(denied, "dir");
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v4");
  fs.writeFileSync(path.join(ROOT, "dir", "new.txt"), "n");
  await pause(700);
  assert.deepEqual(denied.sent, []);
});

test("a watch ends when its connection loses the permission, without sending the file", async function () {
  var w = engine();
  var user = { id: "u4" };
  var ws = socket("revoked", user);
  w.startFileWatch(ws, "watched.txt");
  user.permissions = { fileBrowser: false };
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "secret-after-revoke");
  await pause(700);
  assert.deepEqual(changed(ws), []);
});

test("a path outside the project is not watched", async function () {
  var w = engine();
  var ws = socket("escaper", { id: "u5" });
  var outsideFile = path.join(SANDBOX, "outside-watched.txt");
  fs.writeFileSync(outsideFile, "o0");
  w.startFileWatch(ws, "../project/../../etc/hostname");
  w.startFileWatch(ws, "../outside-watched.txt");
  w.startFileWatch(ws, outsideFile);
  w.startFileWatch(ws, 7);
  w.startFileWatch(ws, "watched.txt\u0000");
  w.startDirWatch(ws, "..");
  w.startDirWatch(ws, SANDBOX);

  // A control watch that is allowed shows that changes are being delivered
  // in this window, so silence on the escaper is a real result.
  var control = socket("control", { id: "u6" });
  w.startFileWatch(control, "watched.txt");

  // Change everything a wrongly started watch would have been watching.
  fs.writeFileSync(outsideFile, "o1");
  fs.writeFileSync(path.join(SANDBOX, "created-in-parent.txt"), "p");
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "inside-change");
  await pause(800);

  assert.ok(changed(control).length >= 1, "the permitted watch saw the change");
  assert.deepEqual(ws.sent, [], "no escaping watch was started, so nothing was sent");
  w.stopFileWatch(control);
});

test("in os-users mode a change is read as each connection's own identity, never as the daemon", async function () {
  var w = engine({ osUsers: true });
  var a = socket("a", { id: "u1" }, { uid: 1001, gid: 1001, home: "/h/a" });
  var b = socket("b", { id: "u2" }, { uid: 1002, gid: 1002, home: "/h/b" });
  var noIdentity = socket("none", { id: "u3" }, null);
  w.startFileWatch(a, "watched.txt");
  w.startFileWatch(b, "watched.txt");
  w.startFileWatch(noIdentity, "watched.txt");
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v5");
  await pause(700);
  assert.equal(changed(a)[0].content, "uid1001");
  assert.equal(changed(b)[0].content, "uid1002");
  assert.deepEqual(noIdentity.sent, [], "a connection with no OS identity is not served by a daemon read");
  w.asUserCalls.forEach(function (c) { assert.ok(c.uid === 1001 || c.uid === 1002); });
  w.stopFileWatch(a);
  w.stopFileWatch(b);
});

test("a directory change is sent, as that user, to the connection that listed it only", async function () {
  var w = engine({ osUsers: true });
  var lister = socket("lister", { id: "u1" }, { uid: 2001, gid: 2001, home: "/h" });
  var other = socket("other", { id: "u2" }, { uid: 2002, gid: 2002, home: "/h" });
  w.startDirWatch(lister, "dir");
  fs.writeFileSync(path.join(ROOT, "dir", "another.txt"), "x");
  await pause(800);
  var dirMsgs = lister.sent.filter(function (m) { return m.type === "fs_dir_changed"; });
  assert.ok(dirMsgs.length >= 1);
  assert.deepEqual(dirMsgs[0].entries.map(function (e) { return e.name; }), ["seen-by-2001"]);
  assert.deepEqual(other.sent, []);
  w.stopAllDirWatches(lister);
});

test("disconnecting releases a connection's watches and nothing else", async function () {
  var w = engine();
  var leaving = socket("leaving", { id: "u1" });
  var staying = socket("staying", { id: "u2" });
  w.startFileWatch(leaving, "watched.txt");
  w.startDirWatch(leaving, "dir");
  w.startFileWatch(staying, "watched.txt");
  w.stopFileWatch(leaving);
  w.stopAllDirWatches(leaving);
  fs.writeFileSync(path.join(ROOT, "watched.txt"), "v6");
  fs.writeFileSync(path.join(ROOT, "dir", "x.txt"), "x");
  await pause(800);
  assert.deepEqual(leaving.sent, []);
  assert.equal(changed(staying).length >= 1, true);
  w.stopFileWatch(staying);
});
