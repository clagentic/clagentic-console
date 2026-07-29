// Regression tests for lr-e03635 — Claude-side latest/older model tiering.
//
// Claude reports raw model ID strings with no latest/legacy signal from the
// SDK, unlike Codex's model/list "upgrade" field. deriveClaudeLatestTiers()/
// enrichClaudeModels() (lib/yoke/adapters/claude.js) derive isLatest purely
// from the ID pattern — family substring + numeric version-ordering — with
// NO hardcoded model IDs or names. A new model release landing with a higher
// version number (or a brand-new family) must land in the latest tier with
// zero code changes here; these tests assert that property directly rather
// than pinning specific model names.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var enrichClaudeModels = claudeAdapter._test_enrichClaudeModels;
var deriveClaudeLatestTiers = claudeAdapter._test_deriveClaudeLatestTiers;

test("lr-e03635: within a family, only the highest version is isLatest — older versions are not", function () {
  var models = ["claude-opus-4-6", "claude-opus-4-5", "claude-opus-4"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["claude-opus-4-6"], true, "highest version in family must be latest");
  assert.equal(byValue["claude-opus-4-5"], false);
  assert.equal(byValue["claude-opus-4"], false);
});

test("lr-e03635: each family is tiered independently — sonnet's latest doesn't suppress opus's latest", function () {
  var models = ["claude-opus-4-6", "claude-opus-4", "claude-sonnet-4-5", "claude-sonnet-4"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["claude-opus-4-6"], true);
  assert.equal(byValue["claude-sonnet-4-5"], true);
  assert.equal(byValue["claude-opus-4"], false);
  assert.equal(byValue["claude-sonnet-4"], false);
});

test("lr-e03635: a lone model in its family is always latest (nothing to be older than)", function () {
  var models = ["claude-haiku-3-5"];
  var enriched = enrichClaudeModels(models);
  assert.equal(enriched[0].isLatest, true);
});

test("lr-e03635: acceptance criterion — a brand-new higher version lands in latest tier with zero code changes", function () {
  // Simulates a hypothetical future release: no hardcoded ID for this string
  // exists anywhere in claude.js, yet it must still be correctly tiered
  // above known older versions purely from numeric ordering.
  var models = ["claude-opus-4-6", "claude-opus-9-9", "claude-opus-4"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["claude-opus-9-9"], true, "higher unseen version must be latest");
  assert.equal(byValue["claude-opus-4-6"], false);
  assert.equal(byValue["claude-opus-4"], false);
});

test("lr-e03635: date-stamped IDs are parsed as version, not thrown off by the trailing date", function () {
  var models = ["claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["claude-sonnet-4-5-20250929"], true);
  assert.equal(byValue["claude-sonnet-4-20250514"], false);
});

test("lr-e03635: [1m] beta suffix does not affect version parsing/tiering", function () {
  var models = ["claude-opus-4-6[1m]", "claude-opus-4"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["claude-opus-4-6[1m]"], true);
  assert.equal(byValue["claude-opus-4"], false);
});

test("lr-e03635: an unparseable ID (no known family substring) is never hidden — defaults to latest", function () {
  var models = ["default", "claude-opus-4-6", "claude-opus-4"];
  var enriched = enrichClaudeModels(models);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m.isLatest; });

  assert.equal(byValue["default"], true, "unparseable IDs must never be tiered as older");
});

test("lr-e03635: deriveClaudeLatestTiers returns a map keyed by raw value", function () {
  var tiers = deriveClaudeLatestTiers(["claude-opus-4-6", "claude-opus-4"]);
  assert.equal(tiers["claude-opus-4-6"], true);
  assert.equal(tiers["claude-opus-4"], false);
});

test("lr-e03635: enrichClaudeModels preserves an explicitly pre-set isLatest on object passthrough", function () {
  var models = [{ value: "claude-opus-4", isLatest: true }];
  var enriched = enrichClaudeModels(models);
  assert.equal(enriched[0].isLatest, true);
});
