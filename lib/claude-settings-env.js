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

function userSettingsEnvBlock(opts) {
  opts = opts || {};
  var file = settingsFilePath(opts.env || process.env, opts.homeDir);
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
 * @param {{env?: object, homeDir?: string}} [opts]  env: where CLAUDE_CONFIG_DIR
 *   is looked up (default process.env)
 * @returns {string[]} the names in the settings file's env block; [] when the
 *   file is absent or unreadable
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
 * @param {object} env  the composed environment the runtime is started with;
 *   also where CLAUDE_CONFIG_DIR is looked up
 * @param {{homeDir?: string}} [opts]
 * @returns {object} a new object; env is not modified
 */
function applyUserSettingsEnv(env, opts) {
  var out = Object.assign({}, env);
  var block = userSettingsEnvBlock({ env: env, homeDir: opts && opts.homeDir });
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
 * @param {{env?: object, homeDir?: string}} [opts]
 * @returns {string[]} names the text sets that the settings file also sets
 */
function shadowedKeys(envText, opts) {
  opts = opts || {};
  // The spawn reads CLAUDE_CONFIG_DIR from the edited text over the base, so
  // the file looked at is the one the saved text would lead to.
  var quiet = function () {};
  var spawnEnv = runtimeEnv.composeRuntimeEnv(
    opts.env || process.env,
    runtimeEnv.buildRuntimeEnvOverlay([{ label: "edited", text: envText }], { warn: quiet }),
    { warn: quiet }
  );
  var fileKeys = userSettingsEnvKeys({ env: spawnEnv, homeDir: opts.homeDir });
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

module.exports = {
  userSettingsEnvKeys: userSettingsEnvKeys,
  applyUserSettingsEnv: applyUserSettingsEnv,
  shadowedKeys: shadowedKeys,
};
