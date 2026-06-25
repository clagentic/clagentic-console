/**
 * model-context-windows.js — shared source of truth for the model context-window
 * map and beta-aware resolution. (lr-336f)
 *
 * This is the ES module (browser) copy.  The CJS backend copy lives at
 * lib/model-context-windows.js.  A CI test (test/model-context-windows-parity.test.js)
 * asserts both files produce identical resolution results so they cannot silently drift.
 *
 * When adding a new model: update BOTH this file and lib/model-context-windows.js.
 * The parity test will fail if they disagree.
 *
 * The map is keyed by a lowercase model-name substring. Lookup is a linear scan so
 * insertion order matters for overlapping substrings — more-specific keys should
 * appear before less-specific ones.
 */

export var KNOWN_CONTEXT_WINDOWS = {
  "opus-4-6": 1000000,
  "claude-sonnet-4": 1000000,
  "gpt-5.5": 1048576,
  "gpt-5.4": 1048576,
  "gpt-5.3": 1048576,
  "gpt-5.2": 1048576,
  "gpt-4.1": 1047576,
  "o3": 200000,
  "o4-mini": 200000,
};

/**
 * Resolve the context window for a model identifier, applying the beta-first
 * rule for the context-1m beta.
 *
 * activeBetas: optional array of active beta strings. When any entry contains
 *   "context-1m", the true window is 1M regardless of the model — the SDK
 *   reports the model's base window in ModelUsage but the beta extends it.
 *
 * Returns the window size in tokens, or 0 when the model is not in
 * KNOWN_CONTEXT_WINDOWS and no beta applies. Callers treat 0 as "unknown"
 * and should degrade cleanly (skip any window-based guard rather than
 * guessing a default).
 *
 * Note: the resolveContextWindow wrapper in app-panels.js adds an sdkValue
 *   fallback and a hasBeta() store accessor on top of this core function.
 *   This function itself is store-agnostic.
 */
export function resolveModelContextWindow(model, activeBetas) {
  // Beta check must come first — the SDK does not reflect the extended window.
  if (Array.isArray(activeBetas)) {
    for (var bi = 0; bi < activeBetas.length; bi++) {
      if (activeBetas[bi].indexOf("context-1m") !== -1) return 1000000;
    }
  }
  if (!model) return 0;
  var lc = model.toLowerCase();
  // UI beta-toggle appends [1m] to the model name
  if (lc.indexOf("[1m]") !== -1) return 1000000;
  var keys = Object.keys(KNOWN_CONTEXT_WINDOWS);
  for (var i = 0; i < keys.length; i++) {
    if (lc.indexOf(keys[i]) !== -1) return KNOWN_CONTEXT_WINDOWS[keys[i]];
  }
  return 0;
}
