// compaction-state.js - DOM-free derivations for the compaction signals the
// session view shows: whether the active session is compacting, and whether its
// context is nearing the vendor's auto-compaction point.

// Fraction of the vendor-reported auto-compact threshold at which the meter
// starts to say compaction is near. A fixed margin: the threshold itself always
// comes from the vendor (getContextUsage), never from a table of model windows.
export var NEARING_FRACTION = 0.9;

/**
 * @param {?object} usage  vendor context usage (getContextUsage shape)
 * @returns {boolean} true only when the vendor reports auto-compaction on with a
 *   threshold and usage is within the margin of it (or already past it)
 */
export function isNearingCompaction(usage) {
  if (!usage || usage.isAutoCompactEnabled !== true) return false;
  var threshold = usage.autoCompactThreshold;
  var total = usage.totalTokens;
  if (typeof threshold !== "number" || !(threshold > 0)) return false;
  if (typeof total !== "number" || !(total >= 0)) return false;
  return total >= threshold * NEARING_FRACTION;
}

/**
 * @param {object[]} sessions  a session_list payload
 * @param {?number} activeSessionId
 * @returns {{found: boolean, compacting: boolean}}
 */
export function compactingFromSessionList(sessions, activeSessionId) {
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === activeSessionId) return { found: true, compacting: !!sessions[i].compacting };
  }
  return { found: false, compacting: false };
}
