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

test("a Bash grant is the command's first word, so a different program is not covered", function () {
  assert.equal(bash("find /var/tmp -name x"), "Bash:find");
  assert.equal(bash("  find . -type f "), "Bash:find");
  var map = { "Bash:find": true };
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "find . -name y" }), true);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "rm -rf /tmp/x" }), false);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "findx ." }), false, "a longer word is not the same program");
});

test("a program with subcommands is granted per subcommand", function () {
  assert.equal(bash("git status --short"), "Bash:git status");
  assert.equal(bash("npm test"), "Bash:npm test");
  var map = { "Bash:git status": true };
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "git status" }), true);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "git push --force" }), false);
  // A global option before the subcommand makes the line its own exact key.
  assert.equal(bash("git -c core.pager=x log"), "Bash=git -c core.pager=x log");
});

test("a compound or redirecting line is granted only as that exact line", function () {
  ["ls; rm -rf x", "ls && rm x", "ls | sh", "cat a > b", "echo $(rm x)", "echo `rm x`", "ls\nrm x", "ls & rm x", "echo ${HOME}", "ls \\\nrm"].forEach(function (cmd) {
    assert.equal(bash(cmd), "Bash=" + cmd, JSON.stringify(cmd));
  });
  var map = {};
  map[bash("ls; rm -rf x")] = true;
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "ls; rm -rf x" }), true);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "ls; rm -rf y" }), false);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "ls" }), false);
});

test("a program that runs other programs is never granted by prefix", function () {
  ["sudo rm x", "env FOO=1 ls", "bash -c ls", "sh x.sh", "xargs rm", "ssh host ls", "python3 x.py", "node x.js", "npx thing", "eval ls", "timeout 5 ls"].forEach(function (cmd) {
    assert.equal(bash(cmd), "Bash=" + cmd, cmd);
  });
  assert.equal(bash("FOO=1 ls"), "Bash=FOO=1 ls", "a leading assignment is not a plain command word");
});

test("a path, a wrapper or an assignment in front is never a prefix grant: the exact line is the key", function () {
  [
    "/bin/bash -c x", "/usr/bin/env x", "/usr/bin/sudo rm x", "./run.sh", "../bin/tool a", "sudo x", "doas x", "su root",
    "git -C repo status", "git --no-pager log", "npm --prefix x test", "FOO=1 ls", "FOO=1 git status",
    "busybox sh", "uvx tool", "pipx run x", "python x.py", "python3.12 x.py", "(ls)", "ls $(id)", "ls > out", "ls < in",
    "ls <(id)", "a || b", "a && b", "a ; b", "a | b", "a &", "a\nb", "ssh h x", "env x", "xargs x", "nohup x", "exec x", "eval x",
  ].forEach(function (cmd) {
    assert.equal(bash(cmd), "Bash=" + cmd, JSON.stringify(cmd));
  });
  assert.equal(bash("git status"), "Bash:git status");
  assert.equal(bash("find . -name x"), "Bash:find");
});

test("a later call outside the derived scope prompts", function () {
  var map = {};
  map[bash("git status")] = true;
  ["git -C repo status", "git push", "/usr/bin/git status", "git status; rm x", "git status && rm x"].forEach(function (cmd) {
    // The only call these could share a key with is their own exact line.
    assert.equal(grantKeys.isGranted(map, "Bash", { command: cmd }), false, cmd);
  });
  var exactMap = {};
  exactMap[bash("/bin/bash -c x")] = true;
  assert.equal(grantKeys.isGranted(exactMap, "Bash", { command: "/bin/bash -c x" }), true, "the exact line repeats");
  assert.equal(grantKeys.isGranted(exactMap, "Bash", { command: "/bin/bash -c y" }), false);
  assert.equal(grantKeys.isGranted(exactMap, "Bash", { command: "bash -c x" }), false);
});

test("find with a flag that acts is its own exact line, so a find grant does not cover it", function () {
  assert.equal(bash("find . -delete"), "Bash=find . -delete");
  assert.equal(bash("find . -exec rm {} ;"), "Bash=find . -exec rm {} ;");
  var map = { "Bash:find": true };
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "find . -delete" }), false);
  assert.equal(grantKeys.isGranted(map, "Bash", { command: "find . -name a" }), true);
});

test("a Bash call with no command, or a line too long to keep, cannot be granted", function () {
  assert.equal(key("Bash", {}), null);
  assert.equal(key("Bash", null), null);
  assert.equal(key("Bash", { command: "   " }), null);
  assert.equal(key("Bash", { command: "ls; " + "x".repeat(400) }), null);
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

test("a file-scoped key is never a grant, whatever its value, and nothing under it is honoured", function () {
  ["Write:/a", "Edit:/a", "MultiEdit:/a", "NotebookEdit:/a", "Write=/a"].forEach(function (k) {
    assert.equal(grantKeys.isGrantValue(k, true), false, k);
    assert.equal(grantKeys.isGrantValue(k, "/real/a"), false, k);
  });
  FILE_CALLS.forEach(function (c) {
    var map = { "Write:/work/proj/src/a.js": true, "Edit:/work/proj/src/a.js": "/work/proj/src/a.js" };
    assert.equal(grantKeys.isGranted(map, c[0], c[1]), false);
  });
});

test("a grant value is only ever true", function () {
  assert.equal(grantKeys.isGrantValue("Bash:ls", "/real/a"), false);
  assert.equal(grantKeys.isGrantValue("Bash:ls", true), true);
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
  assert.equal(grantKeys.grantScopeText("Bash", { command: "find . -name x" }), "Allow Bash commands starting with find in this session");
  assert.equal(grantKeys.grantScopeText("Bash", { command: "git status" }), "Allow Bash commands starting with git status in this session");
  assert.equal(grantKeys.grantScopeText("Bash", { command: "a; b" }), "Allow only this exact command in this session");
  assert.equal(grantKeys.grantScopeText("Skill", { skill: "x" }), "Allow the x skill in this session");
  assert.equal(grantKeys.grantScopeText("mcp__a__b", {}), "Allow every mcp__a__b call in this session");
});

test("a stored key is described for the operator", function () {
  assert.deepEqual(grantKeys.describeGrantKey("Bash:find"), { key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" });
  assert.equal(grantKeys.describeGrantKey("Bash=ls; rm x").text, "Bash: exactly this command: ls; rm x");
});

test("the persisted grant record is bounded: a grant that does not fit is refused, one already held is not", function () {
  var map = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS; i++) map["Bash:p" + i] = true;
  assert.equal(grantKeys.fitsBudget(map, "Bash:another"), false, "no room for another");
  assert.equal(grantKeys.fitsBudget(map, "Bash:p3"), true, "an existing grant is no new one");
  assert.equal(grantKeys.fitsBudget({}, "Bash:ls"), true);
});

test("a persisted map is sanitized to boolean true, bounded keys and at most MAX_GRANTS entries", function () {
  var raw = { "Bash:find": true, Bash: "yes", ["Bash:" + "d".repeat(200)]: true };
  var out = utils.sanitizeAllowedTools(raw);
  assert.deepEqual(Object.keys(out), ["Bash:find"]);
  var many = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS + 10; i++) many["Bash:p" + i] = true;
  assert.equal(Object.keys(utils.sanitizeAllowedTools(many)).length, grantKeys.MAX_GRANTS);
});

test("persisted file-tool keys are dropped on load, in any form and with any value; the legacy whole-tool grant stays", function () {
  var out = utils.sanitizeAllowedTools({
    "Write:/a/b": true, "Write:/a/b ": "/real/b", "Edit:/c": true, "MultiEdit:/c": "x", "NotebookEdit:/n": true, "Write=/d": true,
    Write: true, Edit: "/real", "Bash:ls": true,
  });
  assert.deepEqual(Object.keys(out).sort(), ["Bash:ls", "Write"]);
});
