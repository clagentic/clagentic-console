// lr-c1a2 — regression tests for readProjectAgents
//
// Verifies that the helper correctly scans a project's .claude/agents/ directory
// and returns {name, slug, description}[] entries parsed from frontmatter.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var agentsModule = require("../lib/agents");
var { readProjectAgents } = agentsModule;

// --- Helpers ---

function makeTmpProjectDir() {
  var base = os.tmpdir();
  var dir = path.join(base, "clagentic-test-lr-c1a2-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgentsDir(projectDir) {
  var agentsDir = path.join(projectDir, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  return agentsDir;
}

function writeAgent(agentsDir, filename, content) {
  fs.writeFileSync(path.join(agentsDir, filename), content, "utf8");
}

function rmDir(dir) {
  // Node 16+ has fs.rmSync with recursive.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
}

// ============================================================
// Guard: export exists
// ============================================================

test("readProjectAgents is exported from lib/agents.js", function () {
  assert.strictEqual(typeof readProjectAgents, "function",
    "readProjectAgents must be exported from lib/agents.js");
});

// ============================================================
// Input validation
// ============================================================

test("readProjectAgents: returns [] for null projectDir", function () {
  var result = readProjectAgents(null);
  assert.deepStrictEqual(result, []);
});

test("readProjectAgents: returns [] for empty string", function () {
  var result = readProjectAgents("");
  assert.deepStrictEqual(result, []);
});

test("readProjectAgents: returns [] for non-string", function () {
  assert.deepStrictEqual(readProjectAgents(42), []);
  assert.deepStrictEqual(readProjectAgents({}), []);
});

// ============================================================
// Missing directory — graceful degradation
// ============================================================

test("readProjectAgents: returns [] when .claude/agents/ does not exist", function () {
  var dir = makeTmpProjectDir();
  try {
    var result = readProjectAgents(dir);
    assert.deepStrictEqual(result, []);
  } finally {
    rmDir(dir);
  }
});

test("readProjectAgents: returns [] for nonexistent projectDir", function () {
  var result = readProjectAgents("/tmp/zzz-lr-c1a2-does-not-exist-ever");
  assert.deepStrictEqual(result, []);
});

// ============================================================
// Empty agents directory
// ============================================================

test("readProjectAgents: returns [] for empty .claude/agents/ directory", function () {
  var dir = makeTmpProjectDir();
  makeAgentsDir(dir);
  try {
    var result = readProjectAgents(dir);
    assert.deepStrictEqual(result, []);
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Single agent with full frontmatter
// ============================================================

test("readProjectAgents: parses name and description from frontmatter", function () {
  var dir = makeTmpProjectDir();
  var agentsDir = makeAgentsDir(dir);
  writeAgent(agentsDir, "my-agent.md", [
    "---",
    "name: My Custom Agent",
    "description: Does something special",
    "---",
    "Agent body here.",
  ].join("\n"));
  try {
    var result = readProjectAgents(dir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "My Custom Agent");
    assert.strictEqual(result[0].slug, "my-agent");
    assert.strictEqual(result[0].description, "Does something special");
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Agent with no frontmatter — slug used as name
// ============================================================

test("readProjectAgents: uses slug as name when no frontmatter name field", function () {
  var dir = makeTmpProjectDir();
  var agentsDir = makeAgentsDir(dir);
  writeAgent(agentsDir, "plain-agent.md", "Just a plain body, no frontmatter.");
  try {
    var result = readProjectAgents(dir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "plain-agent");
    assert.strictEqual(result[0].slug, "plain-agent");
    assert.strictEqual(result[0].description, "");
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Non-.md files are ignored
// ============================================================

test("readProjectAgents: ignores non-.md files in .claude/agents/", function () {
  var dir = makeTmpProjectDir();
  var agentsDir = makeAgentsDir(dir);
  writeAgent(agentsDir, "valid.md", "---\nname: Valid\n---\n");
  writeAgent(agentsDir, "ignored.txt", "should not appear");
  writeAgent(agentsDir, "also-ignored.json", '{"name":"json-agent"}');
  try {
    var result = readProjectAgents(dir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].slug, "valid");
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Multiple agents — sorted by name
// ============================================================

test("readProjectAgents: returns multiple agents sorted by name", function () {
  var dir = makeTmpProjectDir();
  var agentsDir = makeAgentsDir(dir);
  writeAgent(agentsDir, "zebra.md", "---\nname: Zebra Agent\n---\n");
  writeAgent(agentsDir, "alpha.md", "---\nname: Alpha Agent\n---\n");
  writeAgent(agentsDir, "beta.md", "---\nname: Beta Agent\n---\n");
  try {
    var result = readProjectAgents(dir);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, "Alpha Agent");
    assert.strictEqual(result[1].name, "Beta Agent");
    assert.strictEqual(result[2].name, "Zebra Agent");
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Agent with frontmatter but no description field
// ============================================================

test("readProjectAgents: description defaults to empty string when absent", function () {
  var dir = makeTmpProjectDir();
  var agentsDir = makeAgentsDir(dir);
  writeAgent(agentsDir, "nodesc.md", "---\nname: No Description Agent\n---\nBody.");
  try {
    var result = readProjectAgents(dir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].description, "");
  } finally {
    rmDir(dir);
  }
});
