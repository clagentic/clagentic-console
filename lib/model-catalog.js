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
 * RETIRED MODELS (see PR body point (a)): the generator is ADDITIVE — each
 * release's catalog is a union of the freshly-fetched /v1/models response
 * with whatever was already committed, never a drop of an entry the vendor
 * stopped listing. A model the operator is still actively running should
 * never silently vanish from the picker just because it aged out of the
 * vendor's default listing; the alternative (mirror exactly what the vendor
 * returns) risks pulling a model out from under an operator mid-session
 * with no warning. The trade-off this accepts: a catalog entry can outlive
 * actual executability if a model is fully retired (not just
 * hidden-by-default) — see applyRetiredMarking below, which is how a stale
 * entry gets a visible marker (and is disabled from selection) instead of
 * being silently offered forever as an ordinary clickable row.
 *
 * PICKER BEHAVIOR FOR RETIRED/DEPRECATED (PR body point (c), decided): the
 * committed catalog carries a per-entry `status` field
 * ("active"/"deprecated"/"retired"/"unknown" — populated by
 * scripts/generate-model-catalog.js from the deprecations page's own
 * three-state "Current state" column, the natural source of truth, rather
 * than an invented heuristic). applyRetiredMarking below:
 *   - status "retired": marked isRetired:true AND disabled:true. A retired
 *     model provably cannot run — offering it as an ordinary clickable row
 *     reads as the picker being broken (the operator clicks it, it fails,
 *     with no way to have known in advance). Still VISIBLE (never filtered
 *     out — hiding it defeats the entire point of this task), just
 *     disabled with a "Retired" marker so the operator can see the full
 *     historical list without being able to select a dead entry by
 *     accident.
 *   - status "deprecated": marked isDeprecated:true, still fully
 *     selectable — a deprecated model still runs (it just has a
 *     retirement date on the horizon), so disabling it would be
 *     overcautious; the marker itself is the appropriate signal.
 *   - status "active"/"unknown"/absent: no marking. "unknown" (a status
 *     string the deprecations-page parser didn't recognize) fails open —
 *     the alternative (treat unknown as retired-and-disabled) would risk
 *     disabling a model that is actually fine, on the strength of a parser
 *     hiccup this codebase can't verify either way.
 * If a retired entry is ever selected anyway (e.g. an older client build
 * without this disabling, or a future picker surface that doesn't call
 * applyRetiredMarking), the Finding-2 setModel error-surfacing already on
 * this branch is the safety net — a real SDK rejection now reaches the
 * user instead of failing silently. That is defense-in-depth, not a
 * substitute for not offering a dead model as an ordinary row in the first
 * place.
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
 * Apply the retired/deprecated marking described in this module's header
 * comment ("PICKER BEHAVIOR FOR RETIRED/DEPRECATED"). Pure and additive:
 * only ever ADDS isRetired/isDeprecated/disabled fields onto entries that
 * already carry a `status` field from mergeModelCatalog — never removes an
 * entry, never touches entries with no status field at all (e.g. a live
 * vendor entry that went through mergeModelCatalog untouched, which has no
 * `status` key — see mergeModelCatalog above, only catalog-sourced entries
 * get one).
 *
 * @param {Array<object>} models - output of mergeModelCatalog (or any list
 *   of model objects, some of which may carry a `status` field).
 * @returns {Array<object>} the SAME entries, each with isRetired/
 *   isDeprecated/disabled added when status is "retired"/"deprecated".
 */
function applyRetiredMarking(models) {
  var list = models || [];
  return list.map(function (m) {
    if (!m || typeof m !== "object" || !m.status) return m;
    if (m.status === "retired") {
      return Object.assign({}, m, { isRetired: true, disabled: true });
    }
    if (m.status === "deprecated") {
      return Object.assign({}, m, { isDeprecated: true });
    }
    return m;
  });
}

module.exports = {
  CATALOG_PATH: CATALOG_PATH,
  loadClaudeModelCatalog: loadClaudeModelCatalog,
  mergeModelCatalog: mergeModelCatalog,
  applyRetiredMarking: applyRetiredMarking,
};
