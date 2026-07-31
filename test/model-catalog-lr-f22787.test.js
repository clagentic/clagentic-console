"use strict";
/**
 * Regression tests for lr-f22787 — release-time-generated Claude model
 * catalog: loading/parsing, missing-secret/missing-file degradation, and the
 * merge + alias-reconciliation logic that lets the picker surface older,
 * still-runnable versioned IDs that the SDK's live enumeration never lists
 * (see lib/model-catalog.js and lib/yoke/adapters/claude.js's
 * enrichClaudeModelsWithCatalog for the full design rationale).
 *
 * Split into three areas:
 *   1. lib/model-catalog.js — loadClaudeModelCatalog (real file + injected
 *      bad paths) and mergeModelCatalog (pure).
 *   2. lib/yoke/adapters/claude.js's mergeStaticCatalog +
 *      reconcileAliasesWithCatalogIds (test seams _test_mergeStaticCatalog /
 *      _test_reconcileAliasesWithCatalogIds) — these read the REAL committed
 *      catalog file (lib/generated/claude-model-catalog.json), so assertions
 *      here only pin structural properties (catalog entries get merged in,
 *      an alias resolves to a concrete ID when one matches), never specific
 *      version numbers from the seed file — a future regeneration must not
 *      break this test.
 *   3. enrichClaudeModelsWithCatalog end-to-end (the real adapter-facing
 *      entry point) vs. the pure enrichClaudeModels (must NOT merge catalog
 *      data) — pins the split that fixed the lr-e03635/lr-af9d66/lr-5c07ce
 *      regressions this task's first pass introduced.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var modelCatalog = require("../lib/model-catalog");
var claudeAdapter = require("../lib/yoke/adapters/claude");

// ---------------------------------------------------------------------------
// 1. loadClaudeModelCatalog / mergeModelCatalog (pure, lib/model-catalog.js)
// ---------------------------------------------------------------------------

test("lr-f22787: loadClaudeModelCatalog reads the real committed seed/generated catalog and returns ok:true with a non-empty models array", function () {
  var result = modelCatalog.loadClaudeModelCatalog();
  assert.equal(result.ok, true, "the committed catalog file must exist and parse — the picker must never regress to an empty catalog");
  assert.ok(Array.isArray(result.models));
  assert.ok(result.models.length > 0, "catalog must never be empty per PR body point (b)");
  for (var i = 0; i < result.models.length; i++) {
    assert.equal(typeof result.models[i].id, "string");
    assert.ok(result.models[i].id.length > 0);
  }
});

test("lr-f22787: CATALOG_PATH points at lib/generated/claude-model-catalog.json (ships under package.json's \"files\": [\"lib/\"])", function () {
  assert.equal(modelCatalog.CATALOG_PATH, path.join(__dirname, "..", "lib", "generated", "claude-model-catalog.json"));
});

test("lr-f22787: mergeModelCatalog appends catalog entries not already present in the live list", function () {
  var live = [{ value: "opus", displayName: "Opus" }];
  var catalog = [
    { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    { id: "claude-opus-4", displayName: "Claude Opus 4" },
  ];
  var merged = modelCatalog.mergeModelCatalog(live, catalog);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].value, "opus", "live entries come first, unchanged");
  var mergedIds = merged.slice(1).map(function (m) { return m.value; });
  assert.deepEqual(mergedIds.sort(), ["claude-opus-4", "claude-opus-4-5"]);
});

test("lr-f22787: mergeModelCatalog never duplicates a catalog entry whose id already appears live (by value)", function () {
  var live = [{ value: "claude-opus-4-5", displayName: "Opus 4.5 (live)" }];
  var catalog = [{ id: "claude-opus-4-5", displayName: "Opus 4.5 (catalog)" }];
  var merged = modelCatalog.mergeModelCatalog(live, catalog);
  assert.equal(merged.length, 1, "an id already present live must not be duplicated from the catalog");
  assert.equal(merged[0].displayName, "Opus 4.5 (live)", "the live entry wins, never overwritten by a catalog duplicate");
});

test("lr-f22787: mergeModelCatalog tags every catalog-sourced entry with fromCatalog:true, and live entries are never tagged", function () {
  var live = ["sonnet"];
  var catalog = [{ id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" }];
  var merged = modelCatalog.mergeModelCatalog(live, catalog);
  assert.equal(merged[0].fromCatalog, undefined, "a live string entry is untouched, never tagged");
  assert.equal(merged[1].fromCatalog, true, "a catalog-only entry must be marked so the picker can show a non-blocking marker (PR body point c)");
});

test("lr-f22787: mergeModelCatalog handles an empty live list — every catalog entry is appended, none skipped", function () {
  var merged = modelCatalog.mergeModelCatalog([], [{ id: "claude-haiku-4-5" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "claude-haiku-4-5");
});

test("lr-f22787: mergeModelCatalog handles null/undefined live and catalog args without throwing", function () {
  assert.deepEqual(modelCatalog.mergeModelCatalog(null, null), []);
  assert.deepEqual(modelCatalog.mergeModelCatalog(undefined, undefined), []);
  assert.deepEqual(modelCatalog.mergeModelCatalog([], null), []);
});

// ---------------------------------------------------------------------------
// 2. mergeStaticCatalog / reconcileAliasesWithCatalogIds (claude.js seams)
// ---------------------------------------------------------------------------

test("lr-f22787: mergeStaticCatalog (adapter-level) merges the real committed catalog into a live list without throwing", function () {
  var live = [{ value: "opus", displayName: "Opus", description: "Opus test description" }];
  var merged = claudeAdapter._test_mergeStaticCatalog(live);
  assert.ok(Array.isArray(merged));
  assert.ok(merged.length >= live.length, "merging can only add entries, never remove the live ones");
  assert.equal(merged[0].value, "opus");
});

test("lr-f22787: reconcileAliasesWithCatalogIds substitutes a bare alias's value with a concrete catalog ID when family+version (from description) match exactly", function () {
  var models = [
    { value: "opus", description: "Opus 4.6" },
    { value: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  ];
  var reconciled = claudeAdapter._test_reconcileAliasesWithCatalogIds(models);
  var aliasEntry = reconciled.filter(function (m) { return m.description === "Opus 4.6"; })[0];
  assert.ok(aliasEntry, "the original alias entry must still be present (substituted in place, not dropped)");
  assert.equal(aliasEntry.value, "claude-opus-4-6", "clicking this row must now send the pinned concrete ID, not the bare alias");
});

test("lr-f22787: reconcileAliasesWithCatalogIds leaves a bare alias untouched when no concrete ID matches its description's family+version", function () {
  var models = [{ value: "opus", description: "Opus 99.9" }];
  var reconciled = claudeAdapter._test_reconcileAliasesWithCatalogIds(models);
  assert.equal(reconciled[0].value, "opus", "no matching concrete ID exists — the alias must be left selectable as-is, never dropped");
});

test("lr-f22787: reconcileAliasesWithCatalogIds never touches an entry that is already a concrete versioned ID", function () {
  var models = [{ value: "claude-opus-4-6", description: "Opus 4.6" }];
  var reconciled = claudeAdapter._test_reconcileAliasesWithCatalogIds(models);
  assert.equal(reconciled[0].value, "claude-opus-4-6");
});

test("lr-f22787: reconcileAliasesWithCatalogIds handles plain string entries (no description) without throwing", function () {
  var models = ["opus", "sonnet", "claude-opus-4-6"];
  var reconciled = claudeAdapter._test_reconcileAliasesWithCatalogIds(models);
  assert.equal(reconciled.length, 3);
});

// ---------------------------------------------------------------------------
// 3. enrichClaudeModelsWithCatalog (real path) vs enrichClaudeModels (pure)
// ---------------------------------------------------------------------------

test("lr-f22787: enrichClaudeModels (pure) is UNAFFECTED by the committed catalog file — closed-world synthetic lists stay closed-world", function () {
  // This is the regression this task's own first pass introduced and then
  // fixed: enrichClaudeModels must never silently merge in filesystem-backed
  // catalog data, or every existing lr-e03635/lr-af9d66/lr-5c07ce test that
  // passes a small synthetic list and asserts on that EXACT set would break
  // whenever the committed catalog file's contents change.
  var models = ["claude-opus-4-6", "claude-opus-4"];
  var enriched = claudeAdapter._test_enrichClaudeModels(models);
  assert.equal(enriched.length, 2, "no catalog entries may be merged in by the pure function");
});

test("lr-f22787: enrichClaudeModelsWithCatalog (real adapter path) merges catalog entries, producing a superset of the pure function's output for the same alias-only input", function () {
  var models = [{ value: "opus", displayName: "Opus", description: "Opus 4.6" }];
  var pure = claudeAdapter._test_enrichClaudeModels(models);
  var withCatalog = claudeAdapter._test_enrichClaudeModelsWithCatalog(models);
  assert.ok(withCatalog.length >= pure.length, "the catalog-aware path must never return FEWER selectable rows than the pure path");
});

test("lr-f22787: enrichClaudeModelsWithCatalog output includes a fromCatalog:true entry when the catalog supplies an ID not present live", function () {
  var models = [{ value: "opus", displayName: "Opus", description: "Opus 4.6" }];
  var withCatalog = claudeAdapter._test_enrichClaudeModelsWithCatalog(models);
  var catalogRows = withCatalog.filter(function (m) { return m.fromCatalog; });
  assert.ok(catalogRows.length > 0, "at least one catalog-sourced row must be present so the picker's older-versions disclosure has something to show");
  for (var i = 0; i < catalogRows.length; i++) {
    // Every catalog-sourced row must still be fully enriched (isLatest,
    // displayName, supportsThinking, etc.) — same pipeline as live entries.
    assert.equal(typeof catalogRows[i].isLatest, "boolean");
    assert.equal(typeof catalogRows[i].displayName, "string");
  }
});

test("lr-f22787: enrichClaudeModelsWithCatalog never throws on an empty input", function () {
  assert.deepEqual(claudeAdapter._test_enrichClaudeModelsWithCatalog([]), []);
});
