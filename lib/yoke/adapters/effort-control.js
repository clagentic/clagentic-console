"use strict";

// Changing the reasoning effort of a Claude session that is already running.
// The SDK's Query has no setEffort; the live control is applyFlagSettings
// with an effortLevel, which takes effect for the rest of the session.
// 'max' is session-only and runs as 'high' on a model without it, which the
// SDK decides, so the console passes it through.
//
// Shared by the in-process query handle and the worker process, so the two
// paths cannot disagree about what a valid level is or what a failure is.

var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * @param {object} query - the SDK Query.
 * @param {string} effort - one of EFFORT_LEVELS.
 * @returns {Promise<void>} rejects with a message fit to show the operator.
 */
function applyEffort(query, effort) {
  if (EFFORT_LEVELS.indexOf(effort) === -1) {
    return Promise.reject(new Error("Unknown effort level: " + String(effort).slice(0, 40)));
  }
  if (!query || typeof query.applyFlagSettings !== "function") {
    return Promise.reject(new Error("This Claude Code version cannot change effort in a running session"));
  }
  return Promise.resolve().then(function () {
    return query.applyFlagSettings({ effortLevel: effort });
  });
}

module.exports = {
  EFFORT_LEVELS: EFFORT_LEVELS,
  applyEffort: applyEffort,
};
