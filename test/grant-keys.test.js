"use strict";
// What "Allow for Session" grants, and what a later call is matched against
// (lib/grant-keys.js): the whole tool, for file tools and Bash alike; a skill
// is the one tool whose grant is per name.

var test = require("node:test");
var assert = require("node:assert/strict");
var grantKeys = require("../lib/grant-keys");
var utils = require("../lib/utils");

var key = grantKeys.permissionGrantKey;

test("every tool is granted by its own name, whatever the call does", function () {
  [
    ["Write", { file_path: "/work/proj/src/a.js" }],
    ["Edit", { file_path: "/work/proj/src/a.js" }],
    ["MultiEdit", { file_path: "/work/proj/src/a.js" }],
    ["NotebookEdit", { notebook_path: "/work/n/x.ipynb" }],
    ["Edit", { changes: "update /work/a.txt" }],
    ["Write", {}],
    ["Bash", { command: "find . -print" }],
    ["Bash", { command: "ls; " + "x".repeat(400) }],
    ["Bash", {}],
    ["Bash", null],
    ["mcp__browser__navigate", { url: "x" }],
  ].forEach(function (c) {
    assert.equal(key(c[0], c[1]), c[0], c[0] + " " + JSON.stringify(c[1]));
  });
});

test("a Bash grant from a find prompt covers a later rm; a file-tool grant covers any path", function () {
  var map = {};
  map[key("Bash", { command: "find . -print" })] = true;
  map[key("Write", { file_path: "/a/b" })] = true;
  assert.equal(grantKeys.permissionGrantKey("Bash", { command: "rm -rf x" }) in map, true);
  assert.equal(grantKeys.permissionGrantKey("Write", { file_path: "/elsewhere/c" }) in map, true);
  assert.equal(grantKeys.permissionGrantKey("Edit", { file_path: "/a/b" }) in map, false, "Write does not grant Edit");
});

test("a skill keeps its own name, MCP tools are distinct", function () {
  assert.equal(key("Skill", { skill: "claude-api" }), "Skill:claude-api");
  assert.equal(key("Skill", {}), "Skill");
  assert.notEqual(key("mcp__browser__navigate", {}), key("mcp__browser__screenshot", {}));
});

test("a grant value is only ever true", function () {
  assert.equal(grantKeys.isGrantValue("Bash", true), true);
  assert.equal(grantKeys.isGrantValue("Write", true), true);
  assert.equal(grantKeys.isGrantValue("Write", "/real/a"), false);
  assert.equal(grantKeys.isGrantValue("Write", ""), false);
  assert.equal(grantKeys.isGrantValue("Bash", "yes"), false);
});

test("a stored key is described for the operator: a tool is whole-tool, a skill is not", function () {
  ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].forEach(function (tool) {
    var d = grantKeys.describeGrantKey(tool);
    assert.equal(d.key, tool);
    assert.equal(d.wholeTool, true);
    assert.match(d.text, /whole-tool/);
  });
  assert.deepEqual(grantKeys.describeGrantKey("Skill:x"), { key: "Skill:x", tool: "Skill", wholeTool: false, text: "Skill x" });
});

test("a persisted map keeps boolean true entries of any shape pre-scoping builds accepted", function () {
  var out = utils.sanitizeAllowedTools({
    Write: true, Edit: true, MultiEdit: true, NotebookEdit: true, Bash: true, "Skill:a": true,
    Read: "yes", Glob: 1,
  });
  assert.deepEqual(Object.keys(out).sort(), ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Skill:a", "Write"]);
  var many = {};
  for (var i = 0; i < 40; i++) many["mcp__s__t" + i] = true;
  assert.equal(Object.keys(utils.sanitizeAllowedTools(many)).length, 40, "no cap on the number of grants");
  assert.equal(Object.keys(utils.sanitizeAllowedTools({ ["mcp__" + "d".repeat(200)]: true })).length, 1, "no cap on key length");
});

test("persisted older-session shapes load as written", function () {
  assert.deepEqual(Object.keys(utils.sanitizeAllowedTools({ Write: true })), ["Write"]);
  assert.deepEqual(Object.keys(utils.sanitizeAllowedTools({ Bash: true })), ["Bash"]);
  assert.deepEqual(Object.keys(utils.sanitizeAllowedTools({ Write: true, Bash: true })).sort(), ["Bash", "Write"]);
});

test("exact-command Bash keys written by #451-era builds are dropped on load", function () {
  var out = utils.sanitizeAllowedTools({ "Bash=find . -print": true, "Bash=git push origin": true, Bash: true });
  assert.deepEqual(Object.keys(out), ["Bash"]);
  assert.equal(grantKeys.isGrantValue("Bash=ls", true), false);
});
