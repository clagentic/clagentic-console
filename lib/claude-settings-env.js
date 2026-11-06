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

// The directory shape the daemon is willing to read a settings file from: an
// absolute path with no parent-directory segment. A relative or odd value is
// refused, so it reads nothing rather than something resolved against the
// daemon's working directory.
function configDirShapeOk(dir) {
  if (typeof dir !== "string" || dir === "" || dir.indexOf("\0") !== -1) return false;
  if (!path.isAbsolute(dir)) return false;
  return dir.split(/[\\/]+/).indexOf("..") === -1;
}

/**
 * Who may choose which settings file the daemon reads. The Claude CLI reads
 * CLAUDE_CONFIG_DIR from the environment it is started with, and a project's
 * environment text is written by the project's owner; the daemon, which reads
 * the file on its own account, must not let that text pick a path it would
 * then open (key names would leak from another account's file).
 *
 * @param {object} o
 * @param {object} o.baseEnv  the daemon's own environment with the
 *   administrator-shared Settings text over it: always a trusted source
 * @param {object} [o.composedEnv]  the environment the session starts with, the
 *   project's text included
 * @param {boolean} [o.trustComposed]  true when the actor is an administrator
 *   or the host has a single user, so the project's text may choose the path
 * @param {boolean} [o.osUsers]  the session runs as another OS user: the daemon
 *   reads no settings file on its behalf at all
 * @returns {{trustedEnv: object, osUsers: boolean}}
 */
function settingsReadPolicy(o) {
  return {
    trustedEnv: o.trustComposed && o.composedEnv ? o.composedEnv : o.baseEnv,
    osUsers: !!o.osUsers,
  };
}

/**
 * A short string that differs exactly when two policies could read different
 * files, for keying a cache of answers that depend on the file.
 * @param {?object} policy
 * @returns {string}
 */
function policySignature(policy) {
  if (!policy) return "";
  var dir = policy.trustedEnv && policy.trustedEnv.CLAUDE_CONFIG_DIR;
  return (policy.osUsers ? "os" : "") + "\0" + (dir || "");
}

/**
 * The one place that decides which settings file the daemon reads; every read
 * goes through it. Null means "read nothing".
 * @param {?{trustedEnv?: object, osUsers?: boolean}} policy  absent: only the
 *   daemon's own environment is trusted
 * @param {string} [homeDir]
 * @returns {?string}
 */
function resolveSettingsFile(policy, homeDir) {
  policy = policy || {};
  if (policy.osUsers) return null;
  var env = policy.trustedEnv || process.env;
  var configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    if (!configDirShapeOk(configDir)) return null;
    return path.join(configDir, "settings.json");
  }
  return path.join(homeDir || os.homedir(), ".claude", "settings.json");
}

function userSettingsEnvBlock(opts) {
  opts = opts || {};
  var file = resolveSettingsFile(opts.readPolicy, opts.homeDir);
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
 * @param {{readPolicy?: object, homeDir?: string}} [opts]
 * @returns {string[]} the names in the settings file's env block; [] when the
 *   file is absent, unreadable or not one the policy allows reading
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
 * @param {{homeDir?: string, readPolicy?: object}} [opts]
 * @returns {object} a new object; env is not modified
 */
function applyUserSettingsEnv(env, opts) {
  var out = Object.assign({}, env);
  var block = userSettingsEnvBlock({ readPolicy: opts && opts.readPolicy, homeDir: opts && opts.homeDir });
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
 * @param {{env?: object, homeDir?: string, trustEdited?: boolean, osUsers?: boolean}} [opts]
 *   env: the trusted base (default process.env); trustEdited: the actor may
 *   choose the settings directory through the edited text
 * @returns {string[]} names the text sets that the settings file also sets; []
 *   under os-users mode, where the file is not read
 */
function shadowedKeys(envText, opts) {
  opts = opts || {};
  var quiet = function () {};
  var baseEnv = opts.env || process.env;
  var spawnEnv = runtimeEnv.composeRuntimeEnv(
    baseEnv,
    runtimeEnv.buildRuntimeEnvOverlay([{ label: "edited", text: envText }], { warn: quiet }),
    { warn: quiet }
  );
  var policy = settingsReadPolicy({
    baseEnv: baseEnv, composedEnv: spawnEnv, trustComposed: !!opts.trustEdited, osUsers: opts.osUsers,
  });
  var fileKeys = userSettingsEnvKeys({ readPolicy: policy, homeDir: opts.homeDir });
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
  resolveSettingsFile: resolveSettingsFile,
  settingsReadPolicy: settingsReadPolicy,
  policySignature: policySignature,
  userSettingsEnvKeys: userSettingsEnvKeys,
  applyUserSettingsEnv: applyUserSettingsEnv,
  shadowedKeys: shadowedKeys,
};
