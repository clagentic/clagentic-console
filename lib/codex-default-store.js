"use strict";

// How the saved Codex defaults (approval policy, sandbox, web search) sit in
// daemon.json: on the config object for the server default and on a project
// entry for a project default, as defaultCodexApproval / defaultCodexSandbox /
// defaultCodexWebSearch beside defaultEffort and defaultThinking.

var STORE_KEYS = {
  approval: "defaultCodexApproval",
  sandbox: "defaultCodexSandbox",
  webSearch: "defaultCodexWebSearch",
};

/**
 * @param {?object} holder - the config or a project entry.
 * @returns {{approval: ?string, sandbox: ?string, webSearch: ?string}}
 */
function read(holder) {
  var h = holder || {};
  var out = {};
  Object.keys(STORE_KEYS).forEach(function (field) { out[field] = h[STORE_KEYS[field]] || null; });
  return out;
}

/**
 * Sets one default on `holder`; an empty value removes it.
 * @returns {boolean} false when `field` is not one of the three Codex settings.
 */
function write(holder, field, value) {
  if (!Object.prototype.hasOwnProperty.call(STORE_KEYS, field)) return false;
  if (typeof value === "string" && value) holder[STORE_KEYS[field]] = value;
  else delete holder[STORE_KEYS[field]];
  return true;
}

module.exports = { read: read, write: write };
