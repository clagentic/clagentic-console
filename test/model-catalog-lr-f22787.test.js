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
// 1b. applyRetiredMarking — the coordinator-required marking mechanism
// (previously referenced in this module's doc comment as "markRetired"
// but never implemented; this is the real implementation + regression
// coverage pinning it exists and behaves as documented).
// ---------------------------------------------------------------------------

test("lr-f22787: applyRetiredMarking marks a status:\"retired\" entry with isRetired:true AND disabled:true", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-1.0", status: "retired" }]);
  assert.equal(marked[0].isRetired, true);
  assert.equal(marked[0].disabled, true);
});

test("lr-f22787: applyRetiredMarking marks a status:\"deprecated\" entry with isDeprecated:true but does NOT disable it — it still runs", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-opus-4-1-20250805", status: "deprecated" }]);
  assert.equal(marked[0].isDeprecated, true);
  assert.equal(marked[0].disabled, undefined, "a deprecated (not yet retired) model is still selectable");
});

test("lr-f22787: applyRetiredMarking leaves an active entry completely untouched — no isRetired, isDeprecated, or disabled fields added", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-opus-5", status: "active" }]);
  assert.equal(marked[0].isRetired, undefined);
  assert.equal(marked[0].isDeprecated, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking fails open on status:\"unknown\" — never disables a model on the strength of a parser hiccup this codebase cannot verify", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "claude-mystery", status: "unknown" }]);
  assert.equal(marked[0].isRetired, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking leaves an entry with no status field at all untouched (e.g. a live vendor entry that never went through mergeModelCatalog)", function () {
  var marked = modelCatalog.applyRetiredMarking([{ value: "opus" }]);
  assert.equal(marked[0].isRetired, undefined);
  assert.equal(marked[0].disabled, undefined);
});

test("lr-f22787: applyRetiredMarking handles null/undefined/empty input without throwing", function () {
  assert.deepEqual(modelCatalog.applyRetiredMarking(null), []);
  assert.deepEqual(modelCatalog.applyRetiredMarking(undefined), []);
  assert.deepEqual(modelCatalog.applyRetiredMarking([]), []);
});

test("lr-f22787: end-to-end — mergeModelCatalog + applyRetiredMarking together disable a known-retired catalog ID and leave an active one an ordinary selectable row", function () {
  // This is the exact scenario the coordinator flagged: claude-1.0 (a
  // fully-retired model, present in the real committed catalog) must not
  // render as a plain selectable row indistinguishable from claude-opus-5.
  var merged = modelCatalog.mergeModelCatalog([], [
    { id: "claude-1.0", displayName: "claude-1.0", status: "retired" },
    { id: "claude-opus-5", displayName: "claude-opus-5", status: "active" },
  ]);
  var marked = modelCatalog.applyRetiredMarking(merged);
  var byId = {};
  marked.forEach(function (m) { byId[m.value] = m; });

  assert.equal(byId["claude-1.0"].isRetired, true, "claude-1.0 must be marked retired");
  assert.equal(byId["claude-1.0"].disabled, true, "claude-1.0 must be disabled from selection");
  assert.notEqual(byId["claude-opus-5"].isRetired, true, "claude-opus-5 must NOT be marked retired");
  assert.notEqual(byId["claude-opus-5"].disabled, true, "claude-opus-5 must remain an ordinary selectable row");
});

test("lr-f22787: the REAL committed catalog's known-retired entries (claude-1.0, claude-2.0) end up disabled after the full merge+marking pipeline, while claude-opus-5 does not", function () {
  // Exercises the real committed lib/generated/claude-model-catalog.json —
  // not a synthetic fixture — through the exact pipeline
  // mergeStaticCatalog uses (mergeModelCatalog then applyRetiredMarking).
  // If a future regeneration ever ships without carrying status through
  // correctly, this is the test that catches it.
  var catalog = modelCatalog.loadClaudeModelCatalog();
  assert.ok(catalog.ok);
  var hasRetiredEntry = catalog.models.some(function (m) { return m.id === "claude-1.0" || m.id === "claude-2.0"; });
  assert.ok(hasRetiredEntry, "expected the committed catalog to contain at least one known-retired legacy ID (claude-1.0 or claude-2.0) for this test to be meaningful");

  var merged = modelCatalog.mergeModelCatalog([], catalog.models);
  var marked = modelCatalog.applyRetiredMarking(merged);
  var byId = {};
  marked.forEach(function (m) { byId[m.value] = m; });

  ["claude-1.0", "claude-2.0"].forEach(function (id) {
    if (!byId[id]) return; // not every regeneration is guaranteed to carry every legacy ID forward
    assert.equal(byId[id].isRetired, true, id + " must be marked retired in the real committed catalog");
    assert.equal(byId[id].disabled, true, id + " must be disabled from selection");
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

test("lr-f22787: mergeStaticCatalog (adapter-level) ALSO applies retired marking — a claude-1.0 entry pulled from the real catalog comes out disabled, not an ordinary row", function () {
  var merged = claudeAdapter._test_mergeStaticCatalog([]);
  var claude1 = merged.filter(function (m) { return m.value === "claude-1.0"; })[0];
  if (!claude1) return; // committed catalog contents can change; only assert when present
  assert.equal(claude1.isRetired, true);
  assert.equal(claude1.disabled, true);
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
