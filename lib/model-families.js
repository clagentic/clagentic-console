/**
 * model-families.js — shared source of truth for Claude model family/version
 * parsing, derived display names, and capability heuristics. (lr-d91ecf)
 *
 * This is the CJS backend copy, consumed by lib/yoke/adapters/claude.js.
 * The ES module (browser) copy lives at lib/public/modules/model-families.js
 * and is consumed by settings-defaults.js and app-panels.js. A CI test
 * (test/model-families-parity.test.js) asserts both files produce identical
 * results so they cannot silently drift — same discipline as the existing
 * lib/model-context-windows.js / lib/public/modules/model-context-windows.js
 * pair (lr-336f).
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
 * Keep this module dependency-light: no project imports, no Node built-ins.
 * That constraint is what lets it stay close to the browser copy.
 */

var CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

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

function isSonnetModel(model) { return isClaudeFamily(model, "sonnet"); }
function isOpusModel(model) { return isClaudeFamily(model, "opus"); }
function isHaikuModel(model) { return isClaudeFamily(model, "haiku"); }

/**
 * Parse a single ID/description-style string into { family, version } (or
 * null). Shared core behind parseClaudeModelVersion below — no family
 * resolution fallback, just the raw substring + numeric-segment extraction.
 */
function parseClaudeFamilyVersion(str) {
  var lower = (str || "").toLowerCase();
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
 * Extract ONLY the leading dotted-number run immediately following the
 * family name in free-text description prose (e.g. "Opus 4.8 with 1M
 * context" -> [4, 8], stopping before the unrelated "1" in "1M"). Unlike
 * parseClaudeFamilyVersion (which scans the entire remainder of a tight ID
 * string), description text can contain trailing prose with unrelated
 * digits, so only a contiguous number immediately after the family name
 * (allowing a single separator character, e.g. the space in "Opus 4.8") is
 * trusted as the version.
 */
function parseClaudeFamilyVersionFromDescription(str) {
  var lower = (str || "").toLowerCase();
  var family = null;
  for (var i = 0; i < CLAUDE_MODEL_FAMILIES.length; i++) {
    if (lower.indexOf(CLAUDE_MODEL_FAMILIES[i]) !== -1) { family = CLAUDE_MODEL_FAMILIES[i]; break; }
  }
  if (!family) return null;

  var afterFamily = lower.slice(lower.indexOf(family) + family.length);
  var m = afterFamily.match(/^[\s-]?(\d+(?:\.\d+)*)/);
  var version = m ? m[1].split(".").map(function(n) { return parseInt(n, 10); }) : [];

  return { family: family, version: version };
}

/**
 * Parse a raw Claude model ID into { family, version } for ordering.
 * version is an array of numeric segments (e.g. "claude-opus-4-6" -> [4, 6]),
 * so comparison is lexicographic-numeric (4.6 > 4.5 > 4 > 3.7 > 3.5 > 3).
 * Returns null when the ID doesn't match a known family (e.g. an ID with no
 * family substring at all) — such entries are excluded from the tiering
 * comparison entirely and default to isLatest: true (never hidden behind a
 * disclosure we can't reason about).
 *
 * Live Claude runtimes report an alias for `modelId` (e.g. "opus", "sonnet",
 * "fable") with NO version digits at all — the family resolves but the
 * version array comes back empty. When the caller also has the vendor's
 * `description` string (e.g. "Opus 4.8 with 1M context", "Sonnet 4.6"), pass
 * it as the optional second argument: if the alias itself carried no version
 * digits, ONLY the leading number immediately after the family name in the
 * description is trusted (see parseClaudeFamilyVersionFromDescription) —
 * trailing prose digits (e.g. the "1" in "1M context") are never picked up.
 * This is what lets an alias-only model list still surface real version
 * numbers (lr-5c07ce) without ever hardcoding a model ID.
 */
function parseClaudeModelVersion(modelId, description) {
  var parsed = parseClaudeFamilyVersion(modelId);
  if (!parsed) return null;
  if (parsed.version.length === 0 && description) {
    var fromDesc = parseClaudeFamilyVersionFromDescription(description);
    if (fromDesc && fromDesc.family === parsed.family && fromDesc.version.length > 0) {
      return { family: parsed.family, version: fromDesc.version };
    }
  }
  return parsed;
}

/**
 * Compare two version arrays lexicographically (missing segments treated as 0).
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareClaudeVersions(a, b) {
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
 *
 * When an entry is a rich object with a `description` field, it feeds
 * parseClaudeModelVersion's optional second argument (see its doc comment) —
 * this is what lets a live alias-only list (value: "opus"/"sonnet"/"haiku",
 * no version digits) still tier correctly against a real versioned ID that
 * might appear alongside it, using the version embedded in the vendor's
 * description text instead of a hardcoded table (lr-5c07ce).
 * @returns {Object<string, boolean>} map of raw model value -> isLatest
 */
function deriveClaudeLatestTiers(models) {
  var parsed = models.map(function(m) {
    var value = (m && typeof m === "object") ? (m.value || "") : String(m || "");
    var description = (m && typeof m === "object") ? m.description : null;
    return { value: value, parsed: parseClaudeModelVersion(value, description) };
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
 *
 * @param {string} modelId
 * @param {string} [description] - optional vendor description string (e.g.
 *   "Opus 4.8 with 1M context"). When modelId is a bare alias with no
 *   version digits (the live runtime shape for opus/sonnet/haiku/fable —
 *   lr-5c07ce), the version embedded in description is used instead, so
 *   "Opus" (alias) displays as "Opus 4.8" rather than just "Opus".
 */
function claudeDisplayName(modelId, description) {
  var parsed = parseClaudeModelVersion(modelId, description);
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
function claudeModelSupportsThinking(modelId) {
  return !isHaikuModel(modelId);
}

// Models known to support effort control. Currently all Claude 4.x opus/sonnet
// models support effort; haiku does not (no reasoning). Defaults to true for
// unknown models so new releases are not accidentally silenced.
function claudeModelSupportsEffort(modelId) {
  return !isHaikuModel(modelId);
}

module.exports = {
  CLAUDE_MODEL_FAMILIES: CLAUDE_MODEL_FAMILIES,
  isSonnetModel: isSonnetModel,
  isOpusModel: isOpusModel,
  isHaikuModel: isHaikuModel,
  parseClaudeModelVersion: parseClaudeModelVersion,
  compareClaudeVersions: compareClaudeVersions,
  deriveClaudeLatestTiers: deriveClaudeLatestTiers,
  claudeDisplayName: claudeDisplayName,
  claudeModelSupportsThinking: claudeModelSupportsThinking,
  claudeModelSupportsEffort: claudeModelSupportsEffort,
};
