// new-work-gate.js — process-wide switch for refusing new sessions and new
// agent work while the daemon is under memory pressure or draining.
//
// The drain controller is created late in daemon startup, after the modules
// that need to consult it are loaded, so it registers a predicate here rather
// than being threaded through every constructor. Existing sessions are never
// touched by this gate; callers only consult it at the point they would start
// something new.

'use strict';

var REFUSAL_MESSAGE =
  'Clagentic: Console is under memory pressure and is not starting new sessions or agent work. ' +
  'Existing sessions keep running. Try again once active sessions finish and memory recovers.';

var _isRefusing = null;

/**
 * Register the predicate that reports whether new work must be refused.
 *
 * @param {function(): boolean|null} fn  — null clears the gate
 */
function setNewWorkGate(fn) {
  _isRefusing = typeof fn === 'function' ? fn : null;
}

/**
 * @returns {string|null} user-facing refusal message, or null when new work is allowed.
 */
function getNewWorkRefusal() {
  if (!_isRefusing) return null;
  var refusing;
  try {
    refusing = !!_isRefusing();
  } catch (e) {
    // Fail closed: an unknown pressure state must not let new work through.
    console.error('[new-work-gate] predicate threw; refusing new work: ' + (e && e.message));
    refusing = true;
  }
  return refusing ? REFUSAL_MESSAGE : null;
}

module.exports = {
  setNewWorkGate: setNewWorkGate,
  getNewWorkRefusal: getNewWorkRefusal,
  REFUSAL_MESSAGE: REFUSAL_MESSAGE,
};
