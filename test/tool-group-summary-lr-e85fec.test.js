"use strict";

// The tool-group header counts a group by the sub-agent dispatch name set
// (Task and Agent), so a group holding only "Agent" calls must not render an
// undefined count.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var backend = require("../lib/agent-dispatch-tool");

// tools.js is a browser module that cannot be imported under node, so the
// function under test is cut out of the source and given the real name-set helper.
function loadSummary() {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "tools.js"), "utf8");
  var start = src.indexOf("function toolGroupSummary(");
  var end = src.indexOf("function updateToolGroupHeader(");
  assert.ok(start >= 0 && end > start, "toolGroupSummary must be locatable in tools.js");
  var factory = new Function("isAgentDispatchTool", src.slice(start, end) + "\nreturn toolGroupSummary;");
  return factory(backend.isAgentDispatchTool);
}

function group(names, done) {
  return { toolNames: names, doneCount: done ? names.length : 0 };
}

test("an Agent-only group is counted, finished and running", function () {
  var summary = loadSummary();
  assert.equal(summary(group(["Agent", "Agent"], true)), "Ran 2 tasks");
  assert.equal(summary(group(["Agent"], false)), "Running 1 task...");
});

test("a Task-only group is counted", function () {
  var summary = loadSummary();
  assert.equal(summary(group(["Task", "Task", "Task"], true)), "Ran 3 tasks");
});

test("a mixed Task and Agent group is one kind with the summed count", function () {
  var summary = loadSummary();
  assert.equal(summary(group(["Task", "Agent", "Agent"], true)), "Ran 3 tasks");
  assert.equal(summary(group(["Task", "Agent"], false)), "Running 2 tasks...");
});

test("a group that mixes dispatch with another tool stays a generic count", function () {
  var summary = loadSummary();
  assert.equal(summary(group(["Agent", "Bash"], true)), "Ran 2 tools");
});

test("no summary renders an undefined count", function () {
  var summary = loadSummary();
  [["Agent"], ["Task"], ["Agent", "Task"], ["Read", "Read"], ["Bash"]].forEach(function (names) {
    assert.doesNotMatch(summary(group(names, true)), /undefined/);
    assert.doesNotMatch(summary(group(names, false)), /undefined/);
  });
});
