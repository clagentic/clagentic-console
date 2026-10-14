"use strict";

// Shutdown must stop the worktree rescan timers before it tears the projects
// down, and a rescan that still fires must do nothing. Before this, a rescan
// ran after every project was destroyed and re-added worktrees (and created
// adapters for them) inside the shutdown's force-exit window.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var daemonProjects = require("../lib/daemon-projects");

function git(cwd, args) {
  return execFileSync("git", args, { cwd: cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepoWithWorktree(root) {
  var repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
  git(repo, ["worktree", "add", "-q", path.join(repo, "wt-one"), "-b", "wt-one"]);
  return repo;
}

function fakeRelay() {
  var calls = [];
  return {
    calls: calls,
    addProject: function (p, slug) { calls.push("add:" + slug); },
    removeProject: function (slug) { calls.push("remove:" + slug); },
    broadcastAll: function () { calls.push("broadcast"); },
    getProjects: function () { return []; },
  };
}

test("a rescan after shutdown begins adds nothing; before it, the same rescan does", { timeout: 60000 }, function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-rescan-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setInterval"] });

  var repo = makeRepoWithWorktree(root);
  var relay = fakeRelay();
  daemonProjects.scanAndRegisterWorktrees(relay, repo, "proj", null, null);
  assert.deepEqual(relay.calls, ["add:proj--wt-one"], "the startup scan registers the existing worktree");

  // Control: while the daemon is running, a new worktree is picked up by the timer.
  git(repo, ["worktree", "add", "-q", path.join(repo, "wt-two"), "-b", "wt-two"]);
  t.mock.timers.tick(10000);
  assert.ok(relay.calls.indexOf("add:proj--wt-two") !== -1, "the timer rescan registers a new worktree while running");

  // Shutdown begins: clear the timers, then a worktree appears and every timer would have fired.
  daemonProjects.stopWorktreeRescans();
  var before = relay.calls.length;
  git(repo, ["worktree", "add", "-q", path.join(repo, "wt-three"), "-b", "wt-three"]);
  t.mock.timers.tick(60000);
  assert.equal(relay.calls.length, before, "no timer fires after shutdown begins");

  // A rescan already in flight (called directly, not through a timer) is inert too.
  daemonProjects.rescanWorktrees(relay, repo, "proj", null, null);
  assert.equal(relay.calls.length, before, "a rescan invoked during shutdown does nothing");

  // And so is a late registration of a project's worktrees.
  daemonProjects.scanAndRegisterWorktrees(relay, repo, "proj-late", null, null);
  assert.equal(relay.calls.length, before, "no worktree is registered once shutdown has begun");
});
