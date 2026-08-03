/**
 * model-catalog.js — loads the release-time-generated Claude model catalog
 * and merges it into a live vendor model list. (lr-f22787)
 *
 * DESIGN (operator-approved, see PR body for lr-f22787):
 *
 * The Claude Agent SDK's live enumeration (stream.supportedModels()) only
 * ever reports the current alias set (default/opus/sonnet/haiku/fable) — see
 * lib/yoke/adapters/claude.js's enrichment comments and
 * test/model-picker-no-free-text-lr-f22787.test.js for the full empirical
 * trail. There is no runtime path to a list of older, still-runnable
 * versioned IDs (e.g. claude-opus-4-5). GET https://api.anthropic.com/v1/models
 * DOES enumerate them, but requires an API key — which this project's
 * runtime is never allowed to hold (OAuth-only, workspace rule 17: no
 * Anthropic SDK / API-key calls at runtime). So the catalog is generated
 * ONCE per release, in CI, using a repo-secret API key that never leaves
 * CI, and committed as lib/generated/claude-model-catalog.json — shipped
 * inside the npm package like lib/themes/*.json.
 *
 * This module is the read + merge side only. It never makes a network call
 * and never touches ANTHROPIC_API_KEY (that only exists in the GitHub
 * Actions release workflow — see .github/workflows/release.yml).
 *
 * RETIRED MODELS (lr-d3817f, REVERSES the original lr-f22787 decision
 * below): the generator is still ADDITIVE — each release's catalog is a
 * union of the freshly-fetched /v1/models response with whatever was
 * already committed, never a drop of an entry the vendor stopped listing.
 * The committed file is allowed to accumulate retired history so past
 * releases stay diffable/auditable. But the PICKER must never show a
 * retired entry, in any state, on any surface. The original lr-f22787
 * rationale ("shown-but-disabled beats silently vanishing") was never
 * something the operator asked for — the corrected spec (lr-d3817f) is
 * that a fully-retired model (one that provably cannot run) is simply
 * filtered out before it ever reaches a render function. See
 * filterSelectableCatalogModels below, which is the enforcement point.
 *
 * PICKER BEHAVIOR FOR RETIRED/DEPRECATED (lr-d3817f, corrected): the
 * committed catalog carries a per-entry `status` field
 * ("active"/"deprecated"/"retired"/"unknown" — populated by
 * scripts/generate-model-catalog.js from the deprecations page's own
 * three-state "Current state" column, the natural source of truth, rather
 * than an invented heuristic).
 *   - status "retired": excluded entirely by filterSelectableCatalogModels
 *     — never merged into the live picker list, on any surface, in any
 *     state (collapsed or expanded).
 *   - status "deprecated": marked isDeprecated:true via applyRetiredMarking,
 *     still fully selectable — a deprecated model still runs (it just has a
 *     retirement date on the horizon), so filtering it would be
 *     overcautious; the marker itself is the appropriate signal. The
 *     operator's spec named retired, not deprecated, for exclusion.
 *   - status "active"/"unknown"/absent: no marking, no filtering. "unknown"
 *     (a status string the deprecations-page parser didn't recognize) fails
 *     open — the alternative (treat unknown as retired-and-filtered) would
 *     risk hiding a model that is actually fine, on the strength of a
 *     parser hiccup this codebase can't verify either way.
 *
 * MISSING SECRET / FETCH FAILURE (PR body point (b)): loadClaudeModelCatalog
 * never throws and never returns an empty list on a read/parse failure — it
 * falls back to whatever was last committed. The catalog can only ever go
 * stale, never empty; the picker must never regress to "no options."
 */

var fs = require("fs");
var path = require("path");

var CATALOG_PATH = path.join(__dirname, "generated", "claude-model-catalog.json");

/**
 * Read the committed/generated catalog file. Never throws.
 * @returns {{ ok: boolean, models: Array<{id,displayName,createdAt}>, generatedAt: string|null, source: string|null, reason?: string }}
 */
function loadClaudeModelCatalog() {
  var raw;
  try {
    raw = fs.readFileSync(CATALOG_PATH, "utf8");
  } catch (e) {
    // No catalog shipped at all (should not happen once the seed file is
    // committed, but a corrupted install or a future path change must
    // degrade to "no catalog entries to merge," never a thrown error that
    // could break warmup/model listing entirely).
    return { ok: false, models: [], generatedAt: null, source: null, reason: "missing" };
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, models: [], generatedAt: null, source: null, reason: "invalid" };
  }

  if (!parsed || !Array.isArray(parsed.models)) {
    return { ok: false, models: [], generatedAt: null, source: null, reason: "invalid" };
  }

  return {
    ok: true,
    models: parsed.models,
    generatedAt: parsed.generatedAt || null,
    source: parsed.source || null,
  };
}

/**
 * Merge the generated catalog into a live vendor model list.
 *
 * @param {Array<string|object>} liveModels - the vendor's live-reported list
 *   (e.g. from stream.supportedModels() — normally just the alias set).
 * @param {Array<{id:string,displayName?:string,status?:string}>} catalogModels - entries
 *   from loadClaudeModelCatalog().models.
 * @returns {Array<object>} liveModels followed by any catalog entries whose
 *   id is not already present in liveModels (by value/id), each tagged
 *   { value, displayName, fromCatalog: true, status } so callers/UI can
 *   mark them (PR body point (c): shown, never hidden — the "Older models"
 *   disclosure already covers the visual distinction via isLatest tiering
 *   upstream; applyRetiredMarking below adds the retired/deprecated marker
 *   on top of that using the carried-through status field).
 */
function mergeModelCatalog(liveModels, catalogModels) {
  var live = liveModels || [];
  var catalog = catalogModels || [];

  var seen = {};
  for (var i = 0; i < live.length; i++) {
    var entry = live[i];
    var value = (entry && typeof entry === "object") ? (entry.value || "") : String(entry || "");
    if (value) seen[value] = true;
  }

  var merged = live.slice();
  for (var j = 0; j < catalog.length; j++) {
    var c = catalog[j];
    if (!c || !c.id || seen[c.id]) continue;
    seen[c.id] = true;
    merged.push({
      value: c.id,
      displayName: c.displayName || c.id,
      fromCatalog: true,
      status: c.status || "unknown",
    });
  }
  return merged;
}

/**
 * Apply the deprecated marking described in this module's header comment
 * ("PICKER BEHAVIOR FOR RETIRED/DEPRECATED"). Pure and additive: only ever
 * ADDS isDeprecated onto entries that already carry a `status` field from
 * mergeModelCatalog — never removes an entry, never touches entries with no
 * status field at all (e.g. a live vendor entry that went through
 * mergeModelCatalog untouched, which has no `status` key — see
 * mergeModelCatalog above, only catalog-sourced entries get one).
 *
 * lr-d3817f: this used to also mark status:"retired" entries isRetired/
 * disabled instead of filtering them. That decision is reversed — a retired
 * entry is now removed entirely by filterSelectableCatalogModels (below)
 * BEFORE this function runs, so applyRetiredMarking never sees one in
 * practice. It still no-ops safely on a stray "retired" status (e.g. a
 * caller that skips the filter) rather than mismarking it as deprecated.
 *
 * @param {Array<object>} models - output of mergeModelCatalog (or any list
 *   of model objects, some of which may carry a `status` field).
 * @returns {Array<object>} the SAME entries, each with isDeprecated added
 *   when status is "deprecated".
 */
function applyRetiredMarking(models) {
  var list = models || [];
  return list.map(function (m) {
    if (!m || typeof m !== "object" || !m.status) return m;
    if (m.status === "deprecated") {
      return Object.assign({}, m, { isDeprecated: true });
    }
    return m;
  });
}

/**
 * Remove status:"retired" catalog entries before they ever reach a picker
 * surface (lr-d3817f). A retired model provably cannot run; the corrected
 * spec is that it appears NOWHERE — not shown-and-disabled, not in the
 * expanded "Older models" tier, not on any surface. This must run on the
 * CATALOG list (before mergeModelCatalog), not on the merged live+catalog
 * list, so a live vendor entry (which never carries a `status` field) is
 * never accidentally filtered.
 *
 * @param {Array<{id:string,status?:string}>} catalogModels - entries from
 *   loadClaudeModelCatalog().models.
 * @returns {Array<object>} the same entries, minus any with status:"retired".
 */
function filterSelectableCatalogModels(catalogModels) {
  var list = catalogModels || [];
  return list.filter(function (m) {
    return !(m && m.status === "retired");
  });
}

module.exports = {
  CATALOG_PATH: CATALOG_PATH,
  loadClaudeModelCatalog: loadClaudeModelCatalog,
  mergeModelCatalog: mergeModelCatalog,
  applyRetiredMarking: applyRetiredMarking,
  filterSelectableCatalogModels: filterSelectableCatalogModels,
};
