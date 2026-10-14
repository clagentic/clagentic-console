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

test("a file-writing grant is the file's directory: another directory, and a sibling tool, are not covered", function () {
  ["Write", "Edit", "MultiEdit"].forEach(function (tool) {
    assert.equal(key(tool, { file_path: "/work/proj/src/a.js" }), tool + ":/work/proj/src");
  });
  assert.equal(key("NotebookEdit", { notebook_path: "/work/n/x.ipynb" }), "NotebookEdit:/work/n");
  var map = { "Write:/work/proj/src": true };
  assert.equal(grantKeys.isGranted(map, "Write", { file_path: "/work/proj/src/b.js" }), true, "same directory, other file");
  assert.equal(grantKeys.isGranted(map, "Write", { file_path: "/work/proj/other/b.js" }), false, "another directory");
  assert.equal(grantKeys.isGranted(map, "Write", { file_path: "/work/proj/src/deep/b.js" }), false, "a subdirectory is another directory");
  assert.equal(grantKeys.isGranted(map, "Edit", { file_path: "/work/proj/src/b.js" }), false, "another tool");
});

test("dot segments are resolved before the directory is taken", function () {
  assert.equal(key("Write", { file_path: "/work/proj/src/../../etc/x" }), "Write:/work/etc");
  assert.equal(grantKeys.isGranted({ "Write:/work/proj": true }, "Write", { file_path: "/work/proj/../secret/x" }), false);
});

test("a path grant is decided on the resolved target: a symlink out, a dot-dot escape and a sibling prefix prompt", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var granted = pathMod.join(root, "b");
  var outside = pathMod.join(root, "out");
  fs.mkdirSync(granted);
  fs.mkdirSync(outside);
  fs.mkdirSync(pathMod.join(root, "bc"));
  fs.symlinkSync(outside, pathMod.join(granted, "dirlink"));
  fs.writeFileSync(pathMod.join(outside, "secret"), "x");
  fs.symlinkSync(pathMod.join(outside, "secret"), pathMod.join(granted, "filelink"));
  fs.symlinkSync(pathMod.join(root, "missing"), pathMod.join(granted, "dangling"));

  var map = {};
  map[key("Write", { file_path: pathMod.join(granted, "first.txt") })] = true;
  assert.deepEqual(Object.keys(map), ["Write:" + granted]);
  var covered = function (p) { return grantKeys.isGranted(map, "Write", { file_path: p }); };

  assert.equal(covered(pathMod.join(granted, "new.txt")), true, "a new file under the granted dir");
  assert.equal(covered(pathMod.join(granted, "existing-after.txt")), true);
  assert.equal(covered(pathMod.join(granted, "dirlink", "x.txt")), false, "through a directory symlink that leaves the dir");
  assert.equal(covered(pathMod.join(granted, "filelink")), false, "a file symlink that points outside");
  assert.equal(covered(pathMod.join(granted, "dangling")), false, "a dangling link has no safe target");
  assert.equal(covered(pathMod.join(granted, "..", "out", "x.txt")), false, "a dot-dot escape");
  assert.equal(covered(pathMod.join(root, "bc", "x.txt")), false, "a sibling whose name starts the same");
  assert.equal(key("Write", { file_path: pathMod.join(granted, "dangling") }), null);
});

test("a symlinked granted directory is granted by its real location", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(pathMod.join(root, "real"));
  fs.symlinkSync(pathMod.join(root, "real"), pathMod.join(root, "alias"));
  assert.equal(key("Write", { file_path: pathMod.join(root, "alias", "f") }), "Write:" + pathMod.join(root, "real"));
});

test("Codex's file change approval, which names path, is scoped the same way", function () {
  assert.equal(key("Edit", { changes: "update /work/a.txt", path: "/work/a.txt" }), "Edit:/work");
  assert.equal(key("Edit", { changes: "update /work/a.txt" }), null, "no path, nothing narrow to grant");
});

test("a write with no absolute path cannot be granted for the session", function () {
  assert.equal(key("Write", {}), null);
  assert.equal(key("Write", { file_path: "relative/x" }), null);
  assert.equal(key("Write", { file_path: "" }), null);
  assert.equal(key("Write", { file_path: 12 }), null);
  assert.equal(key("Write", { file_path: "/a\0b" }), null);
  assert.equal(grantKeys.grantScopeText("Write", {}), null);
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
  assert.equal(grantKeys.grantScopeText("Write", { file_path: "/work/p/a.js" }), "Allow Write on files directly in /work/p in this session");
  assert.equal(grantKeys.grantScopeText("Skill", { skill: "x" }), "Allow the x skill in this session");
  assert.equal(grantKeys.grantScopeText("mcp__a__b", {}), "Allow every mcp__a__b call in this session");
});

test("a stored key is described for the operator", function () {
  assert.deepEqual(grantKeys.describeGrantKey("Bash:find"), { key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" });
  assert.equal(grantKeys.describeGrantKey("Bash=ls; rm x").text, "Bash: exactly this command: ls; rm x");
  assert.equal(grantKeys.describeGrantKey("Write:/work/p").text, "Write on files directly in /work/p");
  assert.equal(grantKeys.describeGrantKey("Write:C:\\work").text, "Write on files directly in C:\\work", "a drive colon stays in the path");
});

test("the persisted grant record is bounded: a grant that does not fit is refused, one already held is not", function () {
  var map = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS; i++) map["Bash:p" + i] = true;
  assert.equal(grantKeys.fitsBudget(map, "Bash:another"), false, "no room for another");
  assert.equal(grantKeys.fitsBudget(map, "Bash:p3"), true, "an existing grant is no new one");
  assert.equal(grantKeys.fitsBudget({}, "Bash:ls"), true);
});

test("a persisted map is sanitized to boolean true, bounded keys and at most MAX_GRANTS entries", function () {
  var raw = { "Bash:find": true, Bash: "yes", ["Write:/" + "d".repeat(200)]: true };
  var out = utils.sanitizeAllowedTools(raw);
  assert.deepEqual(Object.keys(out), ["Bash:find"]);
  var many = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS + 10; i++) many["Bash:p" + i] = true;
  assert.equal(Object.keys(utils.sanitizeAllowedTools(many)).length, grantKeys.MAX_GRANTS);
});
