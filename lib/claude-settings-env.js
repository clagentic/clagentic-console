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

/**
 * The one settings file the daemon reads, located from the daemon's own
 * environment alone: its CLAUDE_CONFIG_DIR if it has one, else its home. Text
 * saved in Settings (shared or per project) is written by other people and
 * never chooses the path, so the daemon cannot be pointed at another account's
 * file. Null means "read nothing": under os-users mode the session runs as
 * another account whose file the daemon does not read.
 *
 * @param {{osUsers?: boolean, homeDir?: string}} [opts]
 * @returns {?string}
 */
function resolveSettingsFile(opts) {
  opts = opts || {};
  if (opts.osUsers) return null;
  var configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) return path.join(configDir, "settings.json");
  return path.join(opts.homeDir || os.homedir(), ".claude", "settings.json");
}

function userSettingsEnvBlock(opts) {
  opts = opts || {};
  var file = resolveSettingsFile(opts);
  if (!file) return null;
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // No file, or one that is not valid JSON, sets nothing the runtime can see.
    return null;
  }
  var block = parsed && typeof parsed === "object" ? parsed.env : null;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  return block;
}

/**
 * A cheap change stamp for the settings file, for cache keys: mtime and size,
 * no content read and nothing of it logged.
 *
 * @param {{osUsers?: boolean, homeDir?: string}} [opts]
 * @returns {string} "" when no file is read or it does not exist
 */
function settingsFileStamp(opts) {
  var file = resolveSettingsFile(opts);
  if (!file) return "";
  try {
    var st = fs.statSync(file);
    return st.mtimeMs + ":" + st.size;
  } catch (e) {
    // An absent file is a stable, distinct state; creating it changes the stamp.
    return "";
  }
}

/**
 * @param {{osUsers?: boolean, homeDir?: string}} [opts]
 * @returns {string[]} the names in the settings file's env block; [] when the
 *   file is absent or unreadable, or under os-users mode
 */
function userSettingsEnvKeys(opts) {
  var block = userSettingsEnvBlock(opts);
  return block ? Object.keys(block) : [];
}

/**
 * The environment the Claude CLI actually sees: the one it was handed with the
 * settings file's env block applied over it (the file wins). Used to decide
 * what the CLI will do (which provider it talks to), never to hand a value on:
 * the result is for in-process classification and is not logged or sent.
 *
 * Under os-users mode the file belongs to another account and is not read, so
 * the result is the given environment unchanged: a provider selected only in
 * that account's own settings file is not seen by the console there.
 * @param {object} env  the composed environment the runtime is started with
 * @param {{homeDir?: string, osUsers?: boolean}} [opts]
 * @returns {object} a new object; env is not modified
 */
function applyUserSettingsEnv(env, opts) {
  var out = Object.assign({}, env);
  var block = userSettingsEnvBlock(opts);
  if (!block) return out;
  Object.keys(block).forEach(function (key) {
    var value = block[key];
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  });
  return out;
}

/**
 * @param {string} envText  a Settings environment text
 * @param {{homeDir?: string, osUsers?: boolean}} [opts]
 * @returns {string[]} names the text sets that the settings file also sets; []
 *   under os-users mode, where the file is not read
 */
function shadowedKeys(envText, opts) {
  var fileKeys = userSettingsEnvKeys(opts);
  if (fileKeys.length === 0) return [];
  var inFile = new Set(fileKeys);
  var seen = new Set();
  return runtimeEnv.scanEnvText(envText).entries
    .map(function (entry) { return entry.key; })
    .filter(function (key) {
      if (!inFile.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * @param {string} envText  a Settings environment text
 * @returns {boolean} whether it sets CLAUDE_CONFIG_DIR, which the console never
 *   reads a path from (the editor says its check covers one file only)
 */
function setsConfigDir(envText) {
  return runtimeEnv.scanEnvText(envText).entries.some(function (entry) {
    return entry.key === "CLAUDE_CONFIG_DIR";
  });
}

module.exports = {
  setsConfigDir: setsConfigDir,
  resolveSettingsFile: resolveSettingsFile,
  settingsFileStamp: settingsFileStamp,
  userSettingsEnvKeys: userSettingsEnvKeys,
  applyUserSettingsEnv: applyUserSettingsEnv,
  shadowedKeys: shadowedKeys,
};
