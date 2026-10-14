"use strict";

// CI checks the repository out at depth 1, so a test that asks this checkout
// for a parent commit passes locally and fails there. Tests that need history
// build it in a repository of their own.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

// Files that read HEAD~ only inside a repository they create themselves.
var OWN_REPO = new Set(["project-filesystem-policy.test.js"]);
var PARENT_REF = /\bHEAD[~^]/;

// Comments may name the ref without running it.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function asksForParent(source) {
  return PARENT_REF.test(stripComments(source));
}

test("the parent-ref guard recognises every way a test can ask for one", function () {
  var cases = [
    ['execFileSync("git", ["diff", "HEAD~1"])', true],
    ["execFileSync('git', ['show', 'HEAD^'])", true],
    ['execSync("git rev-parse HEAD~1")', true],
    ['execSync("git log HEAD^..")', true],
    ["execSync(`git diff ${base} HEAD~2`)", true],
    ["var ref = `HEAD^`;", true],
    ['// compares against HEAD~1 in a comment\nvar x = 1;', false],
    ['/* HEAD^ named in a block comment */\nvar x = 1;', false],
    ['execSync("git rev-parse HEAD")', false],
    ['var s = "AHEAD~1";', false],
  ];
  cases.forEach(function (row) {
    assert.equal(asksForParent(row[0]), row[1], row[0]);
  });
});

test("no test asks the checkout for a parent commit", function () {
  var dir = __dirname;
  var offenders = fs.readdirSync(dir).filter(function (name) {
    if (!/\.test\.js$/.test(name) || OWN_REPO.has(name) || name === path.basename(__filename)) return false;
    return asksForParent(fs.readFileSync(path.join(dir, name), "utf8"));
  });
  assert.deepEqual(offenders, []);
});
