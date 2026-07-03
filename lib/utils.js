/**
 * Shared utility functions.
 */

var fs = require("fs");

/**
 * Encode a cwd path into a filesystem-safe directory/file name.
 * Replaces all non-alphanumeric characters with hyphens, matching
 * Claude Code CLI's encoding logic exactly (/[^a-zA-Z0-9]/g -> "-").
 *
 * Example: "/Users/jon.doe_42/my project" -> "-Users-jon-doe-42-my-project"
 */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Legacy encoding (pre-#182 fix). Only slashes and dots were replaced.
 * Used for fallback resolution of on-disk data written before the fix.
 */
function legacyEncodeCwd(cwd) {
  return cwd.replace(/[\/\.]/g, "-");
}

/**
 * Try candidate encoded names against a base directory.
 * Returns the first match that exists on disk, or the first candidate
 * (newest encoding) if none exist yet.
 */
function resolveEncoded(baseDir, cwd, ext, checkFn) {
  var newEncoded = encodeCwd(cwd);
  var legacyEncoded = legacyEncodeCwd(cwd);
  if (newEncoded === legacyEncoded) return newEncoded;
  var full = baseDir + "/" + newEncoded + (ext || "");
  try { if (checkFn(full)) return newEncoded; } catch (e) {}
  var legacyFull = baseDir + "/" + legacyEncoded + (ext || "");
  try { if (checkFn(legacyFull)) return legacyEncoded; } catch (e) {}
  return newEncoded;
}

/**
 * Resolve an encoded directory path with legacy fallback.
 */
function resolveEncodedDir(baseDir, cwd) {
  return resolveEncoded(baseDir, cwd, "", function(p) {
    return fs.statSync(p).isDirectory();
  });
}

/**
 * Resolve an encoded file path with legacy fallback.
 */
function resolveEncodedFile(baseDir, cwd, ext) {
  return resolveEncoded(baseDir, cwd, ext, function(p) {
    return fs.statSync(p).isFile();
  });
}

/**
 * Sanitize a persisted `allowedTools` map before hydrating it into a live
 * session (lr-8b2e). The value originates from a durable .jsonl meta record
 * that shares its trust boundary with other session-file fields, but an
 * un-validated shape would let a crafted record (e.g. {"Bash": "yes"} or a
 * non-object) auto-approve a tool with no operator click at the
 * handleCanUseTool check (lib/sdk-bridge.js:691).
 *
 * Keeps only entries whose key is a string and whose value is strictly
 * boolean `true`; drops everything else. A non-object input (including
 * null/undefined/arrays) yields {} rather than throwing.
 */
function sanitizeAllowedTools(value) {
  var out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof key === "string" && value[key] === true) out[key] = true;
  }
  return out;
}

module.exports = {
  encodeCwd: encodeCwd,
  resolveEncodedDir: resolveEncodedDir,
  resolveEncodedFile: resolveEncodedFile,
  sanitizeAllowedTools: sanitizeAllowedTools,
};
