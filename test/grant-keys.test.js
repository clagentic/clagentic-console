"use strict";
// What "Allow for Session" grants, and what a later call is matched against
// (lib/grant-keys.js). A grant covers the calls that map to its key and nothing
// else; a call with no narrow key cannot be granted for the session at all.

var test = require("node:test");
var assert = require("node:assert/strict");
var grantKeys = require("../lib/grant-keys");
var utils = require("../lib/utils");

var key = grantKeys.permissionGrantKey;

function bash(command) { return key("Bash", { command: command }); }

test("a Bash grant is the exact command line, whatever the command is", function () {
  [
    "find . -print", "  find . -type f ", "git status --short", "npm test", "ls; rm -rf x", "ls && rm x", "ls | sh",
    "cat a > b", "echo $(rm x)", "echo `rm x`", "ls\nrm x", "FOO=1 ls", "/bin/bash -c x", "sudo rm x", "git -C repo status",
  ].forEach(function (cmd) {
    assert.equal(bash(cmd), "Bash=" + cmd, JSON.stringify(cmd));
  });
});

test("the Bash key is the command byte for byte: no trim, collapse or normalization", function () {
  var NBSP = " ";
  ["ls ", " ls", "ls\t", "ls\n", "ls" + NBSP, NBSP + "ls", "ls  -l", "é", "é", "LS"].forEach(function (cmd) {
    assert.equal(bash(cmd), "Bash=" + cmd, JSON.stringify(cmd));
  });
  assert.notEqual(bash("é"), bash("é"), "canonically equivalent strings stay distinct");
});

test("a grant never covers the same command with or without trailing whitespace, either way round", function () {
  var NBSP = " ";
  var pairs = [["find . -print" + NBSP, "find . -print"], ["ls ", "ls"], ["ls", "ls "], ["ls", "ls" + NBSP], ["ls\n", "ls"]];
  pairs.forEach(function (p) {
    var map = {};
    map[bash(p[0])] = true;
    assert.equal(grantKeys.isGranted(map, "Bash", { command: p[0] }), true, "the granted line repeats: " + JSON.stringify(p[0]));
    assert.equal(grantKeys.isGranted(map, "Bash", { command: p[1] }), false, JSON.stringify(p[0]) + " does not cover " + JSON.stringify(p[1]));
  });
});

test("a grant from find . -print covers that line only, not find . '-delete', find . -print -delete or rm", function () {
  var map = {};
  map[bash("find . -print")] = true;
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "find . -print" }), true, "the exact line repeats");
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "  find . -print  " }), false, "surrounding whitespace is a different line");
  [
    "find . '-delete'", "find . \"-delete\"", "find . -print -delete", "find . -name x", "find .", "rm -rf x",
    "find . -print; rm x", "find . -print && rm x", "findx . -print",
  ].forEach(function (cmd) {
    assert.equal(grantKeys.isGranted(map, "Bash", { command: cmd }), false, cmd);
  });
});

test("a grant from one line never covers a longer line, a shorter one or a compound that contains it", function () {
  var map = {};
  map[bash("git status")] = true;
  ["git status --short", "git push", "/usr/bin/git status", "git status; rm x", "git status && rm x", "git", "git -C repo status"].forEach(function (cmd) {
    assert.equal(grantKeys.isGranted(map, "Bash", { command: cmd }), false, cmd);
  });
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "git status" }), true);
});

test("a Bash call with no command, or a line too long to keep, cannot be granted", function () {
  assert.equal(key("Bash", {}), null);
  assert.equal(key("Bash", null), null);
  assert.equal(key("Bash", { command: "" }), null);
  assert.equal(key("Bash", { command: 5 }), null);
  assert.equal(key("Bash", { command: "ls; " + "x".repeat(400) }), null);
  assert.equal(grantKeys.grantScopeText("Bash", { command: "ls; " + "x".repeat(400) }), null, "its card offers no Allow for Session");
});

var FILE_CALLS = [
  ["Write", { file_path: "/work/proj/src/a.js" }],
  ["Edit", { file_path: "/work/proj/src/a.js" }],
  ["MultiEdit", { file_path: "/work/proj/src/a.js" }],
  ["NotebookEdit", { notebook_path: "/work/n/x.ipynb" }],
  ["Edit", { changes: "update /work/a.txt" }],
  ["Write", {}],
  ["Write", { file_path: "relative/x" }],
];

test("a file-tool call has no key and no scope sentence: it is answered per call", function () {
  FILE_CALLS.forEach(function (c) {
    assert.equal(key(c[0], c[1]), null, c[0] + " " + JSON.stringify(c[1]));
    assert.equal(grantKeys.grantScopeText(c[0], c[1]), null);
  });
  assert.equal(grantKeys.isFileTool("Write"), true);
  assert.equal(grantKeys.isFileTool("Bash"), false);
});

test("a retired key is never a grant, whatever its value, and nothing under it is honoured", function () {
  ["Write:/a", "Edit:/a", "MultiEdit:/a", "NotebookEdit:/a", "Write=/a", "Bash:find", "Bash:git status", "Bash:ls"].forEach(function (k) {
    assert.equal(grantKeys.isGrantValue(k, true), false, k);
    assert.equal(grantKeys.isGrantValue(k, "/real/a"), false, k);
  });
  FILE_CALLS.forEach(function (c) {
    var map = { "Write:/work/proj/src/a.js": true, "Edit:/work/proj/src/a.js": "/work/proj/src/a.js" };
    assert.equal(grantKeys.isGranted(map, c[0], c[1]), false);
  });
  ["find . -print", "find . '-delete'", "rm x", "git status"].forEach(function (cmd) {
    assert.equal(grantKeys.isGranted({ "Bash:find": true, "Bash:git status": true, "Bash:rm": true }, "Bash", { command: cmd }), false, cmd);
  });
});

test("a grant value is only ever true", function () {
  assert.equal(grantKeys.isGrantValue("Bash=ls", "/real/a"), false);
  assert.equal(grantKeys.isGrantValue("Bash=ls", true), true);
  assert.equal(grantKeys.isGrantValue("Bash", true), true, "legacy whole-tool");
  assert.equal(grantKeys.isGrantValue("Write", true), true, "legacy whole-tool");
  assert.equal(grantKeys.isGrantValue("Write", "/real/a"), false);
  assert.equal(grantKeys.isGrantValue("Write", ""), false);
});

test("other tools keep the tool name, a skill keeps its own name, MCP tools are distinct", function () {
  assert.equal(key("Skill", { skill: "claude-api" }), "Skill:claude-api");
  assert.equal(key("Skill", {}), "Skill");
  assert.equal(key("mcp__browser__navigate", { url: "x" }), "mcp__browser__navigate");
  assert.equal(grantKeys.isGranted({ "mcp__browser__navigate": true }, "mcp__browser__screenshot", {}), false);
  assert.equal(grantKeys.isGranted({ "Skill:a": true }, "Skill", { skill: "b" }), false);
  assert.equal(grantKeys.isGranted({ "Skill:a": true }, "Skill", { skill: "a" }), true);
});

test("a whole-tool grant from before scoping still covers its tool and is described as whole-tool", function () {
  ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Skill"].forEach(function (tool) {
    var input = tool === "Bash" ? { command: "rm x" } : tool === "Skill" ? { skill: "any" } : { file_path: "/anywhere/x" };
    assert.equal(grantKeys.isGranted({ [tool]: true }, tool, input), true, tool + " stays readable and in force");
    var d = grantKeys.describeGrantKey(tool);
    assert.equal(d.wholeTool, true);
    assert.match(d.text, /whole-tool/);
  });
  // A whole-tool Bash grant is not a Write grant.
  assert.equal(grantKeys.isGranted({ Bash: true }, "Write", { file_path: "/x/y" }), false);
  // Only a boolean true is a grant.
  assert.equal(grantKeys.isGranted({ Bash: "yes" }, "Bash", { command: "ls" }), false);
  assert.equal(grantKeys.isGranted(undefined, "Bash", { command: "ls" }), false);
});

test("the scope sentence names exactly what the click grants", function () {
  assert.equal(grantKeys.grantScopeText("Bash", { command: "find . -name x" }), "Allow only this exact command in this session");
  assert.equal(grantKeys.grantScopeText("Bash", { command: "a; b" }), "Allow only this exact command in this session");
  assert.equal(grantKeys.grantScopeText("Skill", { skill: "x" }), "Allow the x skill in this session");
  assert.equal(grantKeys.grantScopeText("mcp__a__b", {}), "Allow every mcp__a__b call in this session");
});

test("a stored key is described for the operator", function () {
  assert.deepEqual(grantKeys.describeGrantKey("Bash=ls -l"), { key: "Bash=ls -l", tool: "Bash", wholeTool: false, text: "Bash: exactly this command: ls -l" });
  assert.equal(grantKeys.describeGrantKey("Bash=ls; rm x").text, "Bash: exactly this command: ls; rm x");
});

test("the persisted grant record is bounded: a grant that does not fit is refused, one already held is not", function () {
  var map = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS; i++) map["Bash=p" + i] = true;
  assert.equal(grantKeys.fitsBudget(map, "Bash=another"), false, "no room for another");
  assert.equal(grantKeys.fitsBudget(map, "Bash=p3"), true, "an existing grant is no new one");
  assert.equal(grantKeys.fitsBudget({}, "Bash=ls"), true);
});

test("a persisted map is sanitized to boolean true, bounded keys and at most MAX_GRANTS entries", function () {
  var raw = { "Bash=find . -print": true, Bash: "yes", ["Bash=" + "d".repeat(200)]: true };
  var out = utils.sanitizeAllowedTools(raw);
  assert.deepEqual(Object.keys(out), ["Bash=find . -print"]);
  var many = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS + 10; i++) many["Bash=p" + i] = true;
  assert.equal(Object.keys(utils.sanitizeAllowedTools(many)).length, grantKeys.MAX_GRANTS);
});

test("persisted file-tool keys and Bash prefix keys are dropped on load; the legacy whole-tool grants stay", function () {
  var out = utils.sanitizeAllowedTools({
    "Write:/a/b": true, "Write:/a/b ": "/real/b", "Edit:/c": true, "MultiEdit:/c": "x", "NotebookEdit:/n": true, "Write=/d": true,
    "Bash:find": true, "Bash:git status": true, "Bash:ls": true,
    Write: true, Edit: "/real", Bash: true, "Bash=ls": true,
  });
  assert.deepEqual(Object.keys(out).sort(), ["Bash", "Bash=ls", "Write"]);
});
