// claude-settings-env.js - the variables the Claude user settings file sets in
// its own "env" block, and which of them a Settings environment text names too.
//
// Claude Code applies that block to its own environment at startup, after the
// environment it was handed, so for a key present in both the settings file
// wins over the value saved in Settings. The editor warns about those keys
// rather than letting a saved value silently have no effect. Names only: no
// value is read out of the file into a result.

var fs = require("fs");
var os = require("os");
var path = require("path");
var runtimeEnv = require("./runtime-env");

function settingsFilePath(env, homeDir) {
  var configDir = env && env.CLAUDE_CONFIG_DIR;
  var base = configDir || path.join(homeDir || os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

/**
 * @param {{env?: object, homeDir?: string}} [opts]  env: where CLAUDE_CONFIG_DIR
 *   is looked up (default process.env)
 * @returns {string[]} the names in the settings file's env block; [] when the
 *   file is absent or unreadable
 */
function userSettingsEnvKeys(opts) {
  opts = opts || {};
  var file = settingsFilePath(opts.env || process.env, opts.homeDir);
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // No file, or one that is not valid JSON, sets nothing the runtime can see.
    return [];
  }
  var block = parsed && typeof parsed === "object" ? parsed.env : null;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  return Object.keys(block);
}

/**
 * @param {string} envText  a Settings environment text
 * @param {{env?: object, homeDir?: string}} [opts]
 * @returns {string[]} names the text sets that the settings file also sets
 */
function shadowedKeys(envText, opts) {
  var fileKeys = userSettingsEnvKeys(opts);
  if (fileKeys.length === 0) return [];
  var seen = {};
  return runtimeEnv.scanEnvText(envText).entries
    .map(function (entry) { return entry.key; })
    .filter(function (key) {
      if (fileKeys.indexOf(key) === -1 || seen[key]) return false;
      seen[key] = true;
      return true;
    });
}

module.exports = { userSettingsEnvKeys: userSettingsEnvKeys, shadowedKeys: shadowedKeys };
