"use strict";

// codex-binary.js - finds the Codex the user installed and says whether the
// console can drive it. The console ships no Codex of its own: a binary is
// resolved in this order, the first one found is the one used, and it is
// validated by asking it for its version.
//
//   1. CLAGENTIC_CONSOLE_CODEX_PATH (an absolute path the operator chose)
//   2. `codex` on PATH
//   3. common install locations
//
// The lookup is the daemon account's. Codex is not run under per-user OS
// isolation (the agent is disabled in that mode), so there is no per-user
// lookup.

var fs = require("fs");
var path = require("path");
var versions = require("./codex-version");
var codexCommand = require("./codex-command");

var CODEX_PATH_ENV = "CLAGENTIC_CONSOLE_CODEX_PATH";
var VERSION_TIMEOUT_MS = 5000;
var CACHE_TTL_MS = 30000;
var INSTALL_REASON = "Codex is not installed. Install it with: npm install -g @openai/codex, then use Re-check.";

var CODES = Object.freeze({
  absent: "CODEX_ABSENT",
  tooOld: "CODEX_TOO_OLD",
  invalidOverride: "CODEX_OVERRIDE_INVALID",
  unusable: "CODEX_UNUSABLE",
});

function tooOldReason(found) {
  return "Codex " + found + " is too old; Clagentic: Console needs " + versions.MIN_CODEX_VERSION + " or newer";
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch (e) {
    // A path that is not there, or not ours to run, is not a candidate.
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EACCES" || e.code === "EPERM")) return false;
    throw e;
  }
}

var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The file names `codex` can have: on Windows the PATHEXT extensions, else the
 * bare name. A native executable is listed before a .cmd/.bat shim whatever
 * PATHEXT says, since a shim has to be run through the command interpreter.
 */
function executableNames(platform, pathext) {
  if (platform !== "win32") return ["codex"];
  var extensions = String(pathext || DEFAULT_PATHEXT).split(";").map(function (e) { return e.trim(); }).filter(Boolean);
  var names = extensions.map(function (e) { return "codex" + e.toLowerCase(); });
  var direct = names.filter(function (n) { return !codexCommand.isShim(n, "win32"); });
  var shims = names.filter(function (n) { return codexCommand.isShim(n, "win32"); });
  return direct.concat(shims, ["codex"]);
}

/**
 * `codex` on a PATH string, first match, without starting a process. On win32
 * the PATHEXT extensions are tried (codex.cmd, codex.exe), as a shell would.
 * @param {string} pathVar
 * @param {function(string): boolean} isExecutable
 * @param {{platform: ?string, pathext: ?string}} [options]
 */
function findOnPath(pathVar, isExecutable, options) {
  var opts = options || {};
  var platform = opts.platform || process.platform;
  var pathMod = platform === "win32" ? path.win32 : path;
  var names = executableNames(platform, opts.pathext);
  var dirs = String(pathVar || "").split(pathMod.delimiter).filter(Boolean);
  for (var i = 0; i < dirs.length; i++) {
    if (!pathMod.isAbsolute(dirs[i])) continue;
    for (var j = 0; j < names.length; j++) {
      var candidate = pathMod.join(dirs[i], names[j]);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** The places a global install usually ends up, per-user ones first. */
function commonLocations(home) {
  var list = [];
  if (home) {
    ["/.npm-global/bin/codex", "/.local/bin/codex", "/.volta/bin/codex", "/.bun/bin/codex", "/bin/codex"].forEach(function (rel) {
      list.push(home + rel);
    });
  }
  return list.concat(["/usr/local/bin/codex", "/usr/bin/codex", "/opt/homebrew/bin/codex"]);
}

/** The lookups, in the daemon's PATH and home. */
function defaultDeps(env, commandDeps) {
  return {
    isExecutable: isExecutableFile,
    pathLookup: function () {
      return { path: findOnPath(env.PATH || env.Path, isExecutableFile, { pathext: env.PATHEXT }) };
    },
    home: function () {
      return env.HOME || require("os").homedir();
    },
    runVersion: function (binary) {
      var options = { timeout: VERSION_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env };
      return codexCommand.execCodexSync(binary, ["--version"], options, commandDeps);
    },
  };
}

function failureOf(error) {
  var stderr = error && error.stderr ? String(error.stderr).trim().split("\n")[0] : "";
  return stderr || (error && error.message) || "unknown error";
}

/** Asks one candidate for its version and judges it against the floor. */
function validate(candidate, source, deps) {
  var text;
  try {
    text = deps.runVersion(candidate);
  } catch (e) {
    return { state: "unusable", code: CODES.unusable, path: candidate, source: source,
      reason: "Codex at " + candidate + " could not report its version: " + failureOf(e) };
  }
  var parsed = versions.parseVersion(String(text));
  if (!parsed) {
    return { state: "unusable", code: CODES.unusable, path: candidate, source: source,
      reason: "Codex at " + candidate + " reported a version that could not be read" };
  }
  if (versions.compareVersions(parsed, versions.MIN_CODEX_VERSION) < 0) {
    return { state: "too-old", code: CODES.tooOld, path: candidate, source: source, version: parsed.text, reason: tooOldReason(parsed.text) };
  }
  return { state: "ready", path: candidate, source: source, version: parsed.text };
}

function resolveOverride(value, deps) {
  var chosen = String(value).trim();
  function invalid(reason) {
    return { state: "invalid-override", code: CODES.invalidOverride, path: chosen, source: "override",
      reason: CODEX_PATH_ENV + " is set to " + chosen + ", but " + reason };
  }
  if (!path.isAbsolute(chosen)) return invalid("it is not an absolute path");
  if (!deps.isExecutable(chosen)) return invalid("no executable file is there");
  var result = validate(chosen, "override", deps);
  if (result.state === "unusable") return invalid("it could not report a version");
  return result;
}

/**
 * Resolves the Codex the console would run.
 * @param {{env: ?object, deps: ?object}} [options]
 *   env is the daemon's environment (the override and PATH are read from it)
 * @returns {{state: string, path: ?string, version: ?string, source: ?string, reason: ?string, code: ?string}}
 *   state: ready | absent | too-old | invalid-override | unusable
 */
function resolveCodexBinary(options) {
  var opts = options || {};
  var env = opts.env || process.env;
  var deps = opts.deps || defaultDeps(env, opts.commandDeps);

  var override = env[CODEX_PATH_ENV];
  if (typeof override === "string" && override.trim()) return resolveOverride(override, deps);

  var onPath = deps.pathLookup();
  if (onPath.path) return validate(onPath.path, "path", deps);

  var locations = commonLocations(deps.home());
  for (var i = 0; i < locations.length; i++) {
    if (deps.isExecutable(locations[i])) return validate(locations[i], "location", deps);
  }
  return { state: "absent", code: CODES.absent, reason: INSTALL_REASON };
}

/** The error a caller that cannot go on without a usable Codex throws. */
function errorFor(result) {
  var err = new Error(result.reason || "Codex is not available");
  err.code = result.code || CODES.unusable;
  err.resolution = result;
  return err;
}

// Resolutions are cached: resolving runs the binary, and every project asks.
var _cache = new Map();

function cacheKey(opts) {
  var env = opts.env || process.env;
  // Every value the lookup reads: the override, PATH under both spellings
  // (win32 uses Path), PATHEXT and the home the common locations hang from.
  return JSON.stringify([env[CODEX_PATH_ENV] || "", env.PATH || "", env.Path || "", env.PATHEXT || "", env.HOME || ""]);
}

/**
 * resolveCodexBinary, remembered for a short time. `fresh` looks again.
 * Tests and callers that inject lookups bypass the cache.
 */
function resolveCached(options) {
  var opts = options || {};
  if (opts.deps) return resolveCodexBinary(opts);
  var key = cacheKey(opts);
  var hit = _cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  var result = resolveCodexBinary(opts);
  _cache.set(key, { at: Date.now(), result: result });
  return result;
}

/** Forgets what was found, so the next resolution looks again. */
function invalidate() {
  _cache.clear();
}

/** The usable resolution, or the named error. */
function requireCodex(options) {
  var result = resolveCached(options);
  if (result.state !== "ready") throw errorFor(result);
  return result;
}

/**
 * The resolution as the install probe and the picker report it.
 * @returns {{installed: boolean, detail: {path: ?string, version: ?string, source: ?string, reason: ?string}}}
 */
function describe(result) {
  return {
    installed: result.state === "ready",
    detail: {
      path: result.path || null,
      version: result.version || null,
      source: result.source || null,
      reason: result.state === "ready" ? null : (result.reason || null),
    },
  };
}

module.exports = {
  CODEX_PATH_ENV: CODEX_PATH_ENV,
  CODES: CODES,
  INSTALL_REASON: INSTALL_REASON,
  commonLocations: commonLocations,
  findOnPath: findOnPath,
  resolveCodexBinary: resolveCodexBinary,
  resolveCached: resolveCached,
  requireCodex: requireCodex,
  errorFor: errorFor,
  describe: describe,
  invalidate: invalidate,
  // Exported so a test can show every value the lookup reads is in the key.
  _test_cacheKey: cacheKey,
};
