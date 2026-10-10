"use strict";
// The installed build must ship the SDK versions package-lock.json pins:
// `npm install -g <tarball>` ignores the lock, so without this check `npm test`
// can exercise one SDK while the service runs another. These tests execute the
// real CLI entry against fixture install trees (no global npm state touched).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");

var REPO = path.join(__dirname, "..");
var SCRIPT = path.join(REPO, "scripts", "check-sdk-lock-drift.js");
var drift = require("../scripts/check-sdk-lock-drift");

function makeTree(lockVersions, installedVersions) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-sdk-drift-"));
  var packages = {};
  Object.keys(lockVersions).forEach(function (name) {
    packages["node_modules/" + name] = { version: lockVersions[name] };
  });
  var lockPath = path.join(root, "package-lock.json");
  fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: packages }));
  var installedRoot = path.join(root, "installed");
  Object.keys(installedVersions).forEach(function (name) {
    var dir = path.join(installedRoot, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: name, version: installedVersions[name] }));
  });
  fs.mkdirSync(installedRoot, { recursive: true });
  return { root: root, lockPath: lockPath, installedRoot: installedRoot };
}

function run(tree) {
  var result = spawnSync(process.execPath, [SCRIPT, "--lock", tree.lockPath, "--installed-root", tree.installedRoot], {
    encoding: "utf8",
  });
  fs.rmSync(tree.root, { recursive: true, force: true });
  return result;
}

var AGENT = "@anthropic-ai/claude-agent-sdk";
var CORE = "@anthropic-ai/sdk";

test("passes when the installed SDK versions equal the locked versions", function () {
  var result = run(makeTree(
    { [AGENT]: "0.3.295", [CORE]: "0.104.2" },
    { [AGENT]: "0.3.295", [CORE]: "0.104.2" }
  ));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches package-lock\.json/);
});

test("fails when the installed agent SDK differs from the lock (the original production drift)", function () {
  var result = run(makeTree(
    { [AGENT]: "0.3.173", [CORE]: "0.104.1" },
    { [AGENT]: "0.3.295", [CORE]: "0.104.2" }
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SDK_LOCK_DRIFT/);
  assert.match(result.stderr, /claude-agent-sdk: lock pins 0\.3\.173, installed build has 0\.3\.295/);
  assert.match(result.stderr, /@anthropic-ai\/sdk: lock pins 0\.104\.1, installed build has 0\.104\.2/);
});

test("fails when only one tracked package drifts", function () {
  var result = run(makeTree(
    { [AGENT]: "0.3.295", [CORE]: "0.104.2" },
    { [AGENT]: "0.3.295", [CORE]: "0.104.3" }
  ));
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /claude-agent-sdk: lock pins/);
  assert.match(result.stderr, /@anthropic-ai\/sdk: lock pins 0\.104\.2, installed build has 0\.104\.3/);
});

test("fails when a tracked package is missing from the installed build", function () {
  var result = run(makeTree(
    { [AGENT]: "0.3.295", [CORE]: "0.104.2" },
    { [AGENT]: "0.3.295" }
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\(not installed\)/);
});

test("fails (never passes) when the lock cannot be read or lacks a tracked package", function () {
  var tree = makeTree({ [AGENT]: "0.3.295" }, { [AGENT]: "0.3.295", [CORE]: "0.104.2" });
  var result = run(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no locked version for @anthropic-ai\/sdk/);

  var missingLock = spawnSync(process.execPath, [SCRIPT, "--lock", path.join(os.tmpdir(), "does-not-exist.json"), "--installed-root", os.tmpdir()], {
    encoding: "utf8",
  });
  assert.equal(missingLock.status, 1);
  assert.match(missingLock.stderr, /ERROR/);
});

test("findDrift reports nothing for equal maps and one entry per differing package", function () {
  assert.deepEqual(drift.findDrift({ a: "1.0.0" }, { a: "1.0.0" }), []);
  assert.deepEqual(drift.findDrift({ a: "1.0.0", b: "2.0.0" }, { a: "1.0.1", b: "2.0.0" }), [
    { name: "a", locked: "1.0.0", installed: "1.0.1" },
  ]);
});

test("the repo lock agrees with package.json and pins one version across the agent SDK platform packages", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  var lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies,
    "lock root dependency ranges must equal package.json (npm ci refuses a mismatch)");

  var agent = lock.packages["node_modules/" + AGENT];
  assert.ok(agent, "lock must contain the agent SDK");
  var optional = agent.optionalDependencies;
  Object.keys(optional).forEach(function (name) {
    assert.equal(optional[name], agent.version, name + " optional dependency must pin the agent SDK version");
    var entry = lock.packages["node_modules/" + name];
    assert.ok(entry, "lock must contain " + name);
    assert.equal(entry.version, agent.version, name + " lock entry must be the agent SDK version");
    assert.match(entry.integrity, /^sha512-/, name + " must carry an integrity hash");
    assert.equal(entry.resolved, "https://registry.npmjs.org/" + name + "/-/" + name.split("/")[1] + "-" + agent.version + ".tgz");
  });
});

test("verify:installed-build runs the drift check after the artifact check", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  var cmd = pkg.scripts["verify:installed-build"];
  assert.match(cmd, /verify-installed-build\.js\s*&&\s*node scripts\/check-sdk-lock-drift\.js/);
});
