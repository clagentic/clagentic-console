"use strict";

// The server-wide settings the `clagentic-console settings` verb can read and
// change, keyed by name. Each entry is { read, pick, apply, default }:
//   read(config)         the value now in effect
//   pick(value)          { ok: true, value } or { ok: false, reason }; the same
//                        validator the Settings page uses, never a second copy
//   apply(config, value) updates the daemon configuration object in place
//   default              the value used when nothing is stored
// A new key is a new entry here; the IPC and CLI layers do not change.

var promptExpiry = require("./prompt-expiry");
var promptExpirySettings = require("./prompt-expiry-settings");

var SETTINGS = {};

SETTINGS[promptExpiry.KEY] = {
  default: promptExpiry.DEFAULT_MINUTES,
  read: function (config) {
    return promptExpiry.readExpiryMinutes(config);
  },
  pick: function (value) {
    var request = { type: "set_prompt_expiry_settings" };
    request[promptExpiry.KEY] = value;
    var picked = promptExpirySettings.pickSettingChange(request);
    return picked.ok ? { ok: true, value: picked.minutes } : { ok: false, reason: picked.reason };
  },
  apply: function (config, value) {
    return promptExpirySettings.applySettingChange(config, value);
  },
};

/** The entry for a key, or null. Own keys only, so "constructor" is not a setting. */
function findSetting(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
}

function settingKeys() {
  return Object.keys(SETTINGS);
}

module.exports = {
  findSetting: findSetting,
  settingKeys: settingKeys,
};
