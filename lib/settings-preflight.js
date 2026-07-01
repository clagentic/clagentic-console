// settings-preflight.js — Console-side settings.json preflight validator.
//
// Part of epic lr-1a52 stage 5/5 (lr-1a26): deterministic, version-independent
// preflight that validates ~/.claude/settings.json and project .claude/settings.json
// without relying on CLI stderr pattern matching.
//
// Public surface:
//   validateSettingsObject(obj, filePath, scope) — pure: settings obj → diagnostic[]
//   runPreflight(opts)                           — IO: reads files, validates, returns diagnostic[]
//   VALID_HOOK_EVENTS                            — exported for tests
//
// Diagnostic shape (conforms to validateDiagnosticEvent from YOKE interface):
//   { type: 'diagnostic', severity, source: 'preflight', scope?: 'user'|'project', message }
//
// scope (lr-7e22) distinguishes which settings file a diagnostic came from —
// runPreflight checks both ~/.claude/settings.json (scope:'user') and
// <projectDir>/.claude/settings.json (scope:'project') independently, so a
// single unknown hook key can legitimately produce one diagnostic per file.
// The render layer (diagnostic-format.js) uses scope to keep those visually
// distinct instead of both showing an identical "Preflight" source label.

"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// Hook event allowlist
//
// SOURCE: Verified live against the Claude Code hooks documentation
// (https://code.claude.com/docs/en/hooks, hook lifecycle table) as of
// 2026-07-01, cross-checked via web search. The hooks.AgentTeams case (the
// motivating screenshot for this stage) is a real example of an unknown key
// that surfaces as a silent no-op in the CLI but clutters the warnings stream.
// The 8 events added under lr-7e22 (PreCompact, PostCompact, SessionStart,
// UserPromptSubmit, PermissionRequest, TaskCreated, TeammateIdle,
// TaskCompleted) were confirmed present in that same table — they are not an
// exhaustive list of all documented events (the docs list ~30 total as of
// this sync), only the ones observed in the field that needed verification.
//
// IMPORTANT: This list is the ONLY place the valid hook events are defined in
// the Console codebase. Do not duplicate it elsewhere — drift between copies
// is exactly the parity bug we are fixing.
//
// TODO(lr-1a26): Sync this list whenever the Claude Code CLI releases new hook
// event types. The authoritative upstream is the CLI's hook documentation
// (https://code.claude.com/docs/en/hooks) or source (search for "hook" +
// "event" in the @anthropic-ai/claude-code package). Consider scripting a CI
// check against the installed CLI version's known events if the CLI exposes
// a machine-readable list in a future release.
// ---------------------------------------------------------------------------
var VALID_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  // lr-7e22: verified 2026-07-01 against code.claude.com/docs/en/hooks
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "TaskCreated",
  "TeammateIdle",
  "TaskCompleted",
];

// ---------------------------------------------------------------------------
// Pure validator
// ---------------------------------------------------------------------------

/**
 * Validate a parsed settings object for known structural problems.
 *
 * Pure function — no IO, no side effects. Suitable for unit testing.
 *
 * @param {object} obj      - Parsed settings JSON (any shape; we check what we know)
 * @param {string} filePath - Path string used only in diagnostic messages
 * @param {string} [scope]  - 'user' | 'project', attached to each diagnostic so the
 *                            render layer can distinguish which settings file a
 *                            warning came from (lr-7e22). Omitted when the caller
 *                            has no file-scope context (e.g. direct unit tests).
 * @returns {Array<{type,severity,source,scope,message}>} Diagnostics (empty = no issues)
 */
function validateSettingsObject(obj, filePath, scope) {
  var diagnostics = [];
  var label = filePath || "settings.json";

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    // Nothing meaningful to validate — caller should have caught this at parse time
    return diagnostics;
  }

  // (b) Known-hook-event allowlist check.
  // The hooks field is expected to be an object whose keys are hook event names.
  // Unknown keys silently no-op in the CLI but should warn operators.
  if (obj.hooks !== null && obj.hooks !== undefined) {
    if (typeof obj.hooks !== "object" || Array.isArray(obj.hooks)) {
      diagnostics.push({
        type: "diagnostic",
        severity: "warning",
        source: "preflight",
        scope: scope || undefined,
        message: label + ": 'hooks' field is not an object — expected { EventName: [...] }.",
      });
    } else {
      var hookKeys = Object.keys(obj.hooks);
      for (var i = 0; i < hookKeys.length; i++) {
        var key = hookKeys[i];
        if (VALID_HOOK_EVENTS.indexOf(key) === -1) {
          diagnostics.push({
            type: "diagnostic",
            severity: "warning",
            source: "preflight",
            scope: scope || undefined,
            message: label + ": unknown hook event '" + key + "'. Valid events: " + VALID_HOOK_EVENTS.join(", ") + ". This hook will be silently ignored by the CLI.",
          });
        }
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

/**
 * Validate a single settings.json file.
 *
 * Returns an array of diagnostic objects:
 *   - Empty array    → file absent, or file is clean (silence is success)
 *   - error entry    → file exists but failed JSON.parse
 *   - warning entries → file parsed but has structural problems
 *
 * Never throws — all errors are surfaced as diagnostics or swallowed
 * per the non-blocking preflight contract.
 *
 * @param {string} filePath - Absolute path to settings.json
 * @param {string} [scope]  - 'user' | 'project', attached to each diagnostic (lr-7e22)
 *                            so multiple legitimate warnings across files render as
 *                            visibly distinct entries instead of stacking as apparent
 *                            duplicates. Optional — omitted when the caller has no
 *                            file-scope context.
 * @returns {Array<object>} diagnostics
 */
function validateSettingsFile(filePath, scope) {
  var diagnostics = [];

  // Missing file → nothing to validate. Not an error.
  var raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return diagnostics;
    // Unreadable file (permissions etc.) → low-severity, not user-facing error
    diagnostics.push({
      type: "diagnostic",
      severity: "info",
      source: "preflight",
      scope: scope || undefined,
      message: filePath + ": could not read settings file (" + e.code + " — " + (e.message || String(e)) + ").",
    });
    return diagnostics;
  }

  // (a) JSON parse check
  var obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    diagnostics.push({
      type: "diagnostic",
      severity: "error",
      source: "preflight",
      scope: scope || undefined,
      message: filePath + ": settings.json is not valid JSON — " + (e.message || String(e)) + ".",
    });
    return diagnostics;
  }

  // (b) Structural validation
  var structural = validateSettingsObject(obj, filePath, scope);
  for (var i = 0; i < structural.length; i++) {
    diagnostics.push(structural[i]);
  }

  return diagnostics;
}

/**
 * Run the full preflight check against both user and project settings files.
 *
 * @param {object} opts
 * @param {string} [opts.userHome]    - Home directory to find ~/.claude/settings.json.
 *                                      Resolved via REAL_HOME from config.js when absent.
 * @param {string} [opts.projectDir]  - Project working directory to find .claude/settings.json.
 *                                      When absent (or empty), project settings are skipped.
 * @returns {Array<object>} All diagnostics across both files (empty = all clean)
 */
function runPreflight(opts) {
  opts = opts || {};

  var diagnostics = [];

  // Resolve the user home from config.js (honours SUDO_USER resolution),
  // falling back to os.homedir() if the module is unavailable.
  // The REAL_HOME constant in config.js is already resolved on module load —
  // reading it here is free (no IO, no side effect).
  var userHome = opts.userHome;
  if (!userHome) {
    try {
      userHome = require("./config").REAL_HOME;
    } catch (e) {
      userHome = os.homedir();
    }
  }

  // User global: ~/.claude/settings.json
  var userSettingsPath = path.join(userHome, ".claude", "settings.json");
  var userDiags = validateSettingsFile(userSettingsPath, "user");
  for (var i = 0; i < userDiags.length; i++) {
    diagnostics.push(userDiags[i]);
  }

  // Project-local: <projectDir>/.claude/settings.json (optional)
  var projectDir = opts.projectDir;
  if (projectDir && typeof projectDir === "string" && projectDir.length > 0) {
    var projectSettingsPath = path.join(projectDir, ".claude", "settings.json");
    var projectDiags = validateSettingsFile(projectSettingsPath, "project");
    for (var j = 0; j < projectDiags.length; j++) {
      diagnostics.push(projectDiags[j]);
    }
  }

  return diagnostics;
}

module.exports = {
  VALID_HOOK_EVENTS: VALID_HOOK_EVENTS,
  validateSettingsObject: validateSettingsObject,
  validateSettingsFile: validateSettingsFile,
  runPreflight: runPreflight,
};
