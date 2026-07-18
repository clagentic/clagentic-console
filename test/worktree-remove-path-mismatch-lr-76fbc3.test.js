// worktree-remove-path-mismatch-lr-76fbc3.test.js — regression tests for lr-76fbc3
//
// REGRESSION (post lr-fc2818, PR #348): lr-fc2818 correctly stopped daemon.js
// from claiming {ok:true} on a worktree removal it never actually performed —
// it now forwards removeWorktree()'s real result. That surfaced a pre-existing
// bug in lib/worktree.js's removeWorktree(): it reconstructed the worktree's
// path as path.join(parentPath, dirName), which is only correct when the
// worktree lives directly inside parentPath. A worktree registered elsewhere
// on disk (e.g. created by hand via `git worktree add ../sibling -b x`,
// discovered and registered by daemon-projects.js's scanAndRegisterWorktrees
// using wt.dirName = path.basename(wt.path)) has a basename that does not
// round-trip back to its real, git-registered path. removeWorktree() then
// handed git a path it never registered, and git failed with
// "not a valid working tree" / "is not a working tree" — the worktree stayed
// on disk while the operator saw a fast-dismissing error toast.
//
// Fix: removeWorktree() now resolves the actual registered path by matching
// `dirName` against `git worktree list --porcelain` output before falling
// back to the naive path.join.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var { createWorktree, removeWorktree, scanWorktrees } = require("../lib/worktree");

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

test("lr-76fbc3: removeWorktree removes a worktree registered directly inside the parent dir (baseline, unaffected)", function () {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr76fbc3-inside-"));
  var parent = path.join(tmpRoot, "parentproj");
  initRepo(parent);

  var branch = "feat/login";
  var dirName = branch.replace(/\//g, "-"); // mirrors the frontend's slash->dash derivation
  var createResult = createWorktree(parent, branch, dirName, "main");
  assert.strictEqual(createResult.ok, true, JSON.stringify(createResult));

  var removeResult = removeWorktree(parent, dirName);
  assert.strictEqual(removeResult.ok, true, "expected removal to succeed: " + JSON.stringify(removeResult));
  assert.strictEqual(fs.existsSync(createResult.path), false, "worktree directory must actually be gone from disk");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("lr-76fbc3: removeWorktree resolves and removes a worktree registered OUTSIDE the parent dir (the regression)", function () {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr76fbc3-outside-"));
  var parent = path.join(tmpRoot, "parentproj");
  initRepo(parent);

  // A worktree created by hand outside the parent directory -- e.g. a user
  // running `git worktree add ../sibling-wt -b feat/x` from the CLI, which
  // daemon-projects.js's scanAndRegisterWorktrees later discovers via
  // scanWorktrees() and registers with wt.dirName = path.basename(wt.path).
  var outsidePath = path.join(tmpRoot, "sibling-wt");
  execFileSync("git", ["worktree", "add", outsidePath, "-b", "feat/x"], { cwd: parent, stdio: "pipe" });
  assert.strictEqual(fs.existsSync(outsidePath), true);

  var scanned = scanWorktrees(parent);
  assert.strictEqual(scanned.length, 1);
  assert.strictEqual(scanned[0].accessible, false, "worktree outside parent must be flagged inaccessible, but still discoverable/removable");
  assert.strictEqual(scanned[0].dirName, "sibling-wt");

  // This is exactly what daemon.js's onRemoveProject passes to removeWorktree:
  // the recovered dirName from a "parentSlug--dirName" slug split.
  var removeResult = removeWorktree(parent, scanned[0].dirName);
  assert.strictEqual(removeResult.ok, true, "expected removal to succeed, not the pre-fix 'not a valid working tree' failure: " + JSON.stringify(removeResult));
  assert.strictEqual(fs.existsSync(outsidePath), false, "worktree directory must actually be gone from disk, proving this isn't a masked no-op");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("lr-76fbc3 (PEACHES PR #365 review): removeWorktree disambiguates same-basename worktrees under different parents, never removing the wrong one", function () {
  // Two independent parent repos, each with a worktree whose leaf dirName is
  // identical ("feat") but that live in different locations on disk -- e.g.
  // ./feat under parentA and ../sibling/feat under parentB. Matching on
  // basename alone (the pre-fix behavior) would silently remove whichever
  // entry sorted first in `git worktree list --porcelain`, regardless of
  // which parent the caller actually meant.
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr76fbc3-ambiguous-"));
  var parentA = path.join(tmpRoot, "parentA");
  var parentB = path.join(tmpRoot, "parentB");
  initRepo(parentA);
  initRepo(parentB);

  var createA = createWorktree(parentA, "feat", "feat", "main");
  assert.strictEqual(createA.ok, true, JSON.stringify(createA));
  var createB = createWorktree(parentB, "feat", "feat", "main");
  assert.strictEqual(createB.ok, true, JSON.stringify(createB));

  assert.strictEqual(fs.existsSync(createA.path), true);
  assert.strictEqual(fs.existsSync(createB.path), true);
  assert.notStrictEqual(path.resolve(createA.path), path.resolve(createB.path));

  // Remove the worktree bound to parentB. Only parentB's "feat" worktree may
  // be affected -- parentA's same-named worktree must survive untouched.
  var removeResult = removeWorktree(parentB, "feat");
  assert.strictEqual(removeResult.ok, true, "expected removal to succeed: " + JSON.stringify(removeResult));
  assert.strictEqual(fs.existsSync(createB.path), false, "parentB's worktree must actually be removed");
  assert.strictEqual(fs.existsSync(createA.path), true, "parentA's same-basename worktree must NOT be touched");

  // And the same holds in reverse for parentA's worktree.
  var removeResultA = removeWorktree(parentA, "feat");
  assert.strictEqual(removeResultA.ok, true, "expected removal to succeed: " + JSON.stringify(removeResultA));
  assert.strictEqual(fs.existsSync(createA.path), false, "parentA's worktree must now be removed too");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("lr-76fbc3: removeWorktree still surfaces a genuine failure as {ok:false,error} rather than swallowing it", function () {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr76fbc3-genuine-fail-"));
  var parent = path.join(tmpRoot, "parentproj");
  initRepo(parent);

  // No worktree named "does-not-exist" was ever created or registered --
  // resolveWorktreePath finds no match and falls back to the naive join,
  // which git correctly rejects. The real error must reach the caller.
  var removeResult = removeWorktree(parent, "does-not-exist");
  assert.strictEqual(removeResult.ok, false);
  assert.ok(removeResult.error, "a genuine failure must include an error message");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
