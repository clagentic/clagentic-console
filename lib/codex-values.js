"use strict";

// Where each Codex setting (approval policy, sandbox, web search) lives: the
// session field it is saved in and the field of the session manager that holds
// its saved default. The saved-default field stays private to this module:
// consumers call the functions below and never name it.
var SETTINGS = {
  approval: { sessionField: "codexApproval", savedField: "_savedDefaultCodexApproval" },
  sandbox: { sessionField: "codexSandbox", savedField: "_savedDefaultCodexSandbox" },
  webSearch: { sessionField: "codexWebSearch", savedField: "_savedDefaultCodexWebSearch" },
};

var CODEX_KEYS = Object.keys(SETTINGS);

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
  CODEX_KEYS: CODEX_KEYS,
  codexSessionField: codexSessionField,
  savedCodexDefault: savedCodexDefault,
  setSavedCodexDefault: setSavedCodexDefault,
};
