// Regression tests for lr-5c07ce — alias-only Claude model lists degrading
// tiering/display to a no-op, and "fable" being unknown to family detection.
//
// Empirically confirmed (test/claude-model-capability-lr-af9d66.test.js's
// LIVE_PROBE_MODELS, captured from a live claude-agent-sdk 0.3.173 CLI
// session): stream.supportedModels() reports opus/sonnet/haiku/default as
// bare aliases with NO version digits in `value` (e.g. value: "sonnet"), but
// each entry also carries a `description` field with the real version text
// (e.g. "Sonnet 4.6", "Opus 4.8 with 1M context"). Fable's `value` happens to
// already be a real versioned ID ("claude-fable-5[1m]").
//
// Before this fix: parseClaudeModelVersion("sonnet") parsed family=sonnet,
// version=[] (no digits), parseClaudeModelVersion("fable") returned null
// (fable absent from CLAUDE_MODEL_FAMILIES) — every alias-only entry ended up
// isLatest:true with no way to distinguish an older release, silently
// disabling the "Older models" disclosure network-wide even when the vendor
// DID have real version info available via `description`.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var modelFamilies = require("../lib/model-families");
var claudeAdapter = require("../lib/yoke/adapters/claude");
var enrichClaudeModel = claudeAdapter._test_enrichClaudeModel;
var enrichClaudeModels = claudeAdapter._test_enrichClaudeModels;

// The exact alias-only shape Andy's picker showed (lr-5c07ce report): every
// family present exactly once, no versioned IDs anywhere.
var ALIAS_ONLY_MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 4.8 with 1M context" },
  { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5" },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 4.6" },
  { value: "haiku", displayName: "Haiku", description: "Haiku 4.5" },
];

test("lr-5c07ce: fable is a recognized family (CLAUDE_MODEL_FAMILIES)", function () {
  assert.ok(modelFamilies.CLAUDE_MODEL_FAMILIES.indexOf("fable") !== -1);
});

test("lr-5c07ce: parseClaudeModelVersion on a bare alias with no description still returns family with an empty version (unchanged prior behavior)", function () {
  var parsed = modelFamilies.parseClaudeModelVersion("sonnet");
  assert.equal(parsed.family, "sonnet");
  assert.deepEqual(parsed.version, []);
});

test("lr-5c07ce: parseClaudeModelVersion recovers version digits from description when the alias itself has none", function () {
  var parsed = modelFamilies.parseClaudeModelVersion("sonnet", "Sonnet 4.6");
  assert.equal(parsed.family, "sonnet");
  assert.deepEqual(parsed.version, [4, 6]);
});

test("lr-5c07ce: description is ignored when the alias/ID already carries its own version digits", function () {
  // A real versioned ID must never be overridden by an unrelated description.
  var parsed = modelFamilies.parseClaudeModelVersion("claude-opus-4-5", "Opus 4.8 with 1M context");
  assert.deepEqual(parsed.version, [4, 5], "the ID's own version wins over description");
});

test("lr-5c07ce: description belonging to a different family is never cross-applied", function () {
  var parsed = modelFamilies.parseClaudeModelVersion("sonnet", "Opus 4.8 with 1M context");
  assert.equal(parsed.family, "sonnet");
  assert.deepEqual(parsed.version, [], "mismatched-family description must not leak its version in");
});

test("lr-5c07ce: claudeDisplayName renders a real version for an alias-only model via description", function () {
  assert.equal(modelFamilies.claudeDisplayName("sonnet", "Sonnet 4.6"), "Sonnet 4.6");
  assert.equal(modelFamilies.claudeDisplayName("opus", "Opus 4.8 with 1M context"), "Opus 4.8");
});

test("lr-5c07ce: deriveClaudeLatestTiers on the live alias-only probe shape ties every lone-family alias to isLatest:true (nothing older to compare against)", function () {
  var tiers = modelFamilies.deriveClaudeLatestTiers(ALIAS_ONLY_MODELS);
  assert.equal(tiers["sonnet"], true);
  assert.equal(tiers["haiku"], true);
  assert.equal(tiers["default"], true);
  assert.equal(tiers["claude-fable-5[1m]"], true);
});

test("lr-5c07ce: deriveClaudeLatestTiers correctly demotes an older alias-shaped entry once description reveals its real version is behind a versioned sibling", function () {
  // Simulates a hypothetical future list where an alias and a pinned older
  // versioned ID for the same family coexist — the exact shape "Older
  // models" tiering exists to distinguish.
  var models = [
    { value: "sonnet", description: "Sonnet 4.6" },
    { value: "claude-sonnet-4-5", description: "Sonnet 4.5 (legacy)" },
  ];
  var tiers = modelFamilies.deriveClaudeLatestTiers(models);
  assert.equal(tiers["sonnet"], true, "4.6 (via description) is the higher version");
  assert.equal(tiers["claude-sonnet-4-5"], false, "4.5 is older and must be tiered as such");
});

test("lr-5c07ce: enrichClaudeModels on the live alias-only probe shape never throws and preserves fable's own versioned value untouched", function () {
  var enriched = enrichClaudeModels(ALIAS_ONLY_MODELS);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m; });
  assert.equal(byValue["claude-fable-5[1m]"].isLatest, true);
  assert.equal(byValue["sonnet"].isLatest, true);
});

test("lr-5c07ce: enrichClaudeModel falls back to a version-bearing display name via description when the vendor omits displayName entirely", function () {
  var enriched = enrichClaudeModel({ value: "opus", description: "Opus 4.8 with 1M context" });
  assert.equal(enriched.displayName, "Opus 4.8");
});
