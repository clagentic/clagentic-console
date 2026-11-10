"use strict";

// The settings of the composer's ! mode: whether it is on, how long a command
// may run, and how much of its output is kept. Stored in daemon.json beside the
// other server settings and read when a command is sent, so a change needs no
// restart. Each default is what runs until an administrator changes it.

var { ownValue } = require("./prompt-kinds/codecs");

var DEFAULT_TIMEOUT_MINUTES = 10;
var DEFAULT_MAX_OUTPUT_KIB = 256;

// A day is far past any command worth waiting on in a chat; 4 MiB is far past
// any output worth putting in a conversation.
var MAX_TIMEOUT_MINUTES = 24 * 60;
var MAX_OUTPUT_KIB = 4096;

function isCount(v, max) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= 1 && v <= max;
}

// The setting names a client may send, each with its type check. Anything else
// in a request is refused rather than stored. A name is also its daemon.json key.
var SETTING_TYPES = {
  userShellEnabled: function (v) { return typeof v === "boolean"; },
  userShellTimeoutMinutes: function (v) { return isCount(v, MAX_TIMEOUT_MINUTES); },
  userShellMaxOutputKiB: function (v) { return isCount(v, MAX_OUTPUT_KIB); },
};

/**
 * @param {?object} config - the daemon configuration (daemon.json contents).
 * @returns {{enabled: boolean, timeoutMinutes: number, maxOutputKiB: number,
 *   timeoutMs: number, maxOutputBytes: number}}
 */
function readUserShellSettings(config) {
  var cfg = config || {};
  var timeoutMinutes = isCount(cfg.userShellTimeoutMinutes, MAX_TIMEOUT_MINUTES)
    ? cfg.userShellTimeoutMinutes : DEFAULT_TIMEOUT_MINUTES;
  var maxOutputKiB = isCount(cfg.userShellMaxOutputKiB, MAX_OUTPUT_KIB)
    ? cfg.userShellMaxOutputKiB : DEFAULT_MAX_OUTPUT_KIB;
  return {
    // Only an explicit false turns it off: an absent field is the default, on.
    enabled: cfg.userShellEnabled !== false,
    timeoutMinutes: timeoutMinutes,
    maxOutputKiB: maxOutputKiB,
    timeoutMs: timeoutMinutes * 60 * 1000,
    maxOutputBytes: maxOutputKiB * 1024,
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

/** The wire message that tells a client the current settings. */
function settingsMessage(settings) {
  return {
    type: "user_shell_settings",
    userShellEnabled: settings.enabled,
    userShellTimeoutMinutes: settings.timeoutMinutes,
    userShellMaxOutputKiB: settings.maxOutputKiB,
  };
}

/**
 * Applies accepted changes to a daemon configuration object; a value equal to
 * its default is removed so daemon.json keeps showing only what was changed.
 */
function applySettingChanges(config, values) {
  if (values.userShellEnabled !== undefined) {
    if (values.userShellEnabled === false) config.userShellEnabled = false;
    else delete config.userShellEnabled;
  }
  if (values.userShellTimeoutMinutes !== undefined) {
    if (values.userShellTimeoutMinutes === DEFAULT_TIMEOUT_MINUTES) delete config.userShellTimeoutMinutes;
    else config.userShellTimeoutMinutes = values.userShellTimeoutMinutes;
  }
  if (values.userShellMaxOutputKiB !== undefined) {
    if (values.userShellMaxOutputKiB === DEFAULT_MAX_OUTPUT_KIB) delete config.userShellMaxOutputKiB;
    else config.userShellMaxOutputKiB = values.userShellMaxOutputKiB;
  }
  return config;
}

module.exports = {
  DEFAULT_TIMEOUT_MINUTES: DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_MAX_OUTPUT_KIB: DEFAULT_MAX_OUTPUT_KIB,
  readUserShellSettings: readUserShellSettings,
  pickSettingChanges: pickSettingChanges,
  settingsMessage: settingsMessage,
  applySettingChanges: applySettingChanges,
};
