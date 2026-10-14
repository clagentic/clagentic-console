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
var PARENT_REF = /["'`]HEAD[~^]/;

test("no test asks the checkout for a parent commit", function () {
  var dir = __dirname;
  var offenders = fs.readdirSync(dir).filter(function (name) {
    if (!/\.test\.js$/.test(name) || OWN_REPO.has(name) || name === path.basename(__filename)) return false;
    return PARENT_REF.test(fs.readFileSync(path.join(dir, name), "utf8"));
  });
  assert.deepEqual(offenders, []);
});
