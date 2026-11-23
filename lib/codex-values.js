"use strict";

var { APPROVAL_POLICIES } = require("./yoke/codex-protocol");

// The values each Codex setting (approval policy, sandbox, web search) accepts.
// Every writer and reader of a Codex value (the set_codex_* setters, the saved
// defaults read back from daemon.json, a session's meta line) goes through
// isCodexValue, so a value outside these sets is never stored or run with.
var CODEX_VALUES = {
  approval: APPROVAL_POLICIES.slice(),
  sandbox: ["read-only", "workspace-write", "danger-full-access"],
  webSearch: ["disabled", "cached", "live"],
};

// Where each Codex setting lives: the session field it is saved in and the
// field of the session manager that holds its saved default. The saved-default
// field stays private to this module: consumers call the functions below and
// never name it.
var SETTINGS = {
  approval: { sessionField: "codexApproval", savedField: "_savedDefaultCodexApproval" },
  sandbox: { sessionField: "codexSandbox", savedField: "_savedDefaultCodexSandbox" },
  webSearch: { sessionField: "codexWebSearch", savedField: "_savedDefaultCodexWebSearch" },
};

var CODEX_KEYS = Object.keys(SETTINGS);

/**
 * @param {string} key - "approval", "sandbox" or "webSearch".
 * @param {*} value
 * @returns {boolean} true when `value` is one of the values `key` allows.
 */
function isCodexValue(key, value) {
  return Object.prototype.hasOwnProperty.call(CODEX_VALUES, key) && CODEX_VALUES[key].indexOf(value) !== -1;
}

/** The session field that holds `key`'s value (and its meta-line key). */
function codexSessionField(key) {
  return SETTINGS[key].sessionField;
}

/** The saved default of `key` on the session manager, null when none is set. */
function savedCodexDefault(sm, key) {
  return (sm && sm[SETTINGS[key].savedField]) || null;
}

/** Sets (or, with a falsy value, clears) the saved default of `key`. */
function setSavedCodexDefault(sm, key, value) {
  sm[SETTINGS[key].savedField] = value || null;
}

module.exports = {
  CODEX_VALUES: CODEX_VALUES,
  CODEX_KEYS: CODEX_KEYS,
  isCodexValue: isCodexValue,
  codexSessionField: codexSessionField,
  savedCodexDefault: savedCodexDefault,
  setSavedCodexDefault: setSavedCodexDefault,
};
