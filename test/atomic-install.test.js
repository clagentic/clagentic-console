// Unit rows for lib/atomic-install.js: the staged install and rename swap that
// keeps the clagentic-console command resolvable while a build is installed.
// The staging npm step is replaced by a function that writes a package tree, so
// these rows run no npm; the one npm run lives in atomic-install-npm.test.js.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { installGlobalAtomically } = require("../lib/atomic-install");
var installLocalTest = require("../scripts/install-local-test");

var PKG = "@clagentic/console";
var BIN_REL = "bin/cli.js";

function writePackage(dir, tag, extra) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "cli.js"), tag);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(Object.assign({
    name: PKG,
    version: "1.0.0",
    bin: { "clagentic-console": BIN_REL },
  }, extra || {})));
}

// A prefix holding an installed build, linked the way npm links a global bin.
function makeLive(tag) {
  var prefix = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-install-unit-"));
  if (tag) {
    var pkgDir = path.join(prefix, "lib", "node_modules", PKG);
    writePackage(pkgDir, tag);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.symlinkSync("../lib/node_modules/@clagentic/console/bin/cli.js", path.join(prefix, "bin", "clagentic-console"));
  }
  return prefix;
}

function binPathOf(prefix) { return path.join(prefix, "bin", "clagentic-console"); }

// What the command would run right now; throws when it does not resolve.
function runningBuild(prefix) { return fs.readFileSync(binPathOf(prefix), "utf8"); }

// Stands in for the staging `npm install -g --prefix <stage>`.
function fakeNpm(tag, extraPkg, failAfterWrite) {
  return async function (args) {
    var stage = args[args.indexOf("--prefix") + 1];
    writePackage(path.join(stage, "lib", "node_modules", PKG), tag, extraPkg);
    if (failAfterWrite) throw new Error("npm exited with status 1");
  };
}

// Wraps the filesystem so every mutating call is logged and the command is
// checked to resolve straight after it.
function watchedFs(prefix) {
  var log = [];
  var unresolved = [];
  var wrapped = Object.assign({}, fs);
  ["renameSync", "symlinkSync", "rmSync", "unlinkSync"].forEach(function (op) {
    wrapped[op] = function () {
      var result = fs[op].apply(fs, arguments);
      log.push({ op: op, args: Array.prototype.slice.call(arguments) });
      if (!fs.existsSync(binPathOf(prefix))) unresolved.push(op + " " + arguments[0]);
      return result;
    };
  });
  return { fs: wrapped, log: log, unresolved: unresolved };
}

function cleanup(prefix) { fs.rmSync(prefix, { recursive: true, force: true }); }

test("a failed staging install leaves the live install untouched", async function () {
  var prefix = makeLive("old");
  try {
    var linkBefore = fs.readlinkSync(binPathOf(prefix));
    await assert.rejects(
      installGlobalAtomically({ spec: "x", prefix: prefix, runNpm: fakeNpm("new", null, true) }),
      /npm exited with status 1/
    );
    assert.equal(runningBuild(prefix), "old");
    assert.equal(fs.readlinkSync(binPathOf(prefix)), linkBefore);
    assert.deepEqual(fs.readdirSync(path.join(prefix, "lib")), ["node_modules"], "staging directory is removed");
    assert.deepEqual(fs.readdirSync(path.join(prefix, "lib", "node_modules", "@clagentic")), ["console"]);
  } finally { cleanup(prefix); }
});

test("the bin is replaced by rename, never removed, and resolves after every step", async function () {
  var prefix = makeLive("old");
  try {
    var watch = watchedFs(prefix);
    await installGlobalAtomically({ spec: "x", prefix: prefix, fs: watch.fs, runNpm: fakeNpm("new") });
    assert.deepEqual(watch.unresolved, [], "the command resolved between every pair of steps");
    var bin = binPathOf(prefix);
    var removed = watch.log.filter(function (e) { return e.op === "unlinkSync" || e.op === "rmSync"; })
      .map(function (e) { return e.args[0]; });
    assert.ok(!removed.includes(bin), "the bin link is never removed");
    assert.ok(watch.log.some(function (e) { return e.op === "renameSync" && e.args[1] === bin; }), "a temporary link is renamed over the bin");
    assert.equal(runningBuild(prefix), "new");
    assert.equal(fs.readlinkSync(bin), "../lib/node_modules/@clagentic/console/bin/cli.js");
    assert.deepEqual(fs.readdirSync(path.join(prefix, "bin")), ["clagentic-console"], "no temporary link is left");
    assert.deepEqual(fs.readdirSync(path.join(prefix, "lib", "node_modules", "@clagentic")), ["console"], "the old package directory is removed");
    assert.deepEqual(fs.readdirSync(path.join(prefix, "lib")), ["node_modules"]);
  } finally { cleanup(prefix); }
});

test("a first install moves the package in with one rename and links the bin", async function () {
  var prefix = makeLive(null);
  try {
    var watch = watchedFs(prefix);
    var result = await installGlobalAtomically({ spec: "x", prefix: prefix, fs: watch.fs, runNpm: fakeNpm("first") });
    assert.equal(result.mode, "atomic");
    assert.equal(runningBuild(prefix), "first");
    var finalDir = path.join(prefix, "lib", "node_modules", PKG);
    var intoPlace = watch.log.filter(function (e) { return e.op === "renameSync" && e.args[1] === finalDir; });
    assert.equal(intoPlace.length, 1);
  } finally { cleanup(prefix); }
});

test("the package's postinstall runs at the final location and a failure restores the previous build", async function () {
  var prefix = makeLive("old");
  try {
    var seen = null;
    var scripts = { scripts: { postinstall: "node scripts/postinstall.js" } };
    await installGlobalAtomically({
      spec: "x", prefix: prefix, runNpm: fakeNpm("new", scripts),
      runScript: async function (command, o) { seen = { command: command, cwd: o.cwd, global: o.env.npm_config_global, prefix: o.env.npm_config_prefix }; },
    });
    assert.deepEqual(seen, {
      command: "node scripts/postinstall.js",
      cwd: path.join(prefix, "lib", "node_modules", PKG),
      global: "true",
      prefix: prefix,
    });
    assert.equal(runningBuild(prefix), "new");

    await assert.rejects(installGlobalAtomically({
      spec: "x", prefix: prefix, runNpm: fakeNpm("newer", scripts),
      runScript: async function () { throw new Error("script exited with status 1"); },
    }), /postinstall failed, the previous build was kept/);
    assert.equal(runningBuild(prefix), "new", "the build before the failed install is still the one running");
    assert.deepEqual(fs.readdirSync(path.join(prefix, "lib", "node_modules", "@clagentic")), ["console"]);
  } finally { cleanup(prefix); }
});

test("install:local-test: a build already installed with identical files still skips the install", async function () {
  var installs = 0;
  var outcome = await installLocalTest.main({
    argv: ["node", "install-local-test.js"],
    shouldSkip: function () { return true; },
    install: async function () { installs++; },
  });
  assert.equal(outcome, "skipped");
  assert.equal(installs, 0);
});
