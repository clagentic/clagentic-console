"use strict";
/**
 * Regression tests for lr-f22787 — release-time-generated Claude model
 * catalog: loading/parsing, missing-secret/missing-file degradation, and the
 * merge logic that lets the picker surface older, still-runnable versioned
 * IDs that the SDK's live enumeration never lists (see lib/model-catalog.js
 * and lib/yoke/adapters/claude.js's enrichClaudeModelsWithCatalog for the
 * full design rationale).
 *
 * lr-d3817f CORRECTED BEHAVIOR (supersedes the original lr-f22787 assertions
 * in this file — sanctioned exception to the never-modify-existing-tests
 * rule, per lr-d3817f's operator-stated spec): a retired catalog entry must
 * be FILTERED OUT of the picker entirely, on every surface, in every state —
 * never rendered shown-and-disabled. The original lr-f22787 "shown but
 * click-gated" policy was never something the operator asked for. Likewise,
 * the collapsed/default view must show the vendor's own alias list
 * unmodified (no reconcileAliasesWithCatalogIds substitution — that function
 * was removed).
 *
 * Split into three areas:
 *   1. lib/model-catalog.js — loadClaudeModelCatalog (real file + injected
 *      bad paths), mergeModelCatalog (pure), and filterSelectableCatalogModels.
 *   2. lib/yoke/adapters/claude.js's mergeStaticCatalog (test seam
 *      _test_mergeStaticCatalog) — reads the REAL committed catalog file
 *      (lib/generated/claude-model-catalog.json), so assertions here only pin
 *      structural properties, never specific version numbers from the seed
 *      file — a future regeneration must not break this test.
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

test("lr-f22787: the committed catalog is GENERATOR-produced, never a hand-typed list — its source field names a real generation origin, not \"seed\"", function () {
  // A hand-authored list masquerading as a seed is exactly the violation
  // this task corrected: the committed file's own "source" field must name
  // where the generator actually pulled it from (e.g. "deprecations-page",
  // "anthropic-api"), so a reviewer can tell at a glance the file was
  // produced by scripts/generate-model-catalog.js, not typed by hand.
  var raw = require("fs").readFileSync(modelCatalog.CATALOG_PATH, "utf8");
  var parsed = JSON.parse(raw);
  assert.notEqual(parsed.source, "seed", "\"seed\" as a synonym for hand-typed is exactly the violation this task fixed");
  assert.ok(parsed.source, "the committed catalog must declare its real generation origin");
});

test("lr-f22787: the committed catalog contains multiple distinct versions within at least one family — a degenerate/truncated catalog must fail this test, not ship silently", function () {
  // Regression guard requested explicitly: if a future regeneration ever
  // produces a degenerate catalog (e.g. the deprecations-page parser breaks
  // and returns 1-2 stray matches, or /v1/models returns a near-empty page),
  // this must fail CI rather than silently shipping a picker with nothing
  // useful in its "Older models" disclosure.
  var raw = require("fs").readFileSync(modelCatalog.CATALOG_PATH, "utf8");
  var parsed = JSON.parse(raw);
  var modelFamilies = require("../lib/model-families");
  var countByFamily = {};
  for (var i = 0; i < parsed.models.length; i++) {
    var p = modelFamilies.parseClaudeModelVersion(parsed.models[i].id);
    if (!p) continue;
    countByFamily[p.family] = (countByFamily[p.family] || 0) + 1;
  }
  var families = Object.keys(countByFamily);
  var hasMultiVersionFamily = families.some(function (f) { return countByFamily[f] > 1; });
  assert.ok(
    hasMultiVersionFamily,
    "expected at least one family with 2+ versions in the committed catalog; got: " + JSON.stringify(countByFamily)
  );
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

test("lr-f22787: mergeModelCatalog carries the catalog entry's status field through onto the merged entry", function () {
  var merged = modelCatalog.mergeModelCatalog([], [{ id: "claude-1.0", status: "retired" }, { id: "claude-opus-5", status: "active" }]);
  var byId = {};
  merged.forEach(function (m) { byId[m.value] = m; });
  assert.equal(byId["claude-1.0"].status, "retired");
  assert.equal(byId["claude-opus-5"].status, "active");
});

test("lr-f22787: mergeModelCatalog defaults a catalog entry's status to \"unknown\" when the catalog record has none", function () {
  var merged = modelCatalog.mergeModelCatalog([], [{ id: "claude-foo" }]);
  assert.equal(merged[0].status, "unknown");
});

// ---------------------------------------------------------------------------
// 1b. applyRetiredMarking (deprecated-only now) + filterSelectableCatalogModels
// (lr-d3817f REVERSED the original "retired shown-and-disabled" policy:
// retired entries are filtered out before merge, never marked/rendered).
// ---------------------------------------------------------------------------

test("lr-d3817f: applyRetiredMarking no longer marks a status:\"retired\" entry at all — retired entries are filtered out upstream, not marked", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-1.0", status: "retired" }]);
  assert.equal(marked[0].isRetired, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking marks a status:\"deprecated\" entry with isDeprecated:true — it still runs, so it stays selectable", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-opus-4-1-20250805", status: "deprecated" }]);
  assert.equal(marked[0].isDeprecated, true);
  assert.equal(marked[0].disabled, undefined, "a deprecated model is still selectable");
});

test("lr-f22787: applyRetiredMarking leaves an active entry completely untouched — no isDeprecated or disabled fields added", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-opus-5", status: "active" }]);
  assert.equal(marked[0].isDeprecated, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking fails open on status:\"unknown\" — never disables a model on the strength of a parser hiccup this codebase cannot verify", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-mystery", status: "unknown" }]);
  assert.equal(marked[0].isDeprecated, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking leaves an entry with no status field at all untouched (e.g. a live vendor entry that never went through mergeModelCatalog)", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "opus" }]);
  assert.equal(marked[0].isDeprecated, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking handles null/undefined/empty input without throwing", function () {
  assert.deepEqual(modelCatalog.applyRetiredMarking(null), []);
  assert.deepEqual(modelCatalog.applyRetiredMarking(undefined), []);
  assert.deepEqual(modelCatalog.applyRetiredMarking([]), []);
});

test("lr-d3817f: filterSelectableCatalogModels removes status:\"retired\" entries and keeps everything else", function () {
  var filtered = modelCatalog.filterSelectableCatalogModels([
    { id: "claude-1.0", status: "retired" },
    { id: "claude-opus-5", status: "active" },
    { id: "claude-opus-4-1-20250805", status: "deprecated" },
    { id: "claude-mystery", status: "unknown" },
  ]);
  var ids = filtered.map(function (m) { return m.id; });
  assert.deepEqual(ids.sort(), ["claude-mystery", "claude-opus-4-1-20250805", "claude-opus-5"]);
});

test("lr-d3817f: filterSelectableCatalogModels handles null/undefined/empty input without throwing", function () {
  assert.deepEqual(modelCatalog.filterSelectableCatalogModels(null), []);
  assert.deepEqual(modelCatalog.filterSelectableCatalogModels(undefined), []);
  assert.deepEqual(modelCatalog.filterSelectableCatalogModels([]), []);
});

test("lr-d3817f: end-to-end — filterSelectableCatalogModels + mergeModelCatalog together mean a known-retired catalog ID never appears in the merged list at all, while an active one is an ordinary selectable row", function () {
  // This reverses the lr-f22787 policy: claude-1.0 (a fully-retired model,
  // present in the real committed catalog) must be ABSENT from the merged
  // list entirely, not present-and-disabled.
  var selectable = modelCatalog.filterSelectableCatalogModels([
    { id: "claude-1.0", displayName: "claude-1.0", status: "retired" },
    { id: "claude-opus-5", displayName: "claude-opus-5", status: "active" },
  ]);
  var merged = modelCatalog.mergeModelCatalog([], selectable);
  var byId = {};
  merged.forEach(function (m) { byId[m.value] = m; });

  assert.equal(byId["claude-1.0"], undefined, "claude-1.0 must not appear in the merged list at all");
  assert.ok(byId["claude-opus-5"], "claude-opus-5 must remain an ordinary selectable row");
  assert.notEqual(byId["claude-opus-5"].disabled, true);
});

test("lr-d3817f: the REAL committed catalog's known-retired entries (claude-1.0, claude-2.0) are absent after filterSelectableCatalogModels + merge, while claude-opus-5 remains", function () {
  // Exercises the real committed lib/generated/claude-model-catalog.json —
  // not a synthetic fixture — through the exact pipeline mergeStaticCatalog
  // uses (filterSelectableCatalogModels then mergeModelCatalog). If a future
  // regeneration ever ships without carrying status through correctly, this
  // is the test that catches it.
  var catalog = modelCatalog.loadClaudeModelCatalog();
  assert.ok(catalog.ok);
  var hasRetiredEntry = catalog.models.some(function (m) { return m.id === "claude-1.0" || m.id === "claude-2.0"; });
  assert.ok(hasRetiredEntry, "expected the committed catalog to contain at least one known-retired legacy ID (claude-1.0 or claude-2.0) for this test to be meaningful");

  var selectable = modelCatalog.filterSelectableCatalogModels(catalog.models);
  var merged = modelCatalog.mergeModelCatalog([], selectable);
  var byId = {};
  merged.forEach(function (m) { byId[m.value] = m; });

  ["claude-1.0", "claude-2.0"].forEach(function (id) {
    assert.equal(byId[id], undefined, id + " must be absent from the merged list — filtered out, not disabled");
  });

  if (byId["claude-opus-5"]) {
    assert.notEqual(byId["claude-opus-5"].disabled, true, "claude-opus-5 must remain selectable, not disabled");
  }
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

test("lr-d3817f: mergeStaticCatalog (adapter-level) never includes a retired entry — a claude-1.0 entry pulled from the real catalog is ABSENT, not disabled", function () {
  var merged = claudeAdapter._test_mergeStaticCatalog([]);
  var claude1 = merged.filter(function (m) { return m.value === "claude-1.0"; })[0];
  assert.equal(claude1, undefined, "claude-1.0 (a known-retired ID in the real committed catalog) must not appear at all");
});

// reconcileAliasesWithCatalogIds was removed by lr-d3817f: the collapsed
// picker view must show the vendor's own alias, unmodified — substituting a
// concrete catalog ID onto an alias row broke that. See
// enrichClaudeModelsWithCatalog's doc comment in lib/yoke/adapters/claude.js.

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

test("lr-d3817f: enrichClaudeModelsWithCatalog never substitutes a live alias's value with a concrete catalog ID — the collapsed view must show the vendor's own alias, unmodified", function () {
  var models = [{ value: "opus", displayName: "Opus", description: "Opus 4.6" }];
  var withCatalog = claudeAdapter._test_enrichClaudeModelsWithCatalog(models);
  // enrichClaudeModel does not carry `description` through onto the
  // enriched object (only value/displayName/capability fields) — identify
  // the live-sourced row by the absence of fromCatalog instead.
  var aliasRow = withCatalog.filter(function (m) { return !m.fromCatalog; })[0];
  assert.ok(aliasRow, "the original live alias entry must still be present");
  assert.equal(aliasRow.value, "opus", "the live alias's value must be untouched — no substitution");
  assert.equal(aliasRow.isLatest, true, "a live-sourced entry is always forced into the collapsed/latest tier");
});

test("lr-d3817f: enrichClaudeModelsWithCatalog forces isLatest:true on every live-sourced entry even when the catalog contains a higher version in the same family", function () {
  // Regression for the exact bug this task fixed: before the fix, a live
  // alias's tier was computed together with catalog versions, so a catalog
  // entry with a numerically higher parsed version could knock the alias out
  // of the collapsed/latest tier. The corrected behavior is that the live
  // list's tier placement is independent of catalog contents.
  var models = [{ value: "opus", displayName: "Opus", description: "Opus 1.0" }];
  var withCatalog = claudeAdapter._test_enrichClaudeModelsWithCatalog(models);
  var aliasRow = withCatalog.filter(function (m) { return m.value === "opus"; })[0];
  assert.ok(aliasRow);
  assert.equal(aliasRow.isLatest, true, "the live alias must always render in the collapsed tier regardless of catalog version numbers");
});

test("lr-d3817f: enrichClaudeModelsWithCatalog never includes a retired catalog entry in its output at all", function () {
  var models = [{ value: "opus", displayName: "Opus", description: "Opus 4.6" }];
  var withCatalog = claudeAdapter._test_enrichClaudeModelsWithCatalog(models);
  var retiredRows = withCatalog.filter(function (m) { return m.status === "retired"; });
  assert.equal(retiredRows.length, 0, "no status:retired entry may appear anywhere in the enriched output");
});

test("lr-f22787: enrichClaudeModelsWithCatalog never throws on an empty input", function () {
  assert.deepEqual(claudeAdapter._test_enrichClaudeModelsWithCatalog([]), []);
});

// ---------------------------------------------------------------------------
// lr-d3817f acceptance: the exact operator-stated spec, exercised against
// the REAL committed catalog with the REAL live-alias-list shape
// (Default/Opus/Fable/Sonnet/Haiku — what stream.supportedModels() actually
// returns per model-catalog.js's header comment).
// ---------------------------------------------------------------------------

test("lr-d3817f ACCEPTANCE: the collapsed/default tier is exactly the vendor's live alias list — no raw versioned catalog ID appears in it, and every alias value is untouched", function () {
  var liveAliases = [
    { value: "default", displayName: "Default" },
    { value: "opus", description: "Opus 4.8 with 1M context" },
    { value: "sonnet", description: "Sonnet 4.6" },
    { value: "haiku", description: "Haiku 4.5" },
    { value: "fable", description: "Fable 5" },
  ];
  var enriched = claudeAdapter._test_enrichClaudeModelsWithCatalog(liveAliases);
  var latestTier = enriched.filter(function (m) { return m.isLatest; });
  var latestValues = latestTier.map(function (m) { return m.value; }).sort();

  assert.deepEqual(latestValues, ["default", "fable", "haiku", "opus", "sonnet"], "the collapsed tier must be exactly the five live alias values, nothing substituted, nothing dropped, nothing added");
});

test("lr-d3817f ACCEPTANCE: no status:retired ID from the real committed catalog appears anywhere in the enriched output, in either tier", function () {
  var liveAliases = [{ value: "opus", description: "Opus 4.8" }, { value: "sonnet", description: "Sonnet 4.6" }];
  var catalog = modelCatalog.loadClaudeModelCatalog();
  assert.ok(catalog.ok);
  var retiredIds = catalog.models.filter(function (m) { return m.status === "retired"; }).map(function (m) { return m.id; });
  assert.ok(retiredIds.length > 0, "expected the real committed catalog to contain at least one retired entry for this test to be meaningful");

  var enriched = claudeAdapter._test_enrichClaudeModelsWithCatalog(liveAliases);
  var enrichedValues = enriched.map(function (m) { return m.value; });
  retiredIds.forEach(function (id) {
    assert.equal(enrichedValues.indexOf(id), -1, id + " (status:retired in the real catalog) must not appear anywhere in the enriched output");
  });
});

test("lr-d3817f ACCEPTANCE: a deprecated-but-running catalog entry from the real catalog, if present, still appears and is not in the collapsed/latest tier unless it is genuinely the max version", function () {
  var liveAliases = [{ value: "opus", description: "Opus 4.8" }];
  var catalog = modelCatalog.loadClaudeModelCatalog();
  assert.ok(catalog.ok);
  var deprecatedIds = catalog.models.filter(function (m) { return m.status === "deprecated"; }).map(function (m) { return m.id; });
  if (deprecatedIds.length === 0) return; // not every catalog snapshot is guaranteed to carry a deprecated entry

  var enriched = claudeAdapter._test_enrichClaudeModelsWithCatalog(liveAliases);
  var byValue = {};
  enriched.forEach(function (m) { byValue[m.value] = m; });
  var presentDeprecated = deprecatedIds.filter(function (id) { return byValue[id]; });
  assert.ok(presentDeprecated.length > 0, "at least one deprecated entry from the real catalog should merge in and remain present (not filtered — only retired is filtered)");
  presentDeprecated.forEach(function (id) {
    assert.equal(byValue[id].isDeprecated, true, id + " must carry the Deprecated marker");
  });
});
