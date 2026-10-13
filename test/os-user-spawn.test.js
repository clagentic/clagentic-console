"use strict";
// Starting a process as another OS user: the user's groups are initialized
// (Node's own uid/gid options drop every supplementary group), the daemon's
// environment is not inherited, and a call with no identity, or root, is refused
// instead of running as the daemon's user. One spec per caller shape: setpriv
// present, setpriv absent, no mapping, and then every caller of the helper
// (the Claude worker, the HTTP skill removal, the file helper, the Codex
// app-server, the Codex version probe) observed at the child_process boundary,
// each with an identity and with a refused one.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");
var EventEmitter = require("events");
var PassThrough = require("stream").PassThrough;

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

// --- Every caller of the helper, observed where the process would start ---

// The account lookup is stubbed before any caller module takes its own copy.
var osUsers = require("../lib/os-users");
osUsers.resolveOsUserInfo = function (name) {
  if (name === "clay-alice") return ALICE;
  throw new Error("Unexpected getent output for user " + name);
};

var claudeAdapter = require("../lib/yoke/adapters/claude");
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var codexBinary = require("../lib/yoke/codex-binary");
var projectHttp = require("../lib/project-http");

function fakeProcess() {
  var proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  proc.kill = function () {};
  return proc;
}

// Records every process the code under test would start, and starts none.
function interceptProcesses(execResult) {
  var real = { spawn: childProcess.spawn, execFileSync: childProcess.execFileSync };
  var started = [];
  childProcess.spawn = function (command, args, options) {
    started.push({ fn: "spawn", command: command, args: args, options: options });
    return fakeProcess();
  };
  childProcess.execFileSync = function (command, args, options) {
    started.push({ fn: "execFileSync", command: command, args: args, options: options });
    return typeof execResult === "function" ? execResult(command, args, options) : (execResult || "");
  };
  return {
    started: started,
    restore: function () {
      childProcess.spawn = real.spawn;
      childProcess.execFileSync = real.execFileSync;
    },
  };
}

// The process runs as the identity: through setpriv with its ids, or with the
// uid/gid options when setpriv is not installed. Either way, never inherited env.
function assertStartedAs(call, identity, label) {
  var viaSetpriv = /setpriv$/.test(call.command);
  if (viaSetpriv) {
    assert.deepEqual(call.args.slice(0, 5), ["--reuid", String(identity.uid), "--regid", String(identity.gid), "--init-groups"], label);
    assert.equal("uid" in call.options, false, label);
  } else {
    assert.equal(call.options.uid, identity.uid, label);
    assert.equal(call.options.gid, identity.gid, label);
  }
  assert.ok(call.options.env, label + ": an environment is given");
  assert.equal(call.options.env.DAEMON_ONLY_SECRET, undefined, label + ": the daemon's environment is not inherited");
  assert.equal(call.options.env.HOME, identity.home, label);
}

var REFUSED_IDENTITIES = [
  { name: "root", identity: { uid: 0, gid: 0, home: "/root", user: "root", shell: "/bin/bash" }, code: "OS_USER_INVALID" },
  { name: "no identity", identity: null, code: "OS_USER_UNMAPPED" },
];

var savedSecret;
test.before(function () { savedSecret = process.env.DAEMON_ONLY_SECRET; process.env.DAEMON_ONLY_SECRET = "daemon-secret"; });
test.after(function () {
  if (savedSecret === undefined) delete process.env.DAEMON_ONLY_SECRET; else process.env.DAEMON_ONLY_SECRET = savedSecret;
});

test("file helper (fsAsUser): every operation starts as the user; an identity that is refused starts nothing", function () {
  var spy = interceptProcesses(function (command, args) {
    return /toString\('base64'\)/.test(args.join(" ")) ? Buffer.from("png").toString("base64") : "{\"ok\":true}";
  });
  try {
    osUsers.fsAsUser("write", { file: "/p/f.txt", content: "x" }, ALICE);
    var bin = osUsers.fsAsUser("read_binary", { file: "/p/i.png" }, ALICE);
    assert.equal(bin.buffer.toString(), "png");
    assert.equal(spy.started.length, 2);
    spy.started.forEach(function (call, i) { assertStartedAs(call, ALICE, "fsAsUser #" + i); });

    REFUSED_IDENTITIES.forEach(function (shape) {
      assert.throws(function () { osUsers.fsAsUser("write", { file: "/p/f.txt", content: "x" }, shape.identity); }, { code: shape.code }, shape.name);
      assert.throws(function () { osUsers.fsAsUser("read_binary", { file: "/p/i.png" }, shape.identity); }, { code: shape.code }, shape.name);
    });
    assert.equal(spy.started.length, 2, "a refused identity starts no process");
  } finally {
    spy.restore();
  }
});

function httpRequest(handler, body) {
  var req = new EventEmitter();
  req.method = "POST";
  var res = { status: null, body: "", ended: false, writeHead: function (s) { this.status = s; }, end: function (b) { this.body = b || ""; this.ended = true; } };
  assert.equal(handler(req, res, "/api/uninstall-skill"), true);
  setImmediate(function () { req.emit("data", JSON.stringify(body)); req.emit("end"); });
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 3000;
    (function poll() {
      if (res.ended) return resolve(res);
      if (Date.now() > deadline) return reject(new Error("the request was never answered"));
      setTimeout(poll, 5);
    })();
  });
}

function skillRemovalHandler(getOsUserInfoForReq, cwd) {
  return projectHttp.attachHTTP({
    cwd: cwd, slug: "p", send: function () {}, getOsUserInfoForReq: getOsUserInfoForReq,
  }).handleHTTP;
}

test("HTTP skill removal: an OS user's skill is removed by a process started as that user; a refused identity removes nothing", async function () {
  var spy = interceptProcesses("");
  try {
    var handler = skillRemovalHandler(function () { return ALICE; }, os.tmpdir());
    var res = await httpRequest(handler, { skill: "my-skill", scope: "global" });
    assert.equal(res.status, 200);
    assert.equal(spy.started.length, 1);
    assertStartedAs(spy.started[0], ALICE, "skill removal");
    assert.ok(spy.started[0].args.join(" ").indexOf("/home/clay-alice/.claude/skills/my-skill") !== -1, "it removes the user's own skill directory");

    for (var i = 0; i < REFUSED_IDENTITIES.length; i++) {
      var shape = REFUSED_IDENTITIES[i];
      if (shape.identity === null) continue; // no identity means the daemon's own account, which has its own path
      var refusedHandler = skillRemovalHandler(function () { return shape.identity; }, os.tmpdir());
      var refused = await httpRequest(refusedHandler, { skill: "my-skill", scope: "global" });
      assert.equal(refused.status, 500, shape.name);
      assert.match(refused.body, /refusing to start a process as uid 0/);
    }
    assert.equal(spy.started.length, 1, "a refused identity starts no process");
  } finally {
    spy.restore();
  }
});

test("Claude worker: the worker starts as the user with an isolated environment", async function () {
  var spy = interceptProcesses();
  var worker = null;
  try {
    worker = claudeAdapter._test_spawnWorker("clay-alice", "/opt/app/sdk-worker.js", os.tmpdir());
    var deadline = Date.now() + 3000;
    while (spy.started.length === 0 && Date.now() < deadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 5); });
    }
    assert.equal(spy.started.length, 1, "the worker was started");
    var call = spy.started[0];
    assertStartedAs(call, ALICE, "claude worker");
    assert.ok(call.args.indexOf("/opt/app/sdk-worker.js") !== -1);
    assert.equal(call.options.detached, true);
  } finally {
    if (worker && worker.server) worker.server.close();
    spy.restore();
  }
});

test("Claude worker: a user with no account starts no process", function () {
  var spy = interceptProcesses();
  try {
    assert.throws(function () { claudeAdapter._test_spawnWorker("clay-ghost", "/opt/app/sdk-worker.js", os.tmpdir()); }, /Unexpected getent output/);
    assert.equal(spy.started.length, 0);
  } finally {
    spy.restore();
  }
});

test("Codex app-server: started as the user from the environment it was given; a refused identity starts nothing", async function () {
  var spy = interceptProcesses();
  try {
    var env = { HOME: ALICE.home, PATH: "/usr/bin", USER: ALICE.user };
    var server = new codexAppServerModule.CodexAppServer("/opt/codex/bin/codex", { osUser: ALICE, env: env, cwd: os.tmpdir() });
    await server.start();
    server.stop();
    assert.equal(spy.started.length, 1);
    assertStartedAs(spy.started[0], ALICE, "codex app-server");
    assert.ok(spy.started[0].args.indexOf("app-server") !== -1);

    for (var i = 0; i < REFUSED_IDENTITIES.length; i++) {
      var shape = REFUSED_IDENTITIES[i];
      var refused = new codexAppServerModule.CodexAppServer("/opt/codex/bin/codex", { osUser: shape.identity || {}, env: env, cwd: os.tmpdir() });
      await assert.rejects(refused.start(), function (e) { return e.code === "OS_USER_INVALID" || e.code === "OS_USER_UNMAPPED"; }, shape.name);
    }
    assert.equal(spy.started.length, 1, "a refused identity starts no process");
  } finally {
    spy.restore();
  }
});

test("Codex version probe: an OS user's binary is asked for its version as that user", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "os-user-spawn-"));
  var spy = null;
  try {
    var binary = path.join(dir, "codex");
    fs.writeFileSync(binary, "#!/bin/sh\n");
    fs.chmodSync(binary, 0o755);
    spy = interceptProcesses("codex-cli 0.162.1\n");
    var result = codexBinary.resolveCodexBinary({ linuxUser: "clay-alice", env: { CLAGENTIC_CONSOLE_CODEX_PATH: binary, PATH: "" } });
    assert.equal(result.state, "ready");
    assert.equal(result.version, "0.162.1");
    assert.equal(spy.started.length, 1);
    assertStartedAs(spy.started[0], ALICE, "version probe");
    assert.ok(spy.started[0].args.indexOf("--version") !== -1);

    var unmapped = codexBinary.resolveCodexBinary({ linuxUser: "clay-ghost", env: { CLAGENTIC_CONSOLE_CODEX_PATH: binary, PATH: "" } });
    assert.equal(unmapped.state, "failed");
    assert.equal(unmapped.probeClass, "os-user-unmapped");
    assert.equal(spy.started.length, 1, "an unmapped user starts no process");
  } finally {
    if (spy) spy.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
