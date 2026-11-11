"use strict";

// The settings API for the unanswered-prompt bound (lib/prompt-expiry.js): which
// values a client may set, how daemon.json is updated, and the wire message that
// tells clients the current value. The registry reads daemon.json at each
// open(), so a saved change applies to the next prompt with no restart.

var { KEY, DEFAULT_MINUTES, MAX_MINUTES, readExpiryMinutes } = require("./prompt-expiry");

function isMinutes(v) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= MAX_MINUTES;
}

/**
 * The change a request asks for, or a reason it is refused.
 * @returns {{ok: true, minutes: number}|{ok: false, reason: string}}
 */
function pickSettingChange(request) {
  var req = request || {};
  var extra = Object.keys(req).filter(function (name) { return name !== "type" && name !== KEY; });
  if (extra.length > 0) return { ok: false, reason: "Unknown prompt expiry setting: " + extra.join(", ") };
  if (!isMinutes(req[KEY])) {
    return { ok: false, reason: KEY + " must be a whole number of minutes from 0 (no expiry) to " + MAX_MINUTES + "." };
  }
  return { ok: true, minutes: req[KEY] };
}

/** The wire message that tells a client the current setting. */
function settingsMessage(config) {
  var message = { type: "prompt_expiry_settings" };
  message[KEY] = readExpiryMinutes(config);
  return message;
}

/**
 * Applies an accepted value to a daemon configuration object; the default is
 * removed so daemon.json keeps showing only what was changed.
 */
function applySettingChange(config, minutes) {
  if (minutes === DEFAULT_MINUTES) delete config[KEY];
  else config[KEY] = minutes;
  return config;
}

module.exports = {
  pickSettingChange: pickSettingChange,
  settingsMessage: settingsMessage,
  applySettingChange: applySettingChange,
};
