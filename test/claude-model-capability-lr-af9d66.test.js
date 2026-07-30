// Regression tests for lr-af9d66 — Claude vendor-reported model capability.
//
// stream.supportedModels() (SDK >=0.3.x) returns rich ModelInfo objects, not
// bare ID strings as an earlier comment in claude.js claimed. Verified
// directly against the live CLI (claude-agent-sdk 0.3.173): the vendor's
// real field name for thinking support is "supportsAdaptiveThinking", not
// "supportsThinking" — the field-name mismatch is what made the existing
// hasOwnProperty guard unreachable in practice, not the object/string
// branch split itself. These tests pin the real wire shape (captured from a
// live probe against the running CLI) so a future SDK regression is caught.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var enrichClaudeModel = claudeAdapter._test_enrichClaudeModel;
var enrichClaudeModels = claudeAdapter._test_enrichClaudeModels;

// Real shape captured from `stream.supportedModels()` against a live CLI
// session (claude-agent-sdk 0.3.173 / claudeCodeVersion 2.1.173). fable is
// the concrete "family the code has never seen" case (lr-af9d66) — it does
// not appear in CLAUDE_MODEL_FAMILIES and never should (see model-families.js
// header + lib/model-families.js:29 comment).
var LIVE_PROBE_MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 4.8 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5[1m]",
    displayName: "Fable",
    description: "Fable 5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet 4.6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5",
    // No supportsEffort/supportedEffortLevels/supportsAdaptiveThinking keys
    // at all — the vendor is silent, not reporting false.
  },
];

test("lr-af9d66: vendor-reported supportsAdaptiveThinking wins and is translated to supportsThinking", function () {
  var enriched = enrichClaudeModel(LIVE_PROBE_MODELS[0]); // "default", supportsAdaptiveThinking: true
  assert.equal(enriched.supportsThinking, true);
});

test("lr-af9d66: vendor-reported supportsEffort wins outright (field names already matched)", function () {
  var enriched = enrichClaudeModel(LIVE_PROBE_MODELS[2]); // sonnet
  assert.equal(enriched.supportsEffort, true);
});

test("lr-af9d66: vendor-reported supportedEffortLevels subset wins over the static 5-level fallback", function () {
  var enriched = enrichClaudeModel(LIVE_PROBE_MODELS[2]); // sonnet: 4 levels, no xhigh
  assert.deepEqual(enriched.supportedEffortLevels, ["low", "medium", "high", "max"]);
});

test("lr-af9d66: fable (a family CLAUDE_MODEL_FAMILIES has never seen) gets real vendor capability, not the haiku-only heuristic", function () {
  var enriched = enrichClaudeModel(LIVE_PROBE_MODELS[1]); // fable
  assert.equal(enriched.supportsThinking, true, "vendor said supportsAdaptiveThinking: true");
  assert.equal(enriched.supportsEffort, true, "vendor said supportsEffort: true");
  assert.deepEqual(enriched.supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
});

test("lr-af9d66: when the vendor is silent on a capability (haiku today), the family heuristic is the documented fallback, not a hidden default", function () {
  var enriched = enrichClaudeModel(LIVE_PROBE_MODELS[3]); // haiku, no capability keys at all
  // haiku heuristic (model-families.js) returns false for both — this
  // happens to agree with reality, but the point of this test is that the
  // fallback path (not a vendor-reported field) is what produced it.
  assert.equal(enriched.supportsThinking, false);
  assert.equal(enriched.supportsEffort, false);
  assert.deepEqual(enriched.supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"], "no reported levels -> static fallback table");
});

test("lr-af9d66: acceptance — a family the code has never seen renders capability from vendor data, never from a haiku-only substring check", function () {
  // Simulates a brand-new tier appearing with no vendor thinking/effort keys
  // at all (vendor genuinely silent, not just untranslated). isClaudeFamily
  // substring match cannot recognize "zephyr" and must fall open to true —
  // proving the fallback is fail-open by design, not accidentally so.
  var unseenFamily = { value: "claude-zephyr-1" };
  var enriched = enrichClaudeModel(unseenFamily);
  assert.equal(enriched.supportsThinking, true, "fail-open: unrecognized family defaults to supported, not silently dropped");
  assert.equal(enriched.supportsEffort, true);
});

test("lr-af9d66: backward-compat — a vendor build that still sends the literal field name 'supportsThinking' is honored directly", function () {
  var enriched = enrichClaudeModel({ value: "claude-opus-4-6", supportsThinking: false });
  assert.equal(enriched.supportsThinking, false);
});

test("lr-af9d66: full live-probe list enriches without throwing and preserves per-model distinctions", function () {
  var enriched = enrichClaudeModels(LIVE_PROBE_MODELS);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m; });

  assert.equal(byValue["haiku"].supportsThinking, false);
  assert.equal(byValue["sonnet"].supportsThinking, true);
  assert.equal(byValue["claude-fable-5[1m]"].supportsThinking, true);
  assert.deepEqual(byValue["sonnet"].supportedEffortLevels, ["low", "medium", "high", "max"]);
  assert.deepEqual(byValue["claude-fable-5[1m]"].supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
});
