"use strict";

// The one Claude Code permission rule the installer registers, so a lane or an
// orchestrator can read session liveness and pending prompts without raising a
// prompt itself. Adds to the user's Claude Code settings file; never removes or
// rewrites anything else, and never overwrites a file it cannot parse.

var path = require("path");
var crypto = require("crypto");

var ALLOW_RULE = "Bash(clagentic-console list-sessions *)";

// Claude Code reads its user settings from $CLAUDE_CONFIG_DIR when set, else
// <home>/.claude.
function settingsPathFor(env, home) {
  var dir = env && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  return path.join(dir, "settings.json");
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// The temp file gets an unpredictable name in the target's directory and is
// created exclusively ("wx"), so a pre-planted file or link at a guessable name
// is never written through. Settings can hold secrets, hence 0600 when the
// target does not exist yet.
function write(fsx, file, doc, mode) {
  var tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fsx.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: mode || 0o600, flag: "wx" });
    fsx.renameSync(tmp, file);
  } catch (err) {
    try {
      fsx.unlinkSync(tmp);
    } catch (cleanupErr) {
      if (!cleanupErr || cleanupErr.code !== "ENOENT") throw err;
    }
    throw err;
  }
}

// A symlinked settings.json is followed: the link's target is rewritten and the
// link itself is left in place. A link whose target cannot be resolved is not
// replaced by a regular file; the caller skips it with a warning.
function resolveTarget(fsx, file) {
  var link = false;
  try {
    link = fsx.lstatSync(file).isSymbolicLink();
  } catch (e) {
    return file;
  }
  if (!link) return file;
  try {
    return fsx.realpathSync(file);
  } catch (e) {
    return null;
  }
}

/**
 * Ensure settings.permissions.allow holds ALLOW_RULE, exactly once.
 * @param {object} fsx - readFileSync, statSync, lstatSync, realpathSync,
 *   writeFileSync, renameSync, unlinkSync, mkdirSync
 * @param {string} file - the settings file
 * @param {function(string)} log
 * @returns {"added"|"present"|"skipped"}
 *   skipped: the file was left untouched (unreadable, not valid JSON, or not
 *   the shape the rule can be added to) and a warning was logged.
 */
function ensureAllowRule(fsx, settingsFile, log) {
  var file = resolveTarget(fsx, settingsFile);
  if (file === null) {
    log("WARNING: " + settingsFile + " is a symlink that does not resolve; not adding " + ALLOW_RULE);
    return "skipped";
  }
  var doc;
  var mode;
  try {
    var raw = fsx.readFileSync(file, "utf8");
    try {
      mode = fsx.statSync(file).mode & 0o777;
    } catch (e) {
      mode = undefined;
    }
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      log("WARNING: " + file + " is not valid JSON; not adding " + ALLOW_RULE + " (add it by hand)");
      return "skipped";
    }
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      log("WARNING: could not read " + file + ": " + (err && err.message) + "; not adding " + ALLOW_RULE);
      return "skipped";
    }
    doc = {};
  }
  if (!isPlainObject(doc)) {
    log("WARNING: " + file + " is not a JSON object; not adding " + ALLOW_RULE);
    return "skipped";
  }
  if (doc.permissions === undefined) doc.permissions = {};
  if (!isPlainObject(doc.permissions)) {
    log("WARNING: \"permissions\" in " + file + " is not an object; not adding " + ALLOW_RULE);
    return "skipped";
  }
  if (doc.permissions.allow === undefined) doc.permissions.allow = [];
  if (!Array.isArray(doc.permissions.allow)) {
    log("WARNING: \"permissions.allow\" in " + file + " is not a list; not adding " + ALLOW_RULE);
    return "skipped";
  }
  if (doc.permissions.allow.indexOf(ALLOW_RULE) !== -1) return "present";
  doc.permissions.allow.push(ALLOW_RULE);
  try {
    write(fsx, file, doc, mode);
  } catch (err) {
    log("WARNING: could not write " + file + ": " + err.message + "; not adding " + ALLOW_RULE);
    return "skipped";
  }
  log("added " + ALLOW_RULE + " to " + file);
  return "added";
}

module.exports = { ALLOW_RULE: ALLOW_RULE, settingsPathFor: settingsPathFor, ensureAllowRule: ensureAllowRule };
