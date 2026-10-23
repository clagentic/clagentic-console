"use strict";

// The server-wide permission settings an administrator may change. Each default
// equals the behaviour before the setting existed, so nothing changes until a
// person changes it. Stored in daemon.json beside the other server settings;
// read at decision time, so a change needs no restart.

var { ownValue } = require("./prompt-kinds/codecs");

var DEFAULT_OPENED_SESSION_MODE = "acceptEdits";

// The setting names a client may send, each with its type check. Anything else
// in a request is refused rather than stored.
var SETTING_TYPES = {
  autoApproveReadOnly: function (v) { return typeof v === "boolean"; },
  openedSessionMode: function (v) { return typeof v === "string" && v.length > 0; },
};

/**
 * @param {?object} config - the daemon configuration (daemon.json contents).
 * @returns {{autoApproveReadOnly: boolean, openedSessionMode: string}}
 */
function readPermissionSettings(config) {
  var cfg = config || {};
  return {
    // Only an explicit false turns it off: an absent field is today's behaviour.
    autoApproveReadOnly: cfg.autoApproveReadOnly !== false,
    openedSessionMode: typeof cfg.openedSessionMode === "string" && cfg.openedSessionMode
      ? cfg.openedSessionMode
      : DEFAULT_OPENED_SESSION_MODE,
  };
}

/**
 * The fields of a change request that name a known setting with a value of the
 * right type; nothing else passes. `rejected` lists the names that did not.
 * @returns {{values: object, rejected: string[]}}
 */
function pickSettingChanges(request) {
  var values = {};
  var rejected = [];
  Object.keys(request || {}).forEach(function (name) {
    if (name === "type") return;
    var check = ownValue(SETTING_TYPES, name);
    if (typeof check === "function" && check(request[name])) values[name] = request[name];
    else rejected.push(name);
  });
  return { values: values, rejected: rejected };
}

/**
 * The mode a session opened by the CLI or a trigger starts in. Precedence: the
 * open request's own mode, then the server setting, then accept edits.
 *
 * A mode the request names that fails the check refuses the open (the caller
 * asked for it by name). A stored setting that fails it falls back to accept
 * edits: it was valid when saved and may have stopped being so (a vendor
 * change).
 *
 * @param {object} args
 * @param {*} args.requested - the open request's mode, or undefined/null.
 * @param {string} args.setting - the server setting's value.
 * @param {function(string): {ok: boolean, error: ?string}} args.check - the shared mode check
 *   for the vendor the session will run on.
 * @param {function(string): void} [args.onFallback] - told why the stored setting was not used.
 * @returns {{mode: string}|{error: string}}
 */
function resolveOpenedSessionMode(args) {
  if (args.requested !== undefined && args.requested !== null) {
    var asked = args.check(args.requested);
    return asked.ok ? { mode: args.requested } : { error: asked.error };
  }
  if (args.setting && args.setting !== DEFAULT_OPENED_SESSION_MODE) {
    var stored = args.check(args.setting);
    if (stored.ok) return { mode: args.setting };
    if (args.onFallback) args.onFallback(stored.error);
  }
  return { mode: DEFAULT_OPENED_SESSION_MODE };
}

/** The wire message that tells a client the current settings. */
function settingsMessage(settings) {
  return {
    type: "permission_settings",
    autoApproveReadOnly: settings.autoApproveReadOnly,
    openedSessionMode: settings.openedSessionMode,
  };
}

module.exports = {
  DEFAULT_OPENED_SESSION_MODE: DEFAULT_OPENED_SESSION_MODE,
  readPermissionSettings: readPermissionSettings,
  pickSettingChanges: pickSettingChanges,
  resolveOpenedSessionMode: resolveOpenedSessionMode,
  settingsMessage: settingsMessage,
};
