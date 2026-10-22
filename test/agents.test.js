// Regression tests for the agent frontmatter parser.

var test = require("node:test");
var assert = require("node:assert");

var { parseFrontmatter } = require("../lib/agents");

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
