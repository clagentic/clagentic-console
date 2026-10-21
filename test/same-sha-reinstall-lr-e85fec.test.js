"use strict";

// A reinstall of the build that is already running must not offer a restart.
// Fixtures only: nothing here touches a real global install.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createBuildIdentity, createTreeHasher } = require("../lib/build-identity");
var { createBuildMonitor } = require("../lib/build-monitor");
var { installedMatchesTree, shouldSkipInstall } = require("../scripts/install-local-test");

function makePackage(sha, writtenAt) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "same-sha-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(root, "lib", "a.js"), "one");
  fs.writeFileSync(path.join(root, "lib", "build-sha.json"), JSON.stringify({ sha: sha, writtenAt: writtenAt }, null, 2) + "\n");
  return root;
}

// What prepack does on a second pack of the same commit: same sha, new timestamp.
function repack(root, sha, writtenAt) {
  fs.writeFileSync(path.join(root, "lib", "build-sha.json"), JSON.stringify({ sha: sha, writtenAt: writtenAt }, null, 2) + "\n");
}

function polls(identity, n) {
  var lines = [];
  var monitor = createBuildMonitor({ assess: identity.assess, log: function (l) { lines.push(l); } });
  for (var i = 0; i < n; i++) monitor.check();
  return { monitor: monitor, lines: lines };
}

test("a same-sha repack that only moves writtenAt is adopted and offers nothing", function () {
  var root = makePackage("s1", "2026-10-20T10:00:00.000Z");
  var identity = createBuildIdentity(path.join(root, "lib"));
  repack(root, "s1", "2026-10-20T11:30:00.000Z");
  var r = polls(identity, 3);
  assert.equal(identity.assess().state, "adopted");
  assert.equal(r.monitor.confirmedStale(), null);
});

test("same sha with genuinely different files is journaled and never confirmed stale", function () {
  var root = makePackage("s1", "t");
  var identity = createBuildIdentity(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "a.js"), "changed");
  var r = polls(identity, 4);
  assert.equal(r.monitor.confirmedStale(), null);
  assert.equal(r.lines.length, 1, "journaled once, not every poll");
  assert.match(r.lines[0], /same-sha-content-differs/);
  assert.doesNotMatch(r.lines.join("\n"), /STALE code/);
});

test("a different installed sha is still stale and offered", function () {
  var root = makePackage("s1", "t");
  var identity = createBuildIdentity(path.join(root, "lib"));
  repack(root, "s2", "t2");
  var r = polls(identity, 2);
  var offer = r.monitor.confirmedStale();
  assert.equal(offer.state, "stale");
  assert.equal(offer.installedBuildSha, "s2");
});

test("the tree hash ignores build-sha.json and nothing else under lib", function () {
  var root = makePackage("s1", "t");
  var hasher = createTreeHasher(root);
  var first = hasher.hash();
  repack(root, "s9", "other");
  assert.equal(hasher.hash(), first);
  // Replace the file the way an install does (new inode). An in-place rewrite
  // of the same size within one filesystem timestamp tick keeps the cache key
  // and is a documented limit of the hasher, so it cannot be asserted here.
  var replacement = path.join(root, "lib", "a.js.new");
  fs.writeFileSync(replacement, "two");
  fs.renameSync(replacement, path.join(root, "lib", "a.js"));
  assert.notEqual(hasher.hash(), first);
});

test("install skip: same sha and same files skips", function () {
  assert.equal(installedMatchesTree(function () { return { headSha: "s", installedSha: "s", repoHash: "h", installedHash: "h" }; }), true);
});

test("install skip: any difference or unknown installs", function () {
  [
    { headSha: "s", installedSha: "t", repoHash: "h", installedHash: "h" },
    { headSha: "s", installedSha: "s", repoHash: "h", installedHash: "g" },
    { headSha: "s", installedSha: "s", repoHash: null, installedHash: null },
    { headSha: "s", installedSha: null, repoHash: "h", installedHash: "h" },
    { headSha: null, installedSha: null, repoHash: "h", installedHash: "h" },
  ].forEach(function (state) {
    assert.equal(installedMatchesTree(function () { return state; }), false, JSON.stringify(state));
  });
});

test("install skip: a failed comparison installs instead of throwing", function () {
  var lines = [];
  var orig = console.log;
  console.log = function (m) { lines.push(String(m)); };
  var skip;
  try { skip = shouldSkipInstall(function () { throw new Error("nothing installed"); }); } finally { console.log = orig; }
  assert.equal(skip, false);
  assert.match(lines[0], /installing/);
});
