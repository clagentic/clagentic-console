"use strict";

// The one writer of session.lastActivityAt, the clock the idle reaper compares
// against (startIdleReaper in lib/sdk-bridge.js). Every bump names its source
// and, with CLAGENTIC_CONSOLE_DEBUG set, logs it, so a session that is never
// reaped can be traced to the event that kept resetting its clock.

var { debugLog } = require("./debug-log");
var { logField } = require("./log-field");

/**
 * @param {object} session
 * @param {string} source - what moved the clock (a fixed vocabulary at the call
 *   sites, e.g. "turn-result", "subagent-stream", "task_progress").
 * @param {string} slug - the owning project; console session ids repeat across
 *   projects.
 */
function bumpLastActivity(session, source, slug) {
  session.lastActivityAt = Date.now();
  debugLog("[activity] lastActivityAt bump: project=" + logField(slug) + " session=" + logField(session.localId) + " source=" + logField(source));
}

module.exports = { bumpLastActivity: bumpLastActivity };
