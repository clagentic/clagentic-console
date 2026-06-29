// lite-detect.js — Passive detection of Clagentic: Lite installation.
//
// All functions are synchronous and safe to call at any time.
// If Lite is not installed, every function returns a falsy / "not enrolled" result
// with no error thrown and no log output.

var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");
var { CLAGENTIC_HOME, REAL_HOME } = require("./config");

// Lite home: ~/.clagentic/lite/ — Lite is a sibling tool that owns its own product
// folder under the shared ~/.clagentic/ root (lr-dc6c, lr-6204).
// Console owns ~/.clagentic/console/; Lite owns ~/.clagentic/lite/.
// Override: CLAGENTIC_LITE_HOME env var (matches clagentic-lite/bin/clagentic-lite:33).
function getLiteHome() {
  return process.env.CLAGENTIC_LITE_HOME || path.join(CLAGENTIC_HOME, "lite");
}

// Return true when the Lite home directory exists.
function liteHomeDirExists() {
  try {
    return fs.existsSync(getLiteHome());
  } catch (e) {
    return false;
  }
}

// Candidate paths for the clagentic-lite binary (checked in order).
// PATH resolution is attempted first via `which`, then common user-local paths.
var LITE_BINARY_NAME = "clagentic-lite";
var LITE_CANDIDATE_PATHS = [
  path.join(REAL_HOME, ".local", "bin", LITE_BINARY_NAME),
  path.join(REAL_HOME, "bin", LITE_BINARY_NAME),
];

function binaryExists() {
  // 1. Try PATH resolution
  try {
    execFileSync("which", [LITE_BINARY_NAME], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch (e) { /* not on PATH */ }

  // 2. Check common user-local locations
  for (var i = 0; i < LITE_CANDIDATE_PATHS.length; i++) {
    try {
      if (fs.existsSync(LITE_CANDIDATE_PATHS[i])) return true;
    } catch (e) { /* keep checking */ }
  }
  return false;
}

/**
 * Detect whether Clagentic: Lite is installed.
 *
 * Returns:
 *   { installed: true,  liteHome: "/home/user/.clagentic/lite" }
 *   { installed: false, liteHome: null }
 *
 * Detection is passive — no subprocess is spawned for the main check.
 * `which` is used only as a PATH lookup fallback and its failure is silently swallowed.
 */
function detectLite() {
  var homeExists = liteHomeDirExists();
  var binExists = binaryExists();
  if (homeExists && binExists) {
    return { installed: true, liteHome: getLiteHome() };
  }
  return { installed: false, liteHome: null };
}

/**
 * Check per-project enrollment status.
 *
 * Returns true if <projectDir>/.clagentic/lite/audit.db exists.
 */
function isProjectEnrolled(projectDir) {
  if (!projectDir) return false;
  try {
    return fs.existsSync(path.join(projectDir, ".clagentic", "lite", "audit.db"));
  } catch (e) {
    return false;
  }
}

module.exports = {
  detectLite: detectLite,
  isProjectEnrolled: isProjectEnrolled,
  getLiteHome: getLiteHome,
  // Exported for testing
  liteHomeDirExists: liteHomeDirExists,
  binaryExists: binaryExists,
};
