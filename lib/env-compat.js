// env-compat.js — reads Clagentic: Console environment variables.
//
// Every variable this product owns is named CLAGENTIC_CONSOLE_<NAME>, per the
// clagentic CLI Naming Standard. Earlier releases read un-scoped names, which
// collide with the other clagentic products that share the CLAGENTIC_ prefix.
// For one release the old names are still honoured, with a one-time
// deprecation warning naming the replacement. Remove ALIASES (and this file's
// legacy reads) in the release after.
//
// This table is the only place a non-CONSOLE CLAGENTIC_ name may appear; the
// env-namespace test allowlists it.

var ALIASES = {
  CLAGENTIC_CONSOLE_HOME: ["CLAGENTIC_HOME", "CLAY_HOME"],
  CLAGENTIC_CONSOLE_CONFIG: ["CLAGENTIC_CONFIG", "CLAY_CONFIG"],
  CLAGENTIC_CONSOLE_DEV: ["CLAGENTIC_DEV", "CLAY_DEV"],
  CLAGENTIC_CONSOLE_DEBUG: ["CLAGENTIC_DEBUG"],
  CLAGENTIC_CONSOLE_SELF_UPDATE: ["CLAGENTIC_SELF_UPDATE"],
  CLAGENTIC_CONSOLE_MAX_CONCURRENT_SESSIONS: ["CLAGENTIC_MAX_CONCURRENT_SESSIONS"],
};

var _warned = new Set();

/**
 * Read a console env var by its CLAGENTIC_CONSOLE_<NAME> name.
 * The new name always wins. Otherwise the first deprecated alias that is set
 * (non-empty) is returned and a one-time warning is logged.
 *
 * @param {string} name  A key of ALIASES.
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {function} [opts.warn=console.warn]
 * @param {Set} [opts.warned]  Dedup set; defaults to a module-level set.
 * @returns {string|undefined}
 */
function readConsoleEnv(name, opts) {
  opts = opts || {};
  var env = opts.env || process.env;
  var warn = opts.warn || console.warn;
  var warned = opts.warned || _warned;

  if (env[name]) return env[name];

  var legacy = ALIASES[name] || [];
  for (var i = 0; i < legacy.length; i++) {
    if (!env[legacy[i]]) continue;
    if (!warned.has(legacy[i])) {
      warned.add(legacy[i]);
      warn("[config] " + legacy[i] + " is deprecated and will be removed in a future release; set " + name + " instead.");
    }
    return env[legacy[i]];
  }
  return undefined;
}

module.exports = {
  ALIASES: ALIASES,
  readConsoleEnv: readConsoleEnv,
};
