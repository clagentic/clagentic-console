// lr-c1a2 — regression tests for readProjectAgents
//
// Verifies that the helper correctly scans a project's .claude/agents/ directory
// and the global ~/.claude/agents/ directory, merges them (project-local wins),
// and returns {name, slug, description}[] entries parsed from frontmatter.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var agentsModule = require("../lib/agents");
var { readProjectAgents } = agentsModule;

// Sentinel path used to suppress the real ~/.claude/agents/ in tests that
// exercise project-local behaviour in isolation. The path is guaranteed to
// not exist — tests that need global-agent behaviour create their own tmpdir.
var ABSENT_GLOBAL_DIR = "/nonexistent-lr-c1a2-global-absent-sentinel";

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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
    assert.deepStrictEqual(result, []);
  } finally {
    rmDir(dir);
  }
});

test("readProjectAgents: returns [] for nonexistent projectDir", function () {
  var result = readProjectAgents("/tmp/zzz-lr-c1a2-does-not-exist-ever", ABSENT_GLOBAL_DIR);
  assert.deepStrictEqual(result, []);
});

// ============================================================
// Empty agents directory
// ============================================================

test("readProjectAgents: returns [] for empty .claude/agents/ directory", function () {
  var dir = makeTmpProjectDir();
  makeAgentsDir(dir);
  try {
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
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
    var result = readProjectAgents(dir, ABSENT_GLOBAL_DIR);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].description, "");
  } finally {
    rmDir(dir);
  }
});

// ============================================================
// Traversal-style projectDir — belt-and-suspenders safety
// ============================================================

test("readProjectAgents: returns [] for traversal-style path (e.g. ../../etc)", function () {
  // The input is server-controlled, but this locks the contract: a path that
  // looks like a traversal attempt must never throw and must return [].
  //
  // We use absolute paths to nonexistent directories so the test is
  // deterministic regardless of cwd or what happens to exist on the host.
  // path.join("/nonexistent-lr-c1a2-traversal/../../etc", ".claude", "agents")
  // normalises to a path under a nonexistent root, so readdirSync throws ENOENT
  // and readProjectAgents returns [] without propagating the error.
  // path.join() normalises traversal segments before readdirSync sees the path,
  // so these inputs exercise the traversal code path without any existing
  // .claude/agents/ directory to accidentally read. All resolved targets are
  // guaranteed non-existent by using a unique sentinel prefix.
  var traversalPaths = [
    "/nonexistent-lr-c1a2-sentinel-xq7/../../nonexistent-lr-c1a2-sentinel-xq7",
    "/nonexistent-lr-c1a2-sentinel-xq7/../../../nonexistent-lr-c1a2-sentinel-xq7",
  ];
  for (var i = 0; i < traversalPaths.length; i++) {
    var result;
    var tpath = traversalPaths[i];
    assert.doesNotThrow(function () {
      result = readProjectAgents(tpath, ABSENT_GLOBAL_DIR);
    }, "readProjectAgents must not throw for traversal-style path: " + tpath);
    assert.deepStrictEqual(result, [],
      "readProjectAgents must return [] for traversal-style path: " + tpath);
  }
});

// ============================================================
// Global ~/.claude/agents/ discovery (lr-c1a2 follow-up)
//
// These tests use the second internal parameter (_globalAgentsDir) to inject
// a temporary directory in place of the real ~/.claude/agents/, so the tests
// are hermetic and do not touch the host's home directory.
// ============================================================

test("readProjectAgents: returns global agents when project has no .claude/agents/", function () {
  var projectDir = makeTmpProjectDir();
  var globalDir = makeTmpProjectDir();
  // Write a global-only agent.
  fs.mkdirSync(globalDir, { recursive: true });
  writeAgent(globalDir, "global-only.md", "---\nname: Global Only\ndescription: From global dir\n---\n");
  try {
    var result = readProjectAgents(projectDir, globalDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].slug, "global-only");
    assert.strictEqual(result[0].name, "Global Only");
    assert.strictEqual(result[0].description, "From global dir");
  } finally {
    rmDir(projectDir);
    rmDir(globalDir);
  }
});

test("readProjectAgents: project-local agent overrides global agent with same slug", function () {
  var projectDir = makeTmpProjectDir();
  var localAgentsDir = makeAgentsDir(projectDir);
  var globalDir = makeTmpProjectDir();
  // Same slug in both; local description differs.
  writeAgent(localAgentsDir, "shared-agent.md", "---\nname: Local Version\ndescription: Local wins\n---\n");
  writeAgent(globalDir, "shared-agent.md", "---\nname: Global Version\ndescription: Global loses\n---\n");
  try {
    var result = readProjectAgents(projectDir, globalDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "Local Version");
    assert.strictEqual(result[0].description, "Local wins");
  } finally {
    rmDir(projectDir);
    rmDir(globalDir);
  }
});

test("readProjectAgents: merges distinct agents from both directories, sorted by name", function () {
  var projectDir = makeTmpProjectDir();
  var localAgentsDir = makeAgentsDir(projectDir);
  var globalDir = makeTmpProjectDir();
  writeAgent(localAgentsDir, "local-agent.md", "---\nname: Local Agent\n---\n");
  writeAgent(globalDir, "global-agent.md", "---\nname: Global Agent\n---\n");
  try {
    var result = readProjectAgents(projectDir, globalDir);
    assert.strictEqual(result.length, 2);
    // Sorted by name: "Global Agent" < "Local Agent"
    assert.strictEqual(result[0].name, "Global Agent");
    assert.strictEqual(result[1].name, "Local Agent");
  } finally {
    rmDir(projectDir);
    rmDir(globalDir);
  }
});

test("readProjectAgents: global dir absent is treated as empty — no error", function () {
  var projectDir = makeTmpProjectDir();
  var localAgentsDir = makeAgentsDir(projectDir);
  writeAgent(localAgentsDir, "local.md", "---\nname: Local\n---\n");
  var absentGlobalDir = path.join(os.tmpdir(), "lr-c1a2-global-absent-" + Date.now());
  try {
    var result = readProjectAgents(projectDir, absentGlobalDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "Local");
  } finally {
    rmDir(projectDir);
  }
});
