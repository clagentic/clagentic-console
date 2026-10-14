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

test("a file-writing grant is the exact requested path: a sibling, another directory and another tool are not covered", function () {
  ["Write", "Edit", "MultiEdit"].forEach(function (tool) {
    assert.equal(key(tool, { file_path: "/work/proj/src/a.js" }), tool + ":/work/proj/src/a.js");
  });
  assert.equal(key("NotebookEdit", { notebook_path: "/work/n/x.ipynb" }), "NotebookEdit:/work/n/x.ipynb");
});

test("a file grant covers that file only: a sibling, another directory and another tool prompt", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(pathMod.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(pathMod.join(root, "other"));
  ["src/a.js", "src/b.js", "other/a.js", "src/deep/a.js"].forEach(function (f) { fs.writeFileSync(pathMod.join(root, f), "x"); });
  var at = function (f) { return { file_path: pathMod.join(root, f) }; };
  var map = {};
  map[key("Write", at("src/a.js"))] = grantKeys.grantValue("Write", at("src/a.js"));
  assert.equal(grantKeys.isGranted(map, "Write", at("src/a.js")), true, "the same file");
  assert.equal(grantKeys.isGranted(map, "Write", at("src/b.js")), false, "a sibling file in the same directory");
  assert.equal(grantKeys.isGranted(map, "Write", at("src/new.js")), false, "a new file in the same directory");
  assert.equal(grantKeys.isGranted(map, "Write", at("other/a.js")), false, "another directory");
  assert.equal(grantKeys.isGranted(map, "Write", at("src/deep/a.js")), false, "a subdirectory");
  assert.equal(grantKeys.isGranted(map, "Edit", at("src/a.js")), false, "another tool");
});

test("the key is the path as written: it is never joined, resolved or normalised", function () {
  assert.equal(key("Write", { file_path: "/safe/link/../secret" }), "Write:/safe/link/../secret");
  assert.equal(key("Write", { file_path: "/safe//a/./b/" }), "Write:/safe//a/./b/");
  var map = { "Write:/safe/secret": "/safe/secret", "Write:/safe": "/safe" };
  assert.equal(grantKeys.isGranted(map, "Write", { file_path: "/safe/link/../secret" }), false, "link/.. does not collapse onto a granted name");
  assert.equal(grantKeys.isGranted(map, "Write", { file_path: "/safe/./secret" }), false, "another spelling of the same file prompts");
});

test("a path grant is bound to the file's realpath: a symlink swapped in after the grant prompts", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var target = pathMod.join(root, "target.txt");
  var elsewhere = pathMod.join(root, "elsewhere.txt");
  var name = pathMod.join(root, "name.txt");
  fs.writeFileSync(target, "x");
  fs.writeFileSync(elsewhere, "y");

  var input = { file_path: name };
  fs.writeFileSync(name, "z");
  var map = {};
  map[key("Write", input)] = grantKeys.grantValue("Write", input);
  assert.equal(map["Write:" + name], name, "the realpath at grant time is stored");
  assert.equal(grantKeys.isGranted(map, "Write", input), true, "unchanged");

  fs.rmSync(name);
  fs.symlinkSync(elsewhere, name);
  assert.equal(grantKeys.isGranted(map, "Write", input), false, "the name now leads to another file");
  fs.rmSync(name);
  fs.symlinkSync(target, name);
  assert.equal(grantKeys.isGranted(map, "Write", input), false, "and a third file");
});

test("a file that does not exist at grant time stores nothing and the card says so", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var input = { file_path: pathMod.join(root, "later.txt") };
  assert.equal(grantKeys.grantValue("Write", input), null, "no realpath, nothing to store");
  assert.equal(grantKeys.grantScopeText("Write", input), "This file does not exist yet, so this approval covers this call only");
  assert.equal(grantKeys.isGranted({}, "Write", input), false, "the next Write prompts");
  assert.equal(grantKeys.isGranted(Object.fromEntries([[key("Write", input), true]]), "Write", input), false, "a bare true under a file key is never accepted");
});

test("a missing file later created as a symlink to an outside file prompts", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var outside = pathMod.join(root, "outside.txt");
  fs.writeFileSync(outside, "secret");
  var input = { file_path: pathMod.join(root, "later.txt") };
  var map = {};
  var value = grantKeys.grantValue("Write", input);
  if (value !== null) map[key("Write", input)] = value;
  fs.symlinkSync(outside, input.file_path);
  assert.equal(grantKeys.isGranted(map, "Write", input), false);
});

test("a stored realpath that no longer matches prompts", function (t) {
  var fs = require("fs");
  var os = require("os");
  var pathMod = require("path");
  var root = fs.realpathSync(fs.mkdtempSync(pathMod.join(os.tmpdir(), "grant-keys-")));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var input = { file_path: pathMod.join(root, "f.txt") };
  fs.writeFileSync(input.file_path, "x");
  var map = Object.fromEntries([[key("Write", input), pathMod.join(root, "gone.txt")]]);
  assert.equal(grantKeys.isGranted(map, "Write", input), false);
});

test("a file-tool key holds only a realpath string; every other key holds only true", function () {
  assert.equal(grantKeys.isGrantValue("Write:/a", "/real/a"), true);
  assert.equal(grantKeys.isGrantValue("Write:/a", true), false, "an unbound file grant is not a grant");
  assert.equal(grantKeys.isGrantValue("Write:/a", "relative"), false);
  assert.equal(grantKeys.isGrantValue("Bash:ls", "/real/a"), false);
  assert.equal(grantKeys.isGrantValue("Bash:ls", true), true);
  assert.equal(grantKeys.isGrantValue("Write", true), true, "legacy whole-tool");
  assert.equal(grantKeys.isGrantValue("Write", "/real/a"), false, "a whole-tool grant is only ever true");
  assert.equal(grantKeys.isGrantValue("Write:/a", ""), false);
});

test("Codex's file change approval, which names path, is keyed by that exact file", function () {
  assert.equal(key("Edit", { changes: "update /work/a.txt", path: "/work/a.txt" }), "Edit:/work/a.txt");
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
  assert.equal(grantKeys.grantScopeText("Write", { file_path: __filename }), "Allow Write on this file only (" + __filename + ") in this session");
  assert.doesNotMatch(grantKeys.grantScopeText("Write", { file_path: __filename }), /director|files in/i);
  assert.equal(grantKeys.grantScopeText("Skill", { skill: "x" }), "Allow the x skill in this session");
  assert.equal(grantKeys.grantScopeText("mcp__a__b", {}), "Allow every mcp__a__b call in this session");
});

test("a stored key is described for the operator", function () {
  assert.deepEqual(grantKeys.describeGrantKey("Bash:find"), { key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" });
  assert.equal(grantKeys.describeGrantKey("Bash=ls; rm x").text, "Bash: exactly this command: ls; rm x");
  assert.equal(grantKeys.describeGrantKey("Write:/work/p/a.js").text, "Write on this file: /work/p/a.js");
  assert.equal(grantKeys.describeGrantKey("Write:C:\\work\\a.js").text, "Write on this file: C:\\work\\a.js", "a drive colon stays in the path");
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
  var bound = utils.sanitizeAllowedTools({ "Write:/a/b": "/real/b", "Bash:ls": "/real/b", "Write:/c": "rel" });
  assert.deepEqual(Object.assign({}, bound), { "Write:/a/b": "/real/b" }, "a bound realpath survives only under a file key");
  var unbound = utils.sanitizeAllowedTools({ "Write:/a/b": true, "Edit:/c": true, Write: true });
  assert.deepEqual(Object.assign({}, unbound), { Write: true }, "an unbound file value is dropped on load, legacy whole-tool stays");
  var many = {};
  for (var i = 0; i < grantKeys.MAX_GRANTS + 10; i++) many["Bash:p" + i] = true;
  assert.equal(Object.keys(utils.sanitizeAllowedTools(many)).length, grantKeys.MAX_GRANTS);
});
