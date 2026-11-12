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
var chatWidth = require("./chat-width");
var sessionListAvatars = require("./session-list-avatars");

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

// The width of the conversation column for a person who has not chosen one in
// Appearance. Each person's own choice (a per-user setting) always wins; this is
// only what the profile reports when they have none.
SETTINGS.chatWidth = {
  default: chatWidth.DEFAULT_CHAT_WIDTH,
  read: function (config) {
    return chatWidth.isChatWidth(config.chatWidth) ? config.chatWidth : chatWidth.DEFAULT_CHAT_WIDTH;
  },
  pick: function (value) {
    if (chatWidth.isChatWidth(value)) return { ok: true, value: value };
    return { ok: false, reason: "chatWidth must be one of: " + chatWidth.CHAT_WIDTHS.join(", ") + "." };
  },
  apply: function (config, value) {
    if (value === chatWidth.DEFAULT_CHAT_WIDTH) delete config.chatWidth;
    else config.chatWidth = value;
  },
};

// Whether a session run by a named agent shows that agent's avatar in the session
// lists, for a person who has not chosen in Appearance. Their own choice (a
// per-user setting) always wins; this is only what the profile reports when they
// have none.
SETTINGS.sessionListAvatars = {
  default: sessionListAvatars.DEFAULT_SESSION_LIST_AVATARS,
  read: function (config) {
    return sessionListAvatars.isSessionListAvatars(config.sessionListAvatars)
      ? config.sessionListAvatars
      : sessionListAvatars.DEFAULT_SESSION_LIST_AVATARS;
  },
  pick: function (value) {
    if (sessionListAvatars.isSessionListAvatars(value)) return { ok: true, value: value };
    return { ok: false, reason: "sessionListAvatars must be true or false." };
  },
  apply: function (config, value) {
    if (value === sessionListAvatars.DEFAULT_SESSION_LIST_AVATARS) delete config.sessionListAvatars;
    else config.sessionListAvatars = value;
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
