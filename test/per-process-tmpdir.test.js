"use strict";
// The test-run temp root: the preload gives a process its own TMPDIR and removes
// it on exit, and the access harness waits for a child it did not start itself.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawn, spawnSync } = require("child_process");

var PRELOAD = path.join(__dirname, "helpers", "per-process-tmpdir.js");

var LEAKY_PROCESS = [
  "var fs = require('fs'); var os = require('os'); var path = require('path');",
  "var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));",
  "fs.writeFileSync(path.join(dir, 'f'), 'x');",
  "var cp = require('child_process');",
  "cp.spawnSync(process.execPath, ['-e', \"var fs=require('fs');var os=require('os');var p=require('path');fs.mkdtempSync(p.join(os.tmpdir(),'child-leak-'))\"]);",
  "process.stdout.write(process.env.TMPDIR);",
].join("\n");

// A writer the harness has no handle to: it writes userhome/.claude.json for a
// while after its parent is done, as a claude CLI child does while it exits.
var CLI_STAND_IN = [
  "var fs = require('fs'); var path = require('path');",
  "var file = path.join(process.env.HOME, '.claude.json');",
  "process.on('SIGTERM', function () {",
  "  setTimeout(function () { fs.writeFileSync(file, '{}'); process.exit(0); }, 300);",
  "});",
  "setInterval(function () {}, 1000);",
  "process.stdout.write('ready');",
].join("\n");

test("the preload removes its per-process temp root, and what a child left in it, on exit", function () {
  var base = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-base-"));
  try {
    var env = Object.assign({}, process.env, { TMPDIR: base });
    var run = spawnSync(process.execPath, ["--require", PRELOAD, "-e", LEAKY_PROCESS], { env: env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.indexOf(base) === 0 && run.stdout !== base, "the process saw a root under the inherited one: " + run.stdout);
    assert.deepEqual(fs.readdirSync(base), [], "nothing is left under the inherited root");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// One child shows the three properties the full suite depends on: a synthetic
// process.emit("exit") leaves the root alone, the root is traversable by other
// users, and an inherited root too long for socket paths is not nested under.
var PROPERTIES_PROCESS = [
  "var fs = require('fs');",
  "var root = process.env.TMPDIR;",
  "process.emit('exit', 0);",
  "process.stdout.write(JSON.stringify({ root: root, survived: fs.existsSync(root), mode: fs.statSync(root).mode & 0o777 }));",
].join("\n");

test("the preload keeps its root across a synthetic exit emit, opens it to traversal, and skips an inherited root too long for socket paths", function () {
  var base = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-long-"));
  try {
    var longRoot = path.join(base, "a".repeat(60));
    fs.mkdirSync(longRoot);
    var env = Object.assign({}, process.env, { TMPDIR: longRoot });
    var run = spawnSync(process.execPath, ["--require", PRELOAD, "-e", PROPERTIES_PROCESS], { env: env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    var seen = JSON.parse(run.stdout);
    assert.equal(seen.survived, true, "process.emit('exit') is not the real exit");
    assert.equal(seen.mode, 0o755);
    assert.ok(seen.root.indexOf(longRoot) !== 0, "the long inherited root is not nested under: " + seen.root);
    assert.deepEqual(fs.readdirSync(longRoot), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("access harness stop() waits for a CLI child it holds no handle to, and the home is gone", async function () {
  var harness = require("./access-harness");
  var server = await harness.start({ users: [], projects: [] });
  var home = server.home;
  var child = spawn(process.execPath, ["-e", CLI_STAND_IN], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise(function (resolve) { child.stdout.once("data", resolve); });
    await server.stop();
    assert.equal(fs.existsSync(home), false, "the harness folder, userhome/.claude.json included, is gone");
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    assert.equal(fs.existsSync(home), false, "and nothing recreated it");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});
