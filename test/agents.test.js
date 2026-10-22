// lr-4c90 — regression tests for readAgentToolsFromFile
//
// Verifies that the helper correctly reads the tools frontmatter field from
// agent definition files and returns a string[] or null. This is the
// enforcement path for belt-and-suspenders tool restriction in sdk-bridge.js.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// We need to control AGENTS_SOURCE_DIR. The module reads it at load time from
// os.homedir(), so we override it after requiring — the function uses the
// module-level var, not the export. The cleanest approach for a unit test is
// to write real temp files and point AGENTS_SOURCE_DIR at the temp dir via a
// wrapper. Since readAgentToolsFromFile uses path.join(AGENTS_SOURCE_DIR, ...),
// and AGENTS_SOURCE_DIR is a module-level var (not a const), we work around
// this by writing temp files under the actual AGENTS_SOURCE_DIR path (which
// exists on this machine) and using unlikely agent names that won't collide.
//
// Alternatively, we test the function via a thin wrapper that accepts a dir.
// The current implementation does not accept a dir override — we test by
// writing real temp files using a uniquely-named test agent.

var agentsModule = require("../lib/agents");
var { readAgentToolsFromFile, parseFrontmatter, AGENTS_SOURCE_DIR } = agentsModule;

// ============================================================
// parseFrontmatter unit tests
// ============================================================

test("parseFrontmatter: parses JSON array tools field as raw string", function () {
  var raw = [
    "---",
    'name: test-agent',
    'tools: ["Read", "Grep", "Bash"]',
    "---",
    "Agent body.",
  ].join("\n");
  var result = parseFrontmatter(raw);
  assert.ok(result, "should return a result");
  assert.strictEqual(result.meta.tools, '["Read", "Grep", "Bash"]',
    "tools field value should be the raw JSON string (parseFrontmatter does not JSON-parse)");
  assert.strictEqual(result.body, "Agent body.");
});

test("parseFrontmatter: parses comma-string tools field as raw string", function () {
  var raw = [
    "---",
    "tools: Read, Grep, Bash",
    "---",
    "body",
  ].join("\n");
  var result = parseFrontmatter(raw);
  assert.strictEqual(result.meta.tools, "Read, Grep, Bash");
});

test("parseFrontmatter: returns empty meta for no frontmatter", function () {
  var result = parseFrontmatter("Just a body, no frontmatter.");
  assert.deepStrictEqual(result.meta, {});
  assert.strictEqual(result.body, "Just a body, no frontmatter.");
});

// ============================================================
// readAgentToolsFromFile — null-guard and parse cases
// ============================================================

test("readAgentToolsFromFile: returns null for null agentName", function () {
  assert.strictEqual(readAgentToolsFromFile(null), null);
});

test("readAgentToolsFromFile: returns null for empty agentName", function () {
  assert.strictEqual(readAgentToolsFromFile(""), null);
});

test("readAgentToolsFromFile: returns null for non-string agentName", function () {
  assert.strictEqual(readAgentToolsFromFile(42), null);
  assert.strictEqual(readAgentToolsFromFile(true), null);
});

test("readAgentToolsFromFile: returns null for unknown agent (file not found)", function () {
  // Agent name unlikely to exist on disk.
  var result = readAgentToolsFromFile("zzz-nonexistent-agent-lr-4c90");
  assert.strictEqual(result, null);
});

// Write temp agent files into AGENTS_SOURCE_DIR (or os.tmpdir if that dir
// doesn't exist — we check for each test). We use a unique prefix to avoid
// colliding with real agents.
var TEMP_AGENT_PREFIX = "zzz-test-lr4c90-";

function writeTempAgent(slug, content) {
  var filePath = path.join(AGENTS_SOURCE_DIR, slug + ".md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function removeTempAgent(slug) {
  var filePath = path.join(AGENTS_SOURCE_DIR, slug + ".md");
  try { fs.unlinkSync(filePath); } catch (e) { /* best-effort */ }
}

var canWriteAgentsDir = false;
try {
  fs.accessSync(AGENTS_SOURCE_DIR, fs.constants.W_OK);
  canWriteAgentsDir = true;
} catch (e) {
  canWriteAgentsDir = false;
}

// Helper: skip with a TODO message if we can't write to the agents dir.
function maybeTest(name, fn) {
  if (canWriteAgentsDir) {
    test(name, fn);
  } else {
    test(name + " [SKIP — AGENTS_SOURCE_DIR not writable]", function () {
      // Not a failure — this environment doesn't have a writable agents dir.
    });
  }
}

maybeTest("readAgentToolsFromFile: returns string[] for valid JSON array tools field", function () {
  var slug = TEMP_AGENT_PREFIX + "valid";
  var content = [
    "---",
    "name: " + slug,
    'tools: ["Read", "Grep", "Bash"]',
    "---",
    "Test agent body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    var result = readAgentToolsFromFile(slug);
    assert.ok(Array.isArray(result), "should return an array");
    assert.deepStrictEqual(result, ["Read", "Grep", "Bash"]);
  } finally {
    removeTempAgent(slug);
  }
});

maybeTest("readAgentToolsFromFile: returns null for comma-string tools field (legacy format)", function () {
  var slug = TEMP_AGENT_PREFIX + "comma-string";
  var content = [
    "---",
    "name: " + slug,
    "tools: Read, Grep, Bash",
    "---",
    "Test agent body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    var result = readAgentToolsFromFile(slug);
    assert.strictEqual(result, null,
      "comma-string format must not be parsed — would silently apply no restriction if used");
  } finally {
    removeTempAgent(slug);
  }
});

maybeTest("readAgentToolsFromFile: returns null for agent file with no tools field", function () {
  var slug = TEMP_AGENT_PREFIX + "no-tools";
  var content = [
    "---",
    "name: " + slug,
    "description: An agent with no declared tools.",
    "---",
    "Body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    var result = readAgentToolsFromFile(slug);
    assert.strictEqual(result, null);
  } finally {
    removeTempAgent(slug);
  }
});

maybeTest("readAgentToolsFromFile: returns null for malformed JSON array", function () {
  var slug = TEMP_AGENT_PREFIX + "bad-json";
  var content = [
    "---",
    "name: " + slug,
    'tools: ["Read", "Grep"',
    "---",
    "Body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    var result = readAgentToolsFromFile(slug);
    assert.strictEqual(result, null, "malformed JSON must not throw and must return null");
  } finally {
    removeTempAgent(slug);
  }
});

maybeTest("readAgentToolsFromFile: returns null for empty JSON array", function () {
  var slug = TEMP_AGENT_PREFIX + "empty-array";
  var content = [
    "---",
    "name: " + slug,
    "tools: []",
    "---",
    "Body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    var result = readAgentToolsFromFile(slug);
    // An empty tools array means no tools — caller should leave enforcement
    // to the SDK's own agent option rather than restricting to an empty set.
    assert.strictEqual(result, null, "empty array should return null (caller leaves restriction to SDK)");
  } finally {
    removeTempAgent(slug);
  }
});

maybeTest("readAgentToolsFromFile: agent name with spaces/caps is slugified correctly", function () {
  // Agent names with uppercase letters get slugified; the file must match.
  var slug = TEMP_AGENT_PREFIX + "slug-test";
  var content = [
    "---",
    'tools: ["Read"]',
    "---",
    "Body.",
  ].join("\n");
  writeTempAgent(slug, content);
  try {
    // The agent name "ZZZ-Test-Lr4c90-SLUG-Test" should slugify to slug.
    var result = readAgentToolsFromFile("ZZZ-Test-Lr4c90-SLUG-Test");
    assert.ok(Array.isArray(result), "slugified agent name should find file");
    assert.deepStrictEqual(result, ["Read"]);
  } finally {
    removeTempAgent(slug);
  }
});

// ============================================================
// Smoke: sdk-bridge loads without error (requires function is exported)
// ============================================================

test("agents module exports readAgentToolsFromFile", function () {
  assert.strictEqual(typeof readAgentToolsFromFile, "function",
    "readAgentToolsFromFile must be exported from lib/agents.js");
});
