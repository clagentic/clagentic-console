/**
 * Tests for lr-cf84: shared slash-command enrichment helper.
 *
 * buildEnrichedSlashCommands(cliSlashCommands, cwd, fns) produces enriched
 * {name, desc, type}[] from three sources with this priority chain:
 *
 *   1. Skill metadata   — type:'skill'
 *   2. Workflow metadata — type:'workflow'
 *   3. CLI-emitted names not covered above — type:'builtin', desc:''
 *
 * Covers:
 *   (1) Skills populate with descriptions (type:'skill')
 *   (2) Workflows populate with descriptions (type:'workflow')
 *   (3) CLI-only names get type:'builtin', desc:''
 *   (4) Deduplication: skill wins over workflow wins over CLI
 *   (5) Workflow wins over CLI when no skill entry
 *   (6) Empty inputs produce empty array
 *   (7) CLI {name,...} objects are accepted without throwing
 *   (8) Discovery errors (throws) are swallowed; CLI builtins still emitted
 *   (9) No fns argument — defaults to module-level imports (smoke test, no fs reads)
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { buildEnrichedSlashCommands } = require("../lib/sdk-slash-enrichment");

// ---------------------------------------------------------------------------
// Helper: build injected fns from plain skill/workflow arrays
// ---------------------------------------------------------------------------

function makeFns(skillMeta, workflowMeta) {
  return {
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function (sdkNames, fsSkills) {
      // Return skillMeta as-is, ignoring the empty fsSkills we return above.
      // This mirrors what the real mergeSkillsWithMeta does when given a pre-built list.
      void sdkNames; void fsSkills;
      return skillMeta;
    },
    discoverWorkflows: function () { return workflowMeta; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("(1) skills populate with descriptions", function () {
  var fns = makeFns(
    [{ name: "my-skill", description: "Does magic", type: "skill" }],
    []
  );
  var result = buildEnrichedSlashCommands(["my-skill"], "/fake/cwd", fns);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "my-skill");
  assert.equal(result[0].desc, "Does magic");
  assert.equal(result[0].type, "skill");
});

test("(2) workflows populate with descriptions", function () {
  var fns = makeFns(
    [],
    [{ name: "my-workflow", description: "Runs phases", type: "workflow" }]
  );
  var result = buildEnrichedSlashCommands(["my-workflow"], "/fake/cwd", fns);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "my-workflow");
  assert.equal(result[0].desc, "Runs phases");
  assert.equal(result[0].type, "workflow");
});

test("(3) CLI-only names get type:builtin, desc:''", function () {
  var fns = makeFns([], []);
  var result = buildEnrichedSlashCommands(["clear", "help"], "/fake/cwd", fns);
  assert.equal(result.length, 2);
  result.forEach(function (r) {
    assert.equal(r.desc, "");
    assert.equal(r.type, "builtin");
  });
});

test("(4) deduplication: skill wins over workflow wins over CLI", function () {
  var fns = makeFns(
    [{ name: "shared", description: "From skill", type: "skill" }],
    [{ name: "shared", description: "From workflow", type: "workflow" }]
  );
  var result = buildEnrichedSlashCommands(["shared"], "/fake/cwd", fns);
  // Must appear exactly once, with skill priority
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "shared");
  assert.equal(result[0].type, "skill");
  assert.equal(result[0].desc, "From skill");
});

test("(5) workflow wins over CLI when no skill entry", function () {
  var fns = makeFns(
    [],
    [{ name: "shared", description: "Workflow desc", type: "workflow" }]
  );
  var result = buildEnrichedSlashCommands(["shared", "other"], "/fake/cwd", fns);
  assert.equal(result.length, 2);
  var byName = {};
  result.forEach(function (r) { byName[r.name] = r; });
  assert.equal(byName.shared.type, "workflow");
  assert.equal(byName.shared.desc, "Workflow desc");
  assert.equal(byName.other.type, "builtin");
  assert.equal(byName.other.desc, "");
});

test("(6) empty inputs produce empty array", function () {
  var fns = makeFns([], []);
  var result = buildEnrichedSlashCommands([], "/fake/cwd", fns);
  assert.deepEqual(result, []);
});

test("(7) CLI {name,...} objects are accepted", function () {
  var fns = makeFns([], []);
  assert.doesNotThrow(function () {
    var result = buildEnrichedSlashCommands(
      [{ name: "obj-cmd", desc: "", type: "builtin" }],
      "/fake/cwd",
      fns
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "obj-cmd");
    assert.equal(result[0].type, "builtin");
  });
});

test("(8) discovery errors are swallowed; CLI builtins still emitted", function () {
  var fns = {
    discoverSkillsWithMeta: function () { throw new Error("no .claude dir"); },
    mergeSkillsWithMeta: function () { throw new Error("no .claude dir"); },
    discoverWorkflows: function () { throw new Error("no workflows dir"); },
  };
  var result;
  assert.doesNotThrow(function () {
    result = buildEnrichedSlashCommands(["fallback-cmd"], "/fake/cwd", fns);
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "fallback-cmd");
  assert.equal(result[0].type, "builtin");
});

test("(9) no fns argument — module-level defaults used without throwing", function () {
  // Does not inject any mocks. Real discovery runs against an empty/missing dir.
  // We only verify the call doesn't throw and returns an array.
  var result;
  assert.doesNotThrow(function () {
    result = buildEnrichedSlashCommands(["builtin-a"], "/nonexistent/path");
  });
  assert.ok(Array.isArray(result));
  // "builtin-a" must appear as builtin since the cwd has no .claude/ dirs
  var found = result.find(function (r) { return r.name === "builtin-a"; });
  assert.ok(found, "builtin-a should be present");
  assert.equal(found.type, "builtin");
});
