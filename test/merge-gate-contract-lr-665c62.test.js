// Merge-gate contract: the tracked gate.yaml, read by loadout from the PR base
// commit, must require the `test` check by name. Pins the file contract only;
// the pass/refuse judgment belongs to loadout, whose installed result for the
// captured payloads is committed as transcripts beside the fixtures.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var root = path.join(__dirname, "..");
var fixtures = path.join(__dirname, "fixtures", "merge-gate-lr-665c62");

// js-yaml is not a dependency of this repo, so the files are read as text. The
// gate files are flat: a `merge:` block holding scalar lists, which this reads
// by key. Comment lines are dropped first so prose naming a key cannot match.
function uncommented(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8")
    .split("\n")
    .filter(function (l) { return !/^\s*#/.test(l); })
    .join("\n");
}

function hasKey(text, key) {
  return new RegExp("^\\s+" + key + ":", "m").test(text);
}

function listUnder(text, key) {
  var m = new RegExp("^\\s+" + key + ":\\s*\\n((?:\\s+-\\s+\\S+\\n?)+)", "m").exec(text);
  if (!m) return null;
  return m[1].split("\n").filter(Boolean).map(function (l) { return l.replace(/^\s+-\s+/, "").trim(); });
}

test("gate.yaml parses and requires the test check by name", function () {
  var gate = uncommented(".clagentic/loadout/gate.yaml");
  assert.match(gate, /^merge:\s*$/m, "gate.yaml has a merge block");
  assert.ok(listUnder(gate, "required_ci_checks").includes("test"));
});

test("gate.yaml requires reviewer and security roles", function () {
  var gate = uncommented(".clagentic/loadout/gate.yaml");
  assert.deepEqual(listUnder(gate, "required_reviewer_roles"), ["reviewer", "security"]);
});

test("config.yaml no longer carries required_reviewer_roles", function () {
  var cfg = uncommented(".clagentic/loadout/config.yaml");
  assert.equal(hasKey(cfg, "required_reviewer_roles"), false);
});

test("captured PR 417 head 0d74b15 has only skipped test check-runs", function () {
  var body = JSON.parse(fs.readFileSync(path.join(fixtures, "check-runs-pr417-head-0d74b15.json"), "utf8"));
  var runs = body.check_runs.filter(function (r) { return r.name === "test"; });
  assert.ok(runs.length > 0, "fixture has test check-runs");
  runs.forEach(function (r) { assert.equal(r.conclusion, "skipped"); });
});
