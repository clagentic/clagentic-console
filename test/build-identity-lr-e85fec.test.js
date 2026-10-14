"use strict";

// The adopted / stale / inconclusive verdict and the content hash behind it.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { assessBuild, createBuildIdentity, createTreeHasher } = require("../lib/build-identity");

function makePackage(files) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "build-identity-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}');
  Object.keys(files).forEach(function (rel) {
    var abs = path.join(root, "lib", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel]);
  });
  return root;
}

// What npm does: a fresh copy of the same bytes, swapped in, so every inode is new.
function reinstallIdentical(root) {
  var staging = fs.mkdtempSync(path.join(os.tmpdir(), "build-identity-stage-"));
  fs.cpSync(path.join(root, "lib"), path.join(staging, "lib"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(staging, "package.json"));
  fs.rmSync(path.join(root, "lib"), { recursive: true });
  fs.renameSync(path.join(staging, "lib"), path.join(root, "lib"));
  fs.rmSync(path.join(root, "package.json"));
  fs.renameSync(path.join(staging, "package.json"), path.join(root, "package.json"));
  fs.rmSync(staging, { recursive: true });
}

test("assessBuild: same sha and same content is adopted", function () {
  var r = assessBuild({ sha: "s1", contentHash: "h1" }, { sha: "s1", contentHash: "h1" });
  assert.equal(r.state, "adopted");
});

test("assessBuild: a different sha is stale and carries both shas", function () {
  var r = assessBuild({ sha: "s1", contentHash: "h1" }, { sha: "s2", contentHash: "h2" });
  assert.equal(r.state, "stale");
  assert.equal(r.reason, "sha");
  assert.equal(r.loadedBuildSha, "s1");
  assert.equal(r.installedBuildSha, "s2");
});

test("assessBuild: the same sha over different files is stale", function () {
  var r = assessBuild({ sha: "s1", contentHash: "h1" }, { sha: "s1", contentHash: "h2" });
  assert.equal(r.state, "stale");
  assert.equal(r.reason, "content");
});

test("assessBuild: a missing piece is inconclusive with its reason, never adopted or stale", function () {
  assert.deepEqual(
    [
      assessBuild({ sha: null, contentHash: "h" }, { sha: "s", contentHash: "h" }),
      assessBuild({ sha: "s", contentHash: "h" }, { sha: null, contentHash: "h" }),
      assessBuild({ sha: "s", contentHash: null }, { sha: "s", contentHash: "h" }),
      assessBuild({ sha: "s", contentHash: "h" }, { sha: "s", contentHash: null }),
    ].map(function (r) { return r.state + ":" + r.reason; }),
    ["inconclusive:no-loaded-sha", "inconclusive:no-installed-sha", "inconclusive:hash-unavailable", "inconclusive:hash-unavailable"]
  );
});

test("assessBuild: differing shas with an unreadable installed tree are inconclusive, not stale", function () {
  var r = assessBuild({ sha: "s1", contentHash: "h1" }, { sha: "s2", contentHash: null });
  assert.equal(r.state, "inconclusive");
  assert.equal(r.reason, "hash-unavailable");
  var r2 = assessBuild({ sha: "s1", contentHash: null }, { sha: "s2", contentHash: "h2" });
  assert.equal(r2.state, "inconclusive");
});

test("build-identity requires no other lib module, so identity is captured before any is loaded", function () {
  var { spawnSync } = require("child_process");
  var libDir = path.join(__dirname, "..", "lib");
  var script =
    "var Module = require('module'); var seen = [];" +
    "var orig = Module._load;" +
    "Module._load = function (req) { if (req.charAt(0) === '.') seen.push(req); return orig.apply(this, arguments); };" +
    "require(process.argv[1]); process.stdout.write(JSON.stringify(seen));";
  var res = spawnSync(process.execPath, ["-e", script, path.join(libDir, "build-identity.js")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
});

test("the daemon entry requires build-identity before any other lib module", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  var first = /require\(["']\.\/([^"']+)["']\)/.exec(src);
  assert.equal(first && first[1], "build-identity");
});

test("assessBuild: adopted is never reported while the shas differ", function () {
  ["s1", "", null].forEach(function (installedSha) {
    var r = assessBuild({ sha: "s0", contentHash: "h" }, { sha: installedSha, contentHash: "h" });
    assert.notEqual(r.state, "adopted");
  });
});

test("an identical reinstall (new inodes, same bytes) hashes the same: adopted", function () {
  var root = makePackage({ "a.js": "one", "sub/b.js": "two", "build-sha.json": '{"sha":"s1"}' });
  var identity = createBuildIdentity(path.join(root, "lib"));
  assert.equal(identity.assess().state, "adopted");
  reinstallIdentical(root);
  var after = identity.assess();
  assert.equal(after.state, "adopted", JSON.stringify(after));
});

test("one changed file makes the installed tree differ: stale (content) under the same sha", function () {
  var root = makePackage({ "a.js": "one", "build-sha.json": '{"sha":"s1"}' });
  var identity = createBuildIdentity(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "a.js"), "changed");
  var after = identity.assess();
  assert.equal(after.state, "stale");
  assert.equal(after.reason, "content");
});

test("a new sha in build-sha.json is stale (sha)", function () {
  var root = makePackage({ "build-sha.json": '{"sha":"s1"}' });
  var identity = createBuildIdentity(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "build-sha.json"), '{"sha":"s2"}');
  var after = identity.assess();
  assert.equal(after.state, "stale");
  assert.equal(after.reason, "sha");
  assert.equal(after.loadedBuildSha, "s1");
  assert.equal(after.installedBuildSha, "s2");
});

test("a checkout without build-sha.json is inconclusive, not stale", function () {
  var root = makePackage({ "a.js": "one" });
  var identity = createBuildIdentity(path.join(root, "lib"));
  var r = identity.assess();
  assert.equal(r.state, "inconclusive");
  assert.equal(r.reason, "no-loaded-sha");
});

function captureStderr(fn) {
  var lines = [];
  var orig = console.error;
  console.error = function (m) { lines.push(String(m)); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

test("an unexpected read failure is journaled with the path and is inconclusive with a reason", function () {
  var root = makePackage({ "build-sha.json": '{"sha":"s1"}' });
  var identity = createBuildIdentity(path.join(root, "lib"));
  var shaFile = path.join(root, "lib", "build-sha.json");
  fs.rmSync(shaFile);
  fs.mkdirSync(shaFile); // reading a directory fails with EISDIR, not a missing file
  var verdict;
  var lines = captureStderr(function () { verdict = identity.assess(); });
  assert.equal(verdict.state, "inconclusive");
  assert.equal(verdict.reason, "no-installed-sha");
  assert.ok(verdict.detail.indexOf(shaFile) !== -1, verdict.detail);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].indexOf(shaFile) !== -1, lines[0]);
});

test("a missing or half-written build-sha.json is expected: inconclusive, nothing journaled", function () {
  var root = makePackage({ "build-sha.json": '{"sha":"s1"}' });
  var identity = createBuildIdentity(path.join(root, "lib"));
  var shaFile = path.join(root, "lib", "build-sha.json");
  var lines = captureStderr(function () {
    fs.writeFileSync(shaFile, '{"sha":');
    assert.equal(identity.assess().reason, "no-installed-sha");
    fs.rmSync(shaFile);
    assert.equal(identity.assess().reason, "no-installed-sha");
  });
  assert.deepEqual(lines, []);
});

test("the hash is null while the tree cannot be read (an install in progress)", function () {
  var root = makePackage({ "a.js": "one" });
  var hasher = createTreeHasher(root);
  assert.equal(typeof hasher.hash(), "string");
  fs.rmSync(path.join(root, "lib"), { recursive: true });
  assert.equal(hasher.hash(), null);
});

test("a same-size in-place rewrite with the mtime restored is re-hashed, not served from the cache", function () {
  var root = makePackage({ "a.js": "one", "b.js": "two" });
  var file = path.join(root, "lib", "b.js");
  var pinned = new Date("2024-01-02T03:04:05.000Z"); // whole seconds survive utimes exactly
  fs.utimesSync(file, pinned, pinned);
  var hasher = createTreeHasher(root);
  var first = hasher.hash();
  var before = fs.statSync(file);
  // File timestamps tick coarsely; let one pass so the rewrite gets its own ctime.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  fs.writeFileSync(file, "TWO"); // same size, same inode
  fs.utimesSync(file, pinned, pinned); // the mtime a tool would restore
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs, "this case needs the restored mtime to match");
  assert.equal(fs.statSync(file).ino, before.ino, "and the inode to be unchanged");
  assert.notEqual(hasher.hash(), first);
});

test("the hasher re-reads only files whose stat changed", function () {
  var root = makePackage({ "a.js": "one", "b.js": "two" });
  var hasher = createTreeHasher(root);
  var first = hasher.hash();
  assert.equal(hasher.hash(), first, "unchanged tree, same hash");
  fs.writeFileSync(path.join(root, "lib", "b.js"), "twice");
  assert.notEqual(hasher.hash(), first, "a changed file changes the hash");
  fs.writeFileSync(path.join(root, "lib", "b.js"), "two");
  assert.equal(hasher.hash(), first, "restoring the bytes restores the hash");
});
