/**
 * model-families.js — shared source of truth for Claude model family/version
 * parsing, derived display names, and capability heuristics. (lr-d91ecf)
 *
 * This is the ES module (browser) copy. The CJS backend copy lives at
 * lib/model-families.js and is consumed by lib/yoke/adapters/claude.js. A CI
 * test (test/model-families-parity.test.js) asserts both files produce
 * identical results so they cannot silently drift — same discipline as the
 * existing lib/model-context-windows.js / lib/public/modules/
 * model-context-windows.js pair (lr-336f).
 *
 * Before this module existed, family/version detection was duplicated three
 * ways: lib/yoke/adapters/claude.js (parseClaudeModelVersion etc., added by
 * lr-e03635), lib/public/modules/settings-defaults.js (isSonnetModel/
 * isOpusModel/isHaikuModel), and lib/public/modules/app-panels.js (its own
 * private isSonnetModel copy). This is the single shared location — do not
 * add a fourth copy elsewhere.
 *
 * No hardcoded model IDs or display-name tables: everything here is derived
 * from the ID string's family substring + numeric version ordering, so a
 * model release the code has never seen gets a sane display name and correct
 * latest/older tiering with zero code changes.
 *
 * When adding a new family (e.g. a brand-new Claude product line): update
 * BOTH this file and lib/model-families.js. The parity test will fail if
 * they disagree.
 */

export var CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];

/**
 * True if the given model ID string belongs to the given family (substring
 * match on the lowercased ID). Generic helper backing isSonnetModel/
 * isOpusModel/isHaikuModel below.
 */
function isClaudeFamily(model, family) {
  if (!model) return false;
  var str = typeof model === "string" ? model : (model.value || "");
  return str.toLowerCase().indexOf(family) !== -1;
}

export function isSonnetModel(model) { return isClaudeFamily(model, "sonnet"); }
export function isOpusModel(model) { return isClaudeFamily(model, "opus"); }
export function isHaikuModel(model) { return isClaudeFamily(model, "haiku"); }

/**
 * Parse a raw Claude model ID into { family, version } for ordering.
 * version is an array of numeric segments (e.g. "claude-opus-4-6" -> [4, 6]),
 * so comparison is lexicographic-numeric (4.6 > 4.5 > 4 > 3.7 > 3.5 > 3).
 * Returns null when the ID doesn't match a known family (e.g. "default",
 * or an alias) — such entries are excluded from the tiering comparison
 * entirely and default to isLatest: true (never hidden behind a disclosure
 * we can't reason about).
 */
export function parseClaudeModelVersion(modelId) {
  var lower = (modelId || "").toLowerCase();
  // Strip pinned-version/beta suffix like "[1m]" before parsing.
  var clean = lower.replace(/\[.*?\]$/, "").trim();

  var family = null;
  for (var i = 0; i < CLAUDE_MODEL_FAMILIES.length; i++) {
    if (clean.indexOf(CLAUDE_MODEL_FAMILIES[i]) !== -1) { family = CLAUDE_MODEL_FAMILIES[i]; break; }
  }
  if (!family) return null;

  // Numeric segments after the family name, stopping before a trailing date
  // stamp (8 digits, e.g. "-20250929") which is a release date, not a version.
  var afterFamily = clean.slice(clean.indexOf(family) + family.length);
  var withoutDate = afterFamily.replace(/-?\d{8}\b/, "");
  var nums = withoutDate.match(/\d+/g);
  var version = nums ? nums.map(function(n) { return parseInt(n, 10); }) : [];

  return { family: family, version: version };
}

/**
 * Compare two version arrays lexicographically (missing segments treated as 0).
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareClaudeVersions(a, b) {
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) {
    var av = a[i] || 0;
    var bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Given the full list of raw model IDs (or rich objects) reported by the
 * vendor, compute isLatest per model: true iff it holds the max version
 * within its own family, or its ID doesn't parse into a known family at all
 * (unparseable entries are never hidden).
 * @returns {Object<string, boolean>} map of raw model value -> isLatest
 */
export function deriveClaudeLatestTiers(models) {
  var parsed = models.map(function(m) {
    var value = (m && typeof m === "object") ? (m.value || "") : String(m || "");
    return { value: value, parsed: parseClaudeModelVersion(value) };
  });

  var maxVersionByFamily = {};
  for (var i = 0; i < parsed.length; i++) {
    var p = parsed[i].parsed;
    if (!p) continue;
    var current = maxVersionByFamily[p.family];
    if (!current || compareClaudeVersions(p.version, current) > 0) {
      maxVersionByFamily[p.family] = p.version;
    }
  }

  var result = {};
  for (var j = 0; j < parsed.length; j++) {
    var entry = parsed[j];
    if (!entry.parsed) {
      result[entry.value] = true; // unparseable — never hidden
      continue;
    }
    var maxV = maxVersionByFamily[entry.parsed.family];
    result[entry.value] = compareClaudeVersions(entry.parsed.version, maxV) === 0;
  }
  return result;
}

// Title-case a family name for display (e.g. "opus" -> "Opus").
function titleCaseFamily(family) {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/**
 * Derive a human-readable display name purely from the parsed family +
 * version — no lookup table, so an ID the code has never seen still gets a
 * sane label with zero code changes (e.g. "claude-opus-4-6" -> "Opus 4.6").
 * Falls back to stripping the "claude-" prefix for IDs with no recognized
 * family substring at all (e.g. "default" -> "Default").
 */
export function claudeDisplayName(modelId) {
  var parsed = parseClaudeModelVersion(modelId);
  if (parsed) {
    var label = titleCaseFamily(parsed.family);
    if (parsed.version.length > 0) {
      label += " " + parsed.version.join(".");
    }
    return label;
  }
  // Fallback: strip "claude-" prefix, title-case remainder
  var stripped = (modelId || "").replace(/^claude-/i, "");
  return stripped;
}

// Haiku models do not support extended thinking.
export function claudeModelSupportsThinking(modelId) {
  return !isHaikuModel(modelId);
}

// Models known to support effort control. Currently all Claude 4.x opus/sonnet
// models support effort; haiku does not (no reasoning). Defaults to true for
// unknown models so new releases are not accidentally silenced.
export function claudeModelSupportsEffort(modelId) {
  return !isHaikuModel(modelId);
}
