// The history runner builds the child environment for each harness run. A
// renamed variable must be cleared under both its scoped and its un-scoped name,
// or an inherited value of either leaks into a run meant to use this checkout.

var test = require("node:test");
var assert = require("node:assert");
var { harnessEnv } = require("../scripts/prompt-harness-history");

var INHERITED = {
  PATH: "/bin",
  CLAGENTIC_PROMPT_HARNESS_LIB: "/stale/legacy",
  CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB: "/stale/scoped",
};

test("a HEAD run clears both the scoped and the un-scoped harness lib variable", function () {
  var env = harnessEnv(INHERITED, null);
  assert.strictEqual(env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB, undefined);
  assert.strictEqual(env.CLAGENTIC_PROMPT_HARNESS_LIB, undefined);
  assert.strictEqual(env.PATH, "/bin");
});

test("a run against an older lib sets only the scoped variable, replacing any inherited value", function () {
  var env = harnessEnv(INHERITED, "/old/lib");
  assert.strictEqual(env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB, "/old/lib");
  assert.strictEqual(env.CLAGENTIC_PROMPT_HARNESS_LIB, undefined);
});

test("the caller's environment object is not mutated", function () {
  harnessEnv(INHERITED, null);
  assert.strictEqual(INHERITED.CLAGENTIC_PROMPT_HARNESS_LIB, "/stale/legacy");
});
