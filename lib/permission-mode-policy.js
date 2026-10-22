"use strict";

// The one answer to "may this permission mode be applied?", shared by every
// place a mode enters the server: the per-session, project-default and
// server-default setters, a loop's mode at query start, and a saved default
// read at load. A mode is accepted only when the vendor can run it AND the
// server allows it; bypassPermissions is accepted only while the server's
// skip-permissions setting is on.

var { ownValue } = require("./prompt-kinds/codecs");

// Every mode the console knows. Anything else is refused outright.
var KNOWN_MODES = {
  default: true,
  plan: true,
  acceptEdits: true,
  dontAsk: true,
  auto: true,
  bypassPermissions: true,
};

// Modes only a vendor that lists them in capabilities.permissionModes can run.
var CAPABILITY_GATED_MODES = { auto: true, dontAsk: true };

/**
 * @param {*} mode - the requested mode, unchecked client or file input.
 * @param {object} [opts]
 * @param {boolean} [opts.skipPermissionsAllowed] - the server's skip-permissions setting.
 * @param {?string[]} [opts.supportedModes] - the vendor's capabilities.permissionModes;
 *   null or absent skips the vendor check (used where no vendor is known yet, e.g. at load).
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function checkPermissionMode(mode, opts) {
  opts = opts || {};
  if (typeof mode !== "string" || ownValue(KNOWN_MODES, mode) !== true) {
    return { ok: false, error: "Unknown permission mode" };
  }
  if (mode === "bypassPermissions" && opts.skipPermissionsAllowed !== true) {
    return { ok: false, error: "The bypassPermissions mode is not enabled on this server" };
  }
  if (ownValue(CAPABILITY_GATED_MODES, mode) === true && Array.isArray(opts.supportedModes)
      && opts.supportedModes.indexOf(mode) === -1) {
    return { ok: false, error: "This session's agent does not support the " + mode + " permission mode" };
  }
  return { ok: true };
}

/**
 * A mode read from storage (daemon.json defaults): the mode itself when it
 * passes, "default" otherwise, with the refusal so the caller can log it. The
 * vendor check is skipped: no vendor has reported its capabilities at load.
 * @returns {{mode: string, error: ?string}}
 */
function savedModeOrDefault(mode, opts) {
  var verdict = checkPermissionMode(mode, { skipPermissionsAllowed: !!(opts && opts.skipPermissionsAllowed) });
  return verdict.ok ? { mode: mode, error: null } : { mode: "default", error: verdict.error };
}

module.exports = {
  checkPermissionMode: checkPermissionMode,
  savedModeOrDefault: savedModeOrDefault,
  CAPABILITY_GATED_MODES: CAPABILITY_GATED_MODES,
};
