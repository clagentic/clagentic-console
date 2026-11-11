"use strict";

// The daemon side of `clagentic-console settings get|set|list`. Every reply
// carries a `result` (read, saved, listed, refused, unknown-key), because the
// CLI treats a reply without one as an error.
//
// deps:
//   getConfig()        the live daemon configuration object
//   set(key, value)    stores an accepted value (the same path the Settings page
//                      uses) or returns false when the key has no setter
//   announce(key)      tells connected pages the new state
//   registry           { findSetting, settingKeys } (lib/settings-registry.js)

function unknownKey(registry, key) {
  return {
    ok: false,
    result: "unknown-key",
    key: key === undefined ? null : key,
    reason: "Unknown setting: " + String(key) + ". Known: " + registry.settingKeys().join(", "),
  };
}

function describe(entry, key, config) {
  return { key: key, value: entry.read(config), default: entry.default };
}

function handleSettingsCommand(deps, msg) {
  var registry = deps.registry;
  var config = deps.getConfig();

  if (msg.cmd === "settings_list") {
    return {
      ok: true,
      result: "listed",
      settings: registry.settingKeys().map(function (key) {
        return describe(registry.findSetting(key), key, config);
      }),
    };
  }

  var entry = typeof msg.key === "string" ? registry.findSetting(msg.key) : null;
  if (!entry) return unknownKey(registry, msg.key);

  if (msg.cmd === "settings_get") {
    return Object.assign({ ok: true, result: "read" }, describe(entry, msg.key, config));
  }

  var picked = entry.pick(msg.value);
  if (!picked.ok) {
    return Object.assign({ ok: false, result: "refused", reason: picked.reason }, describe(entry, msg.key, config));
  }
  if (deps.set(msg.key, picked.value) === false) {
    return { ok: false, result: "error", key: msg.key, reason: "The server cannot store " + msg.key + "." };
  }
  deps.announce(msg.key);
  // Read back from the in-memory configuration: the file write is asynchronous.
  return Object.assign({ ok: true, result: "saved" }, describe(entry, msg.key, deps.getConfig()));
}

module.exports = { handleSettingsCommand: handleSettingsCommand };
