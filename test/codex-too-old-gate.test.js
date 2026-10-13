"use strict";
// The version gate on every way the adapter acquires an app-server: starting
// the adapter, listing models, a new query, a resumed query, a title, a fork and
// a rewind. The real app-server class is used for resolution (the stand-in
// `codex` scripts print a version line), with only its process start and its
// requests replaced by recorders, so the assertion is on what would have been
// sent: nothing when the binary is too old or the override is invalid, and only
// initialize when the binary is fine but the app-server reports a version under
// the floor.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAppServerModule = require("../lib/yoke/codex-app-server");
var codexBinary = require("../lib/yoke/codex-binary");
var Real = codexAppServerModule.CodexAppServer;

var ENV_NAME = "CLAGENTIC_CONSOLE_CODEX_PATH";
var built = [];
var userAgent = null;

function Recording(executablePath, opts) {
  // The real constructor resolves the user's Codex and throws the named error
  // for one that is absent, invalid or too old; nothing is recorded before it.
  Real.call(this, executablePath, opts);
  this.requests = [];
  this.starts = 0;
  built.push(this);
}
Recording.prototype = Object.create(Real.prototype);
Recording.prototype.constructor = Recording;
Recording.prototype.start = function () { this.starts++; this.started = true; return Promise.resolve(); };
Recording.prototype.send = function (method) {
  this.requests.push(method);
  if (method === "initialize") return Promise.resolve({ userAgent: userAgent });
  return Promise.resolve({});
};
Recording.prototype.notify = function () {};
codexAppServerModule.CodexAppServer = Recording;

var codexModule = require("../lib/yoke/adapters/codex");

var tmpRoots = [];
test.after(function () { tmpRoots.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

function tmpDir() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gate-"));
  tmpRoots.push(dir);
  return dir;
}

function standIn(dir, versionLine) {
  var file = path.join(dir, "codex");
  fs.writeFileSync(file, "#!/bin/sh\necho '" + versionLine + "'\n");
  fs.chmodSync(file, 0o755);
  return file;
}

// Runs fn with the daemon's environment pointing at one Codex situation.
async function withCodex(situation, fn) {
  var saved = { PATH: process.env.PATH, override: process.env[ENV_NAME] };
  delete process.env[ENV_NAME];
  if (situation.override) process.env[ENV_NAME] = situation.override;
  if (situation.dir) process.env.PATH = situation.dir;
  codexBinary.invalidate();
  built.length = 0;
  try {
    await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.override === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = saved.override;
    codexBinary.invalidate();
  }
}

var ENV_OPTS = { runtimeEnv: null };

// Every acquire path, each as a function of a fresh adapter.
var PATHS = {
  init: function (a) { return a.init(ENV_OPTS); },
  "model list": function (a) { return a.supportedModels(ENV_OPTS); },
  query: function (a, cwd) { return a.createQuery({ cwd: cwd, model: "gpt-test", runtimeEnv: null }); },
  resume: function (a, cwd) { return a.createQuery({ cwd: cwd, model: "gpt-test", runtimeEnv: null, resumeSessionId: "thread-9" }); },
  title: function (a, cwd) { return a.generateTitle(["hello"], { cwd: cwd, runtimeEnv: null }); },
  fork: function (a) { return a.forkSession("thread-9", ENV_OPTS); },
  rewind: function (a) { return a.rollbackThread("thread-9", 1, ENV_OPTS); },
};

Object.keys(PATHS).forEach(function (name) {
  test("a binary below the floor: " + name + " throws CODEX_TOO_OLD and no app-server is made or asked anything", async function () {
    var dir = tmpDir();
    standIn(dir, "codex-cli 0.147.9");
    await withCodex({ dir: dir }, async function () {
      var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
      await assert.rejects(PATHS[name](adapter, dir), function (e) {
        return e.code === "CODEX_TOO_OLD" && /Codex 0\.147\.9 is too old; Clagentic: Console needs 0\.148\.0 or newer/.test(e.message);
      });
      assert.equal(built.length, 0, "no app-server was built, so no request could be sent");
      await adapter.shutdown();
    });
  });

  test("an invalid override path: " + name + " throws CODEX_OVERRIDE_INVALID and no app-server is made", async function () {
    var dir = tmpDir();
    standIn(dir, "codex-cli 0.162.1");
    await withCodex({ dir: dir, override: path.join(dir, "missing") }, async function () {
      var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
      await assert.rejects(PATHS[name](adapter, dir), { code: "CODEX_OVERRIDE_INVALID" });
      assert.equal(built.length, 0);
      await adapter.shutdown();
    });
  });

  test("an app-server reporting a version below the floor: " + name + " throws CODEX_TOO_OLD after initialize and sends nothing else", async function () {
    var dir = tmpDir();
    standIn(dir, "codex-cli 0.162.1");
    userAgent = "clagentic-console/0.147.2 (Linux) test";
    await withCodex({ dir: dir }, async function () {
      var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
      await assert.rejects(PATHS[name](adapter, dir), { code: "CODEX_TOO_OLD" });
      assert.ok(built.length >= 1);
      built.forEach(function (server) {
        assert.deepEqual(server.requests, ["initialize"], "only the handshake that reports the version was sent");
      });
      await adapter.shutdown();
    });
  });
});
