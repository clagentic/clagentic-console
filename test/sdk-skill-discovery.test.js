/**
 * Tests for lr-7d8d: enriched skill metadata functions in sdk-skill-discovery.js
 *
 * Covers:
 *   (1-6) extractSkillDescription: various SKILL.md content patterns
 *   (7-9) mergeSkillsWithMeta: deduplication and merge priority
 *  (10)   backward compat: splitShellSegments, attachSkillDiscovery still exported
 *  (11)   new exports present: discoverSkillsWithMeta, mergeSkillsWithMeta
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var {
  splitShellSegments,
  attachSkillDiscovery,
  extractSkillDescription,
  discoverSkillsWithMeta,
  mergeSkillsWithMeta,
} = require("../lib/sdk-skill-discovery");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lr-7d8d-test-"));
}

function makeSkillDir(base, skillName, content) {
  var skillDir = path.join(base, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  if (content !== undefined) {
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
  }
  return skillDir;
}

// ---------------------------------------------------------------------------
// extractSkillDescription
// ---------------------------------------------------------------------------

test("extractSkillDescription: frontmatter description: line is returned", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "description: Does something useful\n# My Skill\n\nSome body text.\n");
    assert.equal(extractSkillDescription(skillDir), "Does something useful");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: first prose line returned when no frontmatter description", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "# My Skill\n\nThis is the first prose line.\n");
    assert.equal(extractSkillDescription(skillDir), "This is the first prose line.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: skips multiple headings to find first prose", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "# Title\n\n## Subtitle\n\nProse here.\n");
    assert.equal(extractSkillDescription(skillDir), "Prose here.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: returns empty string when only headings exist", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill", "# Title\n## Another\n\n");
    assert.equal(extractSkillDescription(skillDir), "");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: returns empty string when SKILL.md is missing", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = path.join(tmp, "no-skill-md");
    fs.mkdirSync(skillDir);
    assert.equal(extractSkillDescription(skillDir), "");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: description: after first heading treated as prose, not frontmatter", function () {
  var tmp = makeTmpDir();
  try {
    // Once past the first heading, `description:` is just prose content
    var skillDir = makeSkillDir(tmp, "my-skill",
      "# Title\n\ndescription: late\n\nOther.\n");
    // First non-empty line after heading is "description: late" (raw prose)
    assert.equal(extractSkillDescription(skillDir), "description: late");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// mergeSkillsWithMeta
// ---------------------------------------------------------------------------

test("mergeSkillsWithMeta: sdk-name-only entry gets empty description and type skill", function () {
  var result = mergeSkillsWithMeta(["sdk-skill"], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "sdk-skill");
  assert.equal(result[0].description, "");
  assert.equal(result[0].type, "skill");
});

test("mergeSkillsWithMeta: fs skill overrides sdk-name-only entry", function () {
  var result = mergeSkillsWithMeta(
    ["shared"],
    [{ name: "shared", description: "From fs", type: "skill" }]
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "shared");
  assert.equal(result[0].description, "From fs");
});

test("mergeSkillsWithMeta: deduplicates — fs skill wins, sdk-only entry added for non-overlapping", function () {
  var result = mergeSkillsWithMeta(
    ["alpha", "beta"],
    [{ name: "alpha", description: "fs-alpha", type: "skill" }]
  );
  assert.equal(result.length, 2);
  var byName = {};
  result.forEach(function (r) { byName[r.name] = r; });
  assert.equal(byName.alpha.description, "fs-alpha");
  assert.equal(byName.beta.description, "");
});

test("mergeSkillsWithMeta: handles null sdk list gracefully", function () {
  var result = mergeSkillsWithMeta(
    null,
    [{ name: "fs-only", description: "Hello", type: "skill" }]
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "fs-only");
});

test("mergeSkillsWithMeta: returns empty array for empty inputs", function () {
  var result = mergeSkillsWithMeta([], []);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// discoverSkillsWithMeta: basic shape check using actual filesystem
// (avoids REAL_HOME patching; verifies the function runs and returns an array)
// ---------------------------------------------------------------------------

test("discoverSkillsWithMeta: returns an array (may be empty for this test project)", function () {
  // Use a fresh temp dir as cwd so no project skills are found,
  // and if global skills dir doesn't exist, still returns []
  var tmp = makeTmpDir();
  try {
    var result = discoverSkillsWithMeta(tmp);
    assert.ok(Array.isArray(result));
    // Every entry must have name, description, type
    result.forEach(function (entry) {
      assert.ok(typeof entry.name === "string");
      assert.ok(typeof entry.description === "string");
      assert.ok(typeof entry.type === "string");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("discoverSkillsWithMeta: returns skill entries when project skills dir is present", function () {
  var tmp = makeTmpDir();
  try {
    var skillsDir = path.join(tmp, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillDir(skillsDir, "test-skill", "description: A test skill\n# Test\n");

    var result = discoverSkillsWithMeta(tmp);
    // Should include our test-skill at minimum
    var found = result.filter(function (r) { return r.name === "test-skill"; });
    assert.equal(found.length, 1);
    assert.equal(found[0].description, "A test skill");
    assert.equal(found[0].type, "skill");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Backward compat: existing exports still present
// ---------------------------------------------------------------------------

test("backward compat: splitShellSegments is still exported and functional", function () {
  assert.equal(typeof splitShellSegments, "function");
  var segs = splitShellSegments("echo hello && ls");
  assert.ok(segs.length >= 2);
});

test("backward compat: attachSkillDiscovery is still exported", function () {
  assert.equal(typeof attachSkillDiscovery, "function");
});

test("new exports: discoverSkillsWithMeta and mergeSkillsWithMeta are exported functions", function () {
  assert.equal(typeof discoverSkillsWithMeta, "function");
  assert.equal(typeof mergeSkillsWithMeta, "function");
});

// ---------------------------------------------------------------------------
// lr-2634: YAML block scalar descriptions in extractSkillDescription
// ---------------------------------------------------------------------------

test("extractSkillDescription: description: > folded block scalar returns joined text", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "description: >\n  The actual description text\n  that spans multiple lines.\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "The actual description text that spans multiple lines.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: description: | literal block scalar returns joined text", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "description: |\n  Line one.\n  Line two.\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "Line one. Line two.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: description: >- chomping modifier works", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "description: >-\n  Strip trailing newlines.\n  Still joined.\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "Strip trailing newlines. Still joined.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: plain description: some text still works (regression)", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "description: A plain one-line description\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "A plain one-line description");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// lr-9106: YAML frontmatter (--- delimited) description parsing
// ---------------------------------------------------------------------------

test("extractSkillDescription: YAML frontmatter with double-quoted description", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      '---\nname: my-skill\ndescription: "Does something useful with quotes"\nallowed-tools: Bash(*)\n---\n# My Skill\n\nBody.\n');
    assert.equal(extractSkillDescription(skillDir), "Does something useful with quotes");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: YAML frontmatter with unquoted description", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "---\nname: my-skill\ndescription: Restores session context from lore\nallowed-tools: Bash(*)\n---\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "Restores session context from lore");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: YAML frontmatter with block scalar description (>)", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "---\nname: my-skill\ndescription: >\n  Multi-line description\n  joined together.\n---\n# My Skill\n\nBody.\n");
    assert.equal(extractSkillDescription(skillDir), "Multi-line description joined together.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: YAML frontmatter without description falls through to prose", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "---\nname: my-skill\nallowed-tools: Bash(*)\n---\n# My Skill\n\nFirst prose line here.\n");
    assert.equal(extractSkillDescription(skillDir), "First prose line here.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test("extractSkillDescription: file without frontmatter still returns prose (regression)", function () {
  var tmp = makeTmpDir();
  try {
    var skillDir = makeSkillDir(tmp, "my-skill",
      "# My Skill\n\nNo frontmatter at all.\n");
    assert.equal(extractSkillDescription(skillDir), "No frontmatter at all.");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});
