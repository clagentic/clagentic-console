"use strict";
// Starting a process as another OS user: the user's groups are initialized
// (Node's own uid/gid options drop every supplementary group), the daemon's
// environment is not inherited, and a call with no identity, or root, is refused
// instead of running as the daemon's user. One spec per caller shape: setpriv
// present, setpriv absent, no mapping, and the sites that start a process as
// a user (the Claude worker, the HTTP skill removal, the file helper).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var spawnAsUser = require("../lib/os-user-spawn");

var ALICE = { uid: 1001, gid: 1001, home: "/home/clay-alice", user: "clay-alice", shell: "/bin/bash" };
var HAS_SETPRIV = { exists: function (p) { return p === "/usr/bin/setpriv"; } };
var NO_SETPRIV = { exists: function () { return false; } };

test("with setpriv the process starts with the user's uid, gid and initialized groups, and no uid/gid spawn option", function () {
  var env = { PATH: "/usr/bin", HOME: ALICE.home };
  var spec = spawnAsUser.spawnSpecAsUser("/usr/bin/node", ["worker.js", "/tmp/s.sock"], ALICE, { env: env, cwd: "/work", stdio: ["ignore", "pipe", "pipe"], detached: true }, HAS_SETPRIV);
  assert.equal(spec.command, "/usr/bin/setpriv");
  assert.deepEqual(spec.args, ["--reuid", "1001", "--regid", "1001", "--init-groups", "--", "/usr/bin/node", "worker.js", "/tmp/s.sock"]);
  assert.equal(spec.groupsInitialized, true);
  assert.equal("uid" in spec.options, false);
  assert.equal("gid" in spec.options, false);
  assert.deepEqual(spec.options.env, env, "the environment is exactly the one given");
  assert.equal(spec.options.cwd, "/work");
  assert.equal(spec.options.detached, true);
});

test("without setpriv the uid and gid options are used and the spec says the groups were not initialized", function () {
  var realWarn = console.warn;
  var warnings = [];
  console.warn = function (m) { warnings.push(m); };
  try {
    var spec = spawnAsUser.spawnSpecAsUser("/usr/bin/node", ["x.js"], ALICE, { env: {} }, NO_SETPRIV);
    assert.equal(spec.command, "/usr/bin/node");
    assert.deepEqual(spec.args, ["x.js"]);
    assert.equal(spec.options.uid, 1001);
    assert.equal(spec.options.gid, 1001);
    assert.equal(spec.groupsInitialized, false);
    assert.equal(warnings.length, 1, "the missing groups are said once");
    assert.match(warnings[0], /supplementary groups/);
    spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], ALICE, { env: {} }, NO_SETPRIV);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("a call with no identity is refused, never run as the daemon's user", function () {
  [null, undefined, {}, "clay-alice"].forEach(function (identity) {
    assert.throws(function () { spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], identity, { env: {} }, HAS_SETPRIV); }, function (e) {
      return e.code === "OS_USER_UNMAPPED" || e.code === "OS_USER_INVALID";
    }, String(identity));
  });
  assert.throws(function () { spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], null, { env: {} }, HAS_SETPRIV); }, { code: "OS_USER_UNMAPPED" });
});

test("root and malformed ids are refused", function () {
  [{ uid: 0, gid: 0 }, { uid: 1001, gid: -1 }, { uid: NaN, gid: 1001 }, { uid: "1001", gid: 1001 }, { uid: 1001, gid: 1.5 }].forEach(function (identity) {
    assert.throws(function () { spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], identity, { env: {} }, HAS_SETPRIV); }, { code: "OS_USER_INVALID" }, JSON.stringify(identity));
  });
});

test("the user is named by the identity alone, never by spawn options", function () {
  assert.throws(function () { spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], ALICE, { uid: 0, env: {} }, HAS_SETPRIV); }, { code: "OS_USER_INVALID" });
  assert.throws(function () { spawnAsUser.spawnSpecAsUser("/usr/bin/node", [], ALICE, { gid: 0, env: {} }, HAS_SETPRIV); }, { code: "OS_USER_INVALID" });
});

test("spawnAsUser and execFileSyncAsUser hand the spec to child_process", function () {
  var calls = [];
  var deps = Object.assign({}, HAS_SETPRIV, {
    spawn: function (command, args, options) { calls.push({ fn: "spawn", command: command, args: args, options: options }); return { pid: 1 }; },
    execFileSync: function (command, args, options) { calls.push({ fn: "execFileSync", command: command, args: args, options: options }); return "out"; },
  });
  assert.deepEqual(spawnAsUser.spawnAsUser("node", ["a"], ALICE, { env: { A: "1" } }, deps), { pid: 1 });
  assert.equal(spawnAsUser.execFileSyncAsUser("node", ["b"], ALICE, { env: { A: "1" }, timeout: 10 }, deps), "out");
  assert.equal(calls[0].fn, "spawn");
  assert.equal(calls[0].command, "/usr/bin/setpriv");
  assert.equal(calls[1].fn, "execFileSync");
  assert.deepEqual(calls[1].args.slice(-2), ["node", "b"]);
  assert.equal(calls[1].options.timeout, 10);
});

// --- Every site that starts a process as a user goes through the helper ---

function libFiles(dir) {
  var out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "public") out = out.concat(libFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  });
  return out;
}

// An object that names a uid and a gid and also carries something only a spawn
// call takes. An identity object (uid, gid, home, user, shell) does not.
function passesUidGidToSpawn(source) {
  var spawnKeys = "(?:env|cwd|stdio|timeout|detached|maxBuffer)";
  var after = new RegExp("\\buid:\\s*[\\w.]*uid,\\s*gid:\\s*[\\w.]*gid,([^}]*)\\}", "g");
  var before = new RegExp("\\b" + spawnKeys + "\\s*:[^{}]*\\buid:\\s*[\\w.]*uid,\\s*gid:", "");
  var carries = new RegExp("\\b" + spawnKeys + "\\s*:");
  var match;
  while ((match = after.exec(source)) !== null) {
    if (carries.test(match[1])) return true;
  }
  return before.test(source);
}

test("the detector finds the shapes the sites used to have, and not an identity object", function () {
  // As the Claude worker, the skill removal and the file helper once did.
  assert.equal(passesUidGidToSpawn("spawn(node, args, {\n  uid: userInfo.uid,\n  gid: userInfo.gid,\n  env: workerEnv,\n  cwd: cwd,\n});"), true);
  assert.equal(passesUidGidToSpawn("execFileSync(node, args, {\n  uid: info.uid,\n  gid: info.gid,\n  timeout: 10000,\n});"), true);
  assert.equal(passesUidGidToSpawn("execFileSync(node, args, {\n  encoding: 'utf8',\n  timeout: 10000,\n  uid: osUserInfo.uid,\n  gid: osUserInfo.gid,\n});"), true);
  assert.equal(passesUidGidToSpawn("buildUserEnv({\n  uid: userInfo.uid,\n  gid: userInfo.gid,\n  home: userInfo.home,\n  user: linuxUser,\n});\nspawnAsUser(x, y, info, { env: e });"), false);
});

test("no site passes uid/gid spawn options directly, except the ones with a stated reason", function () {
  var lib = path.join(__dirname, "..", "lib");
  var allowed = {
    // The helper's own fallback when setpriv is not installed.
    "os-user-spawn.js": true,
    // Read-only git run as the uid that owns the repository (project-git.js),
    // and the git init of a project directory that was just created for the
    // user: neither needs the user's groups.
    "project-git.js": true,
    "daemon.js": true,
  };
  var offenders = libFiles(lib).filter(function (file) {
    return !allowed[path.relative(lib, file)] && passesUidGidToSpawn(fs.readFileSync(file, "utf8"));
  }).map(function (file) { return path.relative(lib, file); });
  assert.deepEqual(offenders, [], "start the process through lib/os-user-spawn.js");
});
