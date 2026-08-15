// Regression tests for lr-3ccc78 — discoverClaudeSkills(cwd) in
// lib/yoke/adapters/codex.js resolved the DAEMON process's REAL_HOME for
// EVERY console user (a module-level constant, computed once at process
// load, never re-resolved per session). On a shared multi-user daemon this
// meant every user saw the daemon operator's ~/.claude/skills as their
// "global" skills, and no user's own global skills were ever visible.
//
// Fix: discoverClaudeSkills / discoverSkillsWithMeta / attachSkillDiscovery's
// discoverSkillDirs / readAgentToolsFromFile all accept an optional
// homeOverride that callers resolve from the session's linuxUser
// (os-users.getLinuxUserHome) and thread through per-query/per-session
// instead of falling back to the frozen REAL_HOME constant.
//
// This suite proves the isolation property directly: two distinct "user
// homes" each with their own ~/.claude/skills produce disjoint discovery
// results, and a caller that never passes homeOverride still falls back to
// REAL_HOME (single-user / no-OS-isolation case unchanged).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");
var discoverClaudeSkills = codexAdapter._test_discoverClaudeSkills;
var { discoverSkillsWithMeta, attachSkillDiscovery } = require("../lib/sdk-skill-discovery");
var { readAgentToolsFromFile } = require("../lib/agents");

function makeUserHome(skillNames) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-home-"));
  var skillsDir = path.join(home, ".claude", "skills");
  skillNames.forEach(function (name) {
    var dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "description: " + name + " skill\n# " + name + "\n");
  });
  return home;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

// ---------------------------------------------------------------------------
// discoverClaudeSkills (Codex adapter)
// ---------------------------------------------------------------------------

test("lr-3ccc78: discoverClaudeSkills isolates two users' global skills from each other", function () {
  var operatorHome = makeUserHome(["operator-only-skill"]);
  var aliceHome = makeUserHome(["alice-only-skill"]);
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-cwd-"));
  try {
    // Without homeOverride, discoverClaudeSkills falls back to REAL_HOME —
    // simulate that by calling with the operator's home directly (this test
    // does not depend on process.env; it exercises the parameter contract).
    var operatorView = discoverClaudeSkills(cwd, operatorHome);
    assert.ok(operatorView["operator-only-skill"], "operator sees their own skill");
    assert.equal(operatorView["alice-only-skill"], undefined, "operator must not see alice's skill");

    var aliceView = discoverClaudeSkills(cwd, aliceHome);
    assert.ok(aliceView["alice-only-skill"], "alice sees her own skill");
    assert.equal(aliceView["operator-only-skill"], undefined, "alice must not see the operator's skill");
  } finally {
    rmrf(operatorHome);
    rmrf(aliceHome);
    rmrf(cwd);
  }
});

test("lr-3ccc78: discoverClaudeSkills without homeOverride falls back to REAL_HOME (single-user case unchanged)", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-cwd-"));
  try {
    // No homeOverride passed — must not throw, must return an object (may be
    // empty depending on the test runner's actual REAL_HOME/.claude/skills).
    var result = discoverClaudeSkills(cwd);
    assert.equal(typeof result, "object");
  } finally {
    rmrf(cwd);
  }
});

// ---------------------------------------------------------------------------
// discoverSkillsWithMeta (shared root used by BOTH Claude and Codex paths)
// ---------------------------------------------------------------------------

test("lr-3ccc78: discoverSkillsWithMeta isolates two users' global skills via homeOverride", function () {
  var opHome = makeUserHome(["op-skill"]);
  var bobHome = makeUserHome(["bob-skill"]);
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-cwd2-"));
  try {
    var opResult = discoverSkillsWithMeta(cwd, opHome);
    var opNames = opResult.map(function (s) { return s.name; });
    assert.ok(opNames.indexOf("op-skill") !== -1);
    assert.equal(opNames.indexOf("bob-skill"), -1, "operator's discovery must not include bob's skill");

    var bobResult = discoverSkillsWithMeta(cwd, bobHome);
    var bobNames = bobResult.map(function (s) { return s.name; });
    assert.ok(bobNames.indexOf("bob-skill") !== -1);
    assert.equal(bobNames.indexOf("op-skill"), -1, "bob's discovery must not include the operator's skill");
  } finally {
    rmrf(opHome);
    rmrf(bobHome);
    rmrf(cwd);
  }
});

// ---------------------------------------------------------------------------
// attachSkillDiscovery's discoverSkillDirs (Claude warmup/init merge path)
// ---------------------------------------------------------------------------

test("lr-3ccc78: attachSkillDiscovery's discoverSkillDirs isolates users via homeOverride", function () {
  var opHome = makeUserHome(["op-dir-skill"]);
  var carolHome = makeUserHome(["carol-dir-skill"]);
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-cwd3-"));
  try {
    var skills = attachSkillDiscovery({ cwd: cwd });
    var opDirs = skills.discoverSkillDirs(opHome);
    assert.ok(opDirs["op-dir-skill"]);
    assert.equal(opDirs["carol-dir-skill"], undefined);

    var carolDirs = skills.discoverSkillDirs(carolHome);
    assert.ok(carolDirs["carol-dir-skill"]);
    assert.equal(carolDirs["op-dir-skill"], undefined);
  } finally {
    rmrf(opHome);
    rmrf(carolHome);
    rmrf(cwd);
  }
});

// ---------------------------------------------------------------------------
// readAgentToolsFromFile (the twin — agents.js, same REAL_HOME defect class)
// ---------------------------------------------------------------------------

function makeAgentsDir(agentName, tools) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-agents-"));
  var agentsDir = path.join(home, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  var body = "---\nname: " + agentName + "\ntools: " + JSON.stringify(tools) + "\n---\nBody.\n";
  fs.writeFileSync(path.join(agentsDir, agentName + ".md"), body);
  return agentsDir;
}

test("lr-3ccc78 (twin): readAgentToolsFromFile isolates two users' agent definitions via globalAgentsDir override", function () {
  var opAgentsDir = makeAgentsDir("shared-agent-name", ["Read", "Bash"]);
  var daveAgentsDir = makeAgentsDir("shared-agent-name", ["Read"]);
  try {
    var opTools = readAgentToolsFromFile("shared-agent-name", opAgentsDir);
    assert.deepEqual(opTools, ["Read", "Bash"]);

    var daveTools = readAgentToolsFromFile("shared-agent-name", daveAgentsDir);
    assert.deepEqual(daveTools, ["Read"]);
  } finally {
    rmrf(path.dirname(opAgentsDir));
    rmrf(path.dirname(daveAgentsDir));
  }
});

test("lr-3ccc78 (twin): readAgentToolsFromFile without override still works (backward compat)", function () {
  // No second argument — must not throw, returns null (no such agent) rather
  // than crashing on the fallback-to-AGENTS_SOURCE_DIR path.
  var result = readAgentToolsFromFile("lr-3ccc78-nonexistent-agent-name");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Path-traversal / symlink-escape containment
//
// BOBBIE (PR #394 review) found the original version of this section built
// an "outside" directory that was never linked INTO the skills dir a
// readdirSync call would ever traverse — so it passed identically whether or
// not containment logic worked at all. A real regression case here MUST put
// a symlinked directory ENTRY inside the skills dir pointing OUTSIDE it,
// because that is exactly the escape vector: fs.readdirSync's withFileTypes
// entries include symlinks (entry.isSymbolicLink()), and a lexical
// path.resolve/startsWith check on the entry name does not stop a later
// fs.accessSync/readFileSync from following that symlink to its real target.
// Only fs.realpathSync-based containment (the second stage safePath in
// project.js applies) actually closes this.
// ---------------------------------------------------------------------------

// Builds: <home>/.claude/skills/escape-link -> <outside>/secret-skill
// (a real directory with its own SKILL.md, entirely outside the skills dir).
// Returns { home, outside } for the caller to pass into whichever
// discovery function is under test.
function makeSymlinkEscapeFixture() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-contain-home-"));
  var outside = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-contain-outside-"));
  var skillsDir = path.join(home, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  var secretDir = path.join(outside, "secret-skill");
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, "SKILL.md"), "description: secret\n# secret\n");

  // The escape vector: a symlink NAMED as a skill directory entry, living
  // INSIDE skillsDir, whose target resolves OUTSIDE skillsDir.
  fs.symlinkSync(secretDir, path.join(skillsDir, "escape-link"), "dir");

  return { home: home, outside: outside };
}

test("lr-3ccc78: discoverClaudeSkills refuses a symlinked skill entry that escapes the skills base dir", function () {
  var fixture = makeSymlinkEscapeFixture();
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-contain-cwd-"));
  try {
    var result = discoverClaudeSkills(cwd, fixture.home);
    assert.equal(result["escape-link"], undefined, "a symlinked entry escaping the skills dir must be refused, not followed");
  } finally {
    rmrf(fixture.home);
    rmrf(fixture.outside);
    rmrf(cwd);
  }
});

test("lr-3ccc78: discoverSkillsWithMeta refuses a symlinked skill entry that escapes the skills base dir", function () {
  var fixture = makeSymlinkEscapeFixture();
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-contain-cwd2-"));
  try {
    var result = discoverSkillsWithMeta(cwd, fixture.home);
    var names = result.map(function (s) { return s.name; });
    assert.equal(names.indexOf("escape-link"), -1, "a symlinked entry escaping the skills dir must be refused, not followed");
  } finally {
    rmrf(fixture.home);
    rmrf(fixture.outside);
    rmrf(cwd);
  }
});

test("lr-3ccc78: attachSkillDiscovery's discoverSkillDirs refuses a symlinked skill entry that escapes the skills base dir", function () {
  var fixture = makeSymlinkEscapeFixture();
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lr-3ccc78-contain-cwd3-"));
  try {
    var skills = attachSkillDiscovery({ cwd: cwd });
    var result = skills.discoverSkillDirs(fixture.home);
    assert.equal(result["escape-link"], undefined, "a symlinked entry escaping the skills dir must be refused, not followed");
  } finally {
    rmrf(fixture.home);
    rmrf(fixture.outside);
    rmrf(cwd);
  }
});
