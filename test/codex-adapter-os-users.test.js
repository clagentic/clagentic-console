"use strict";
// Codex under OS-level user isolation: one app-server per OS user, started as
// that user from that user's own environment, and never as the daemon's user.
// The app-server class is a stand-in that records how it was started; no
// process is spawned and no account is needed (account lookups are stubbed).
// One test per caller shape: isolation off (unchanged), isolation on with a
// session of each user, a user with no account, and a call that names none.

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");

var codexAppServerModule = require("../lib/yoke/codex-app-server");
var servers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.executablePath = executablePath;
  this.started = false;
  this.stopped = false;
  this.calls = [];
  servers.push(this);
}
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; this.stopped = true; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.send = function (method, params) {
  this.calls.push({ method: method, params: params });
  if (method === "model/list") return Promise.resolve({ data: [{ model: "gpt-test", displayName: "GPT Test", isDefault: true }] });
  if (method === "skills/list") return Promise.resolve({ data: [] });
  if (method === "thread/read") return Promise.resolve({ thread: { id: params.threadId, turns: [{ id: "t1" }, { id: "t2" }] } });
  if (method === "thread/resume") return Promise.resolve({ thread: { id: params.threadId } });
  if (method === "thread/fork") return Promise.resolve({ thread: { id: "fork-of-" + params.threadId } });
  return Promise.resolve({});
};
FakeAppServer.prototype.addEventHandler = function () { return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var osUsers = require("../lib/os-users");
var codexModule = require("../lib/yoke/adapters/codex");

var ACCOUNTS = {
  "clay-alice": { uid: 1001, gid: 1001, home: "/home/clay-alice", user: "clay-alice", shell: "/bin/bash" },
  "clay-bob": { uid: 1002, gid: 1002, home: "/home/clay-bob", user: "clay-bob", shell: "/bin/bash" },
};
osUsers.resolveOsUserInfo = function (name) {
  if (!ACCOUNTS[name]) throw new Error("Unexpected getent output for user " + name);
  return ACCOUNTS[name];
};

function adapter(opts) {
  return codexModule.createCodexAdapter(Object.assign({ cwd: os.tmpdir(), slug: "alpha" }, opts));
}

function lastServer() { return servers[servers.length - 1]; }

test("isolation off: the app-server is the daemon's, as before", async function () {
  var a = adapter();
  var before = servers.length;
  await a.init({ runtimeEnv: null });
  assert.equal(servers.length, before + 1);
  assert.equal(lastServer().opts.osUser, undefined);
  assert.equal(lastServer().opts.env, undefined, "it inherits the daemon's environment, nothing added");
  await a.shutdown();
});

test("isolation on: each user's sessions run on an app-server started as that user, from that user's environment", async function () {
  var realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "daemon-secret-key";
  try {
    var a = adapter({ osUsers: true });
    var before = servers.length;
    await a.init({ runtimeEnv: null, linuxUser: "clay-alice" });
    await a.init({ runtimeEnv: null, linuxUser: "clay-bob" });
    assert.equal(servers.length, before + 2, "one app-server per user");

    var alice = servers[before];
    var bob = servers[before + 1];
    assert.deepEqual(alice.opts.osUser, ACCOUNTS["clay-alice"], "started as alice");
    assert.deepEqual(bob.opts.osUser, ACCOUNTS["clay-bob"], "started as bob");
    assert.equal(alice.opts.env.HOME, "/home/clay-alice");
    assert.equal(alice.opts.env.USER, "clay-alice");
    assert.equal(bob.opts.env.HOME, "/home/clay-bob");
    assert.equal(alice.opts.env.OPENAI_API_KEY, undefined, "the daemon's credentials are not handed to a user's process");
    assert.equal(bob.opts.env.OPENAI_API_KEY, undefined);

    // A second call for alice is served by alice's server.
    await a.init({ runtimeEnv: null, linuxUser: "clay-alice" });
    assert.equal(servers.length, before + 2);
    await a.shutdown();
  } finally {
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
});

test("isolation on: the Settings variables are laid over the user's environment, not the daemon's", async function () {
  var a = adapter({ osUsers: true });
  await a.init({ runtimeEnv: { OPENAI_BASE_URL: "https://endpoint.example.invalid/v1", PATH: "/tmp/evil" }, linuxUser: "clay-alice" });
  var env = lastServer().opts.env;
  assert.equal(env.OPENAI_BASE_URL, "https://endpoint.example.invalid/v1");
  assert.equal(env.HOME, "/home/clay-alice");
  assert.notEqual(env.PATH, "/tmp/evil", "a protected variable is dropped");
  await a.shutdown();
});

test("isolation on: a query names its user under the adapter options and runs on that user's server", async function () {
  var a = adapter({ osUsers: true });
  var handle = await a.createQuery({
    cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: null,
    adapterOptions: { CODEX: { linuxUser: "clay-bob" } },
  });
  assert.deepEqual(lastServer().opts.osUser, ACCOUNTS["clay-bob"]);
  handle.close();
  await a.shutdown();
});

test("isolation on: a call that names no user is refused and no app-server is started", async function () {
  var a = adapter({ osUsers: true });
  var before = servers.length;
  var refusal = { code: "CODEX_OS_USER_REQUIRED" };
  await assert.rejects(a.init({ runtimeEnv: null }), refusal);
  await assert.rejects(a.supportedModels({ runtimeEnv: null }), refusal);
  await assert.rejects(a.createQuery({ cwd: os.tmpdir(), runtimeEnv: null }), refusal);
  await assert.rejects(a.generateTitle(["x"], { cwd: os.tmpdir(), runtimeEnv: null }), refusal);
  await assert.rejects(a.rollbackThread("t", 1, { runtimeEnv: null }), refusal);
  await assert.rejects(a.forkSession("t", { runtimeEnv: null }), refusal);
  assert.equal(servers.length, before, "nothing ran as the daemon's user");
  await a.shutdown();
});

// A title runs a query that never completes against this stand-in, so the title
// is left pending, the server it chose is read, and the adapter is shut down.
async function titleServerFor(callerOpts) {
  var a = adapter({ osUsers: true });
  var before = servers.length;
  var pending = a.generateTitle(["hello"], Object.assign({ cwd: os.tmpdir(), runtimeEnv: null }, callerOpts));
  var outcome = { rejected: null };
  pending.catch(function (e) { outcome.rejected = e; });
  var deadline = Date.now() + 3000;
  while (servers.length === before && !outcome.rejected && Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  var made = servers.slice(before);
  var rejected = outcome.rejected;
  await a.shutdown();
  await pending.catch(function () {});
  return { made: made, rejected: rejected };
}

test("isolation on: a title names its user as linuxUser, as osUser, or under the adapter options, and runs on that user's server", async function () {
  var shapes = [
    { name: "linuxUser", opts: { linuxUser: "clay-alice" } },
    { name: "osUser", opts: { osUser: "clay-alice" } },
    { name: "adapterOptions", opts: { adapterOptions: { CODEX: { linuxUser: "clay-alice" } } } },
  ];
  for (var i = 0; i < shapes.length; i++) {
    var run = await titleServerFor(shapes[i].opts);
    assert.equal(run.rejected, null, shapes[i].name + " is not refused as naming no user");
    assert.equal(run.made.length, 1, shapes[i].name + ": the title and its query share one server");
    assert.deepEqual(run.made[0].opts.osUser, ACCOUNTS["clay-alice"], shapes[i].name);
  }
});

test("isolation on: a title that names no user is refused and starts nothing", async function () {
  var run = await titleServerFor({});
  assert.equal(run.rejected && run.rejected.code, "CODEX_OS_USER_REQUIRED");
  assert.equal(run.made.length, 0);
});

test("isolation on: a user with no account is refused, never run as the daemon's user", async function () {
  var a = adapter({ osUsers: true });
  var before = servers.length;
  await assert.rejects(a.init({ runtimeEnv: null, linuxUser: "clay-ghost" }), { code: "CODEX_OS_USER_UNMAPPED" });
  assert.equal(servers.length, before);
  await a.shutdown();
});

test("isolation on: a rewind and a fork run on the session owner's server only", async function () {
  var a = adapter({ osUsers: true });
  await a.init({ runtimeEnv: null, linuxUser: "clay-alice" });
  var alice = lastServer();
  await a.init({ runtimeEnv: null, linuxUser: "clay-bob" });
  var bob = lastServer();

  await a.rollbackThread("thread-of-bob", 1, { runtimeEnv: null, linuxUser: "clay-bob" });
  await a.forkSession("thread-of-bob", { runtimeEnv: null, linuxUser: "clay-bob" });
  function count(server, method) { return server.calls.filter(function (c) { return c.method === method; }).length; }
  assert.equal(count(bob, "thread/revert"), 1);
  assert.equal(count(bob, "thread/fork"), 1);
  assert.equal(count(alice, "thread/revert"), 0, "alice's server never saw bob's thread");
  assert.equal(count(alice, "thread/fork"), 0);
  await a.shutdown();
});

test("the model list of a user with an app-server of their own is that server's", async function () {
  var a = adapter({ osUsers: true });
  var models = await a.supportedModels({ runtimeEnv: null, osUser: "clay-alice" });
  assert.equal(models[0].value, "gpt-test");
  assert.deepEqual(lastServer().opts.osUser, ACCOUNTS["clay-alice"], "the user is named with osUser by callers whose other agents read linuxUser as a request for a worker");
  await a.shutdown();
});
