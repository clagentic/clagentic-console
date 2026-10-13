"use strict";
// One skill list for both agents. Claude keeps skills in .claude/skills and
// Codex in .agents/skills, in the user's home and in the project; the console
// discovers from all four and each agent invokes a skill its own way (Codex
// takes the skill as an input item with its SKILL.md path). Caller shapes: a
// skill present in only one agent's directory, in both, at both levels, and one
// that escapes its directory through a link.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var skillDiscovery = require("../lib/sdk-skill-discovery");
var codexAdapter = require("../lib/yoke/adapters/codex");

var roots = [];
test.after(function () { roots.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

function tmp(label) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-" + label + "-"));
  roots.push(dir);
  return dir;
}

function skill(base, sub, name, description) {
  var dir = path.join(base, sub, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n# " + name + "\n");
  return path.join(dir, "SKILL.md");
}

function names(list) { return list.map(function (s) { return s.name; }).sort(); }

test("a skill present in only one agent's directory is on the one list, from either level", function () {
  var home = tmp("home");
  var project = tmp("project");
  skill(home, ".claude", "claude-global", "from the user's Claude directory");
  skill(home, ".agents", "codex-global", "from the user's Codex directory");
  skill(project, ".claude", "claude-project", "from the project's Claude directory");
  skill(project, ".agents", "codex-project", "from the project's Codex directory");

  var list = skillDiscovery.discoverSkillsWithMeta(project, home);
  assert.deepEqual(names(list), ["claude-global", "claude-project", "codex-global", "codex-project"]);
  assert.equal(list.filter(function (s) { return s.name === "codex-global"; })[0].description, "from the user's Codex directory");

  var dirs = skillDiscovery.attachSkillDiscovery({ cwd: project }).discoverSkillDirs(home);
  assert.deepEqual(Object.keys(dirs).sort(), ["claude-global", "claude-project", "codex-global", "codex-project"]);
});

test("a skill present in both agents' directories appears once; the project beats the user, and an agent's own directory beats the other's", function () {
  var home = tmp("home");
  var project = tmp("project");
  skill(home, ".agents", "same", "user codex");
  skill(home, ".claude", "same", "user claude");
  skill(home, ".agents", "only-user", "user codex only");
  skill(project, ".agents", "same", "project codex");
  skill(project, ".claude", "same", "project claude");
  skill(project, ".agents", "only-user", "project codex");

  var list = skillDiscovery.discoverSkillsWithMeta(project, home);
  assert.deepEqual(names(list), ["only-user", "same"]);
  assert.equal(list.filter(function (s) { return s.name === "same"; })[0].description, "project claude");
  assert.equal(list.filter(function (s) { return s.name === "only-user"; })[0].description, "project codex");

  var userOnly = skillDiscovery.discoverSkillsWithMeta(tmp("empty"), home);
  assert.equal(userOnly.filter(function (s) { return s.name === "same"; })[0].description, "user claude");
});

test("for a Codex session a same-named skill in .agents beats .claude at each level; a Claude session keeps .claude first", function () {
  var home = tmp("home");
  var project = tmp("project");
  var homeAgents = skill(home, ".agents", "same", "user codex");
  skill(home, ".claude", "same", "user claude");
  var projectAgents = skill(project, ".agents", "same", "project codex");
  skill(project, ".claude", "same", "project claude");
  skill(home, ".agents", "user-only", "user codex");
  skill(home, ".claude", "user-only", "user claude");

  var forCodex = codexAdapter._test_discoverClaudeSkills(project, home);
  assert.equal(forCodex.same, fs.realpathSync(projectAgents), "the project's .agents skill is the one a Codex turn carries");
  var userLevel = codexAdapter._test_discoverClaudeSkills(tmp("empty"), home);
  assert.equal(userLevel.same, fs.realpathSync(homeAgents));
  assert.equal(userLevel["user-only"], fs.realpathSync(path.join(home, ".agents", "skills", "user-only", "SKILL.md")));

  var codexMeta = skillDiscovery.discoverSkillsWithMeta(project, home, true);
  assert.equal(codexMeta.filter(function (s) { return s.name === "same"; })[0].description, "project codex");
  var claudeMeta = skillDiscovery.discoverSkillsWithMeta(project, home);
  assert.equal(claudeMeta.filter(function (s) { return s.name === "same"; })[0].description, "project claude");
  assert.equal(skillDiscovery.collectSkillDirs(project, home).same, fs.realpathSync(path.dirname(path.join(project, ".claude", "skills", "same", "SKILL.md"))));
});

test("a link in either agent's directory that leaves it is not followed", function () {
  var home = tmp("home");
  var outside = tmp("outside");
  fs.mkdirSync(path.join(outside, "secret"), { recursive: true });
  fs.writeFileSync(path.join(outside, "secret", "SKILL.md"), "description: secret\n");
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  fs.symlinkSync(path.join(outside, "secret"), path.join(home, ".agents", "skills", "escape"), "dir");

  assert.equal(names(skillDiscovery.discoverSkillsWithMeta(tmp("project"), home)).indexOf("escape"), -1);
  assert.equal(skillDiscovery.collectSkillDirs(tmp("project"), home).escape, undefined);
});

test("a name that every object inherits is no skill", function () {
  var home = tmp("home");
  assert.equal(skillDiscovery.collectSkillDirs(tmp("project"), home).constructor, undefined);
  assert.equal(skillDiscovery.collectSkillDirs(tmp("project"), home).toString, undefined);
});

// --- Codex invokes a skill by its path ---

function fakeAppServer() {
  var handlers = [];
  var sent = [];
  return {
    sent: sent,
    started: true,
    addEventHandler: function (fn, id) { var h = { fn: fn, threadId: id || null }; handlers.push(h); return h; },
    removeEventHandler: function () {},
    updateHandlerThreadId: function (h, id) { h.threadId = id; },
    respond: function () {},
    send: function (method, params) {
      sent.push({ method: method, params: params });
      if (method === "thread/start") return Promise.resolve({ thread: { id: "t1" } });
      if (method === "turn/start") {
        setImmediate(function () { handlers.forEach(function (h) { h.fn({ method: "turn/completed", params: { threadId: "t1" } }); }); });
      }
      return Promise.resolve({});
    },
  };
}

async function turnInputFor(cwd, home, text) {
  var server = fakeAppServer();
  var handle = codexAdapter._test_createCodexQueryHandle(server, { model: "gpt-test", cwd: cwd, homeOverride: home, toolPolicy: "allow-all" });
  handle.pushMessage(text);
  var deadline = Date.now() + 3000;
  while (!server.sent.some(function (m) { return m.method === "turn/start"; })) {
    if (Date.now() > deadline) throw new Error("no turn was started");
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  handle.close();
  return server.sent.filter(function (m) { return m.method === "turn/start"; })[0].params.input;
}

test("a Codex turn that names a skill from either agent's directory carries it as an input item with its SKILL.md path", async function () {
  var home = tmp("home");
  var project = tmp("project");
  var fromClaude = skill(home, ".claude", "from-claude", "c");
  var fromCodex = skill(project, ".agents", "from-codex", "x");

  var input = await turnInputFor(project, home, "use $from-claude and $from-codex and $nothing-here");
  var items = input.filter(function (i) { return i.type === "skill"; });
  assert.deepEqual(items.map(function (i) { return i.name; }).sort(), ["from-claude", "from-codex"]);
  assert.equal(items.filter(function (i) { return i.name === "from-claude"; })[0].path, fs.realpathSync(fromClaude));
  assert.equal(items.filter(function (i) { return i.name === "from-codex"; })[0].path, fs.realpathSync(fromCodex));
});

test("discoverSkillFiles gives each skill's SKILL.md and, with no home given, falls back to the daemon's", function () {
  var home = tmp("home");
  var file = skill(home, ".agents", "mine", "m");
  var found = codexAdapter._test_discoverClaudeSkills(tmp("project"), home);
  assert.equal(found.mine, fs.realpathSync(file));
  assert.equal(typeof codexAdapter._test_discoverClaudeSkills(tmp("project")), "object");
});
