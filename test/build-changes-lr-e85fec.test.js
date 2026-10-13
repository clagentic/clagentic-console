"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var { listBuildChanges, resolveHistoryRepo } = require("../lib/build-changes");

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid"].concat(args), { cwd: cwd, encoding: "utf8" }).trim();
}

function makeRepo(subjects) {
  var repo = fs.mkdtempSync(path.join(os.tmpdir(), "build-changes-"));
  git(repo, ["init", "-q", "-b", "main"]);
  var shas = subjects.map(function (subject) {
    git(repo, ["commit", "-q", "--allow-empty", "-m", subject]);
    return git(repo, ["rev-parse", "HEAD"]);
  });
  return { repo: repo, shas: shas };
}

test("lists the commits between the running build and the installed one, newest first", async function () {
  var r = makeRepo(["running build", "fix the permission prompt", "add the update offer"]);
  var out = await listBuildChanges({ repo: r.repo, fromSha: r.shas[0], toSha: r.shas[2] });
  assert.equal(out.available, true);
  assert.deepEqual(out.commits.map(function (c) { return c.subject; }), ["add the update offer", "fix the permission prompt"]);
  assert.equal(out.truncated, false);
});

test("truncates a long range and says so", async function () {
  var subjects = ["base"];
  for (var i = 0; i < 6; i++) subjects.push("change " + i);
  var r = makeRepo(subjects);
  var out = await listBuildChanges({ repo: r.repo, fromSha: r.shas[0], toSha: r.shas[6], limit: 4 });
  assert.equal(out.commits.length, 4);
  assert.equal(out.truncated, true);
});

test("no repository means the list is unavailable, with a reason, not an empty list", async function () {
  var out = await listBuildChanges({ repo: null, fromSha: "a".repeat(40), toSha: "b".repeat(40) });
  assert.equal(out.available, false);
  assert.match(out.reason, /no git history/);
});

test("a sha git does not know is unavailable, not a crash", async function () {
  var r = makeRepo(["only"]);
  var out = await listBuildChanges({ repo: r.repo, fromSha: "a".repeat(40), toSha: r.shas[0] });
  assert.equal(out.available, false);
});

test("only hex revisions reach git, so a value cannot be read as an option", async function () {
  var called = false;
  var out = await listBuildChanges({
    repo: "/x", fromSha: "--output=/tmp/x", toSha: "b".repeat(40),
    execFileFn: function () { called = true; },
  });
  assert.equal(out.available, false);
  assert.equal(called, false);
});

test("a commit subject is bounded to one line", async function () {
  var r = makeRepo(["base", "x".repeat(400)]);
  var out = await listBuildChanges({ repo: r.repo, fromSha: r.shas[0], toSha: r.shas[1] });
  assert.ok(out.commits[0].subject.length <= 200);
});

test("resolveHistoryRepo: a configured absolute path wins, a checkout is used, an install has none", function () {
  var checkout = fs.mkdtempSync(path.join(os.tmpdir(), "build-changes-co-"));
  fs.mkdirSync(path.join(checkout, ".git"));
  var install = fs.mkdtempSync(path.join(os.tmpdir(), "build-changes-in-"));
  assert.equal(resolveHistoryRepo("/srv/src", install), "/srv/src");
  assert.equal(resolveHistoryRepo(undefined, checkout), checkout);
  assert.equal(resolveHistoryRepo(undefined, install), null);
  assert.equal(resolveHistoryRepo("relative/path", install), null, "a relative path is not a configured repository");
});
