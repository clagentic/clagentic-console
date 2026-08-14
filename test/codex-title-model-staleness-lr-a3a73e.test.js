// Regression test for lr-a3a73e — generateTitle() hardcoded model:
// "gpt-5.4-mini" as a bare version-pinned literal. When OpenAI retires that
// snapshot, auto-title generation breaks silently even though the user's
// selected model keeps working.
//
// _defaultModel is the adapter's only non-staling model identifier: seeded
// with a fallback value and then refreshed from the live "model/list" RPC
// response (see codex.js). The live catalog's Model objects carry no
// cost-tier signal (only value/displayName/supportedEffortLevels/isLatest),
// so there is no robust way to pick a cheaper mini-tier model without
// resorting to fragile substring matching on displayName/value — the exact
// pattern this codebase deliberately removed elsewhere (see the Context
// meter section of docs/guides/architecture.md). resolveTitleModel()
// therefore falls back to _defaultModel; this is a deliberate cost tradeoff
// (titling now runs on the user's main model) traded for never breaking
// silently on model retirement. See the PR body for the full reasoning.
//
// Imports the real resolveTitleModel (exported as _test_resolveTitleModel)
// rather than reimplementing a copy, so reintroducing a bare version-pinned
// literal at the generateTitle call site breaks this test.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");
var resolveTitleModel = codexAdapter._test_resolveTitleModel;

test("lr-a3a73e: resolveTitleModel never returns a bare version-pinned mini literal", function () {
  var model = resolveTitleModel("gpt-5.5");
  assert.notEqual(model, "gpt-5.4-mini");
  assert.equal(model, "gpt-5.5");
});

test("lr-a3a73e: resolveTitleModel tracks whatever the live model/list response resolved as the default", function () {
  // _defaultModel is refreshed from model/list's isDefault entry at init
  // time (codex.js) — simulate that having picked a different model.
  assert.equal(resolveTitleModel("gpt-5.6"), "gpt-5.6");
});

test("lr-a3a73e: resolveTitleModel degrades sensibly when the live catalog / default is unavailable", function () {
  // Catalog-unavailable fallback: _defaultModel itself falls back to
  // "gpt-5.5" when model/list never succeeded (see codex.js init()).
  // resolveTitleModel must never throw or return an empty/undefined model
  // in that case either.
  assert.equal(resolveTitleModel(undefined), "gpt-5.5");
  assert.equal(resolveTitleModel(null), "gpt-5.5");
  assert.equal(resolveTitleModel(""), "gpt-5.5");
});
