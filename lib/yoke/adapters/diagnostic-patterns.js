// diagnostic-patterns.js
// ----------------------
// Data-driven pattern table for mapping Claude CLI stderr lines to YOKE
// diagnostic events. Kept in a separate module so the table is testable in
// isolation from the worker process boundary (lr-28ee, epic lr-1a52).
//
// Adding a new pattern is a one-line data edit in PATTERNS below.
// No new conditional branches needed.

"use strict";

var validateDiagnosticEvent = require("../interface").validateDiagnosticEvent;

// VALID_HOOK_EVENTS (lr-e901): the CLI's own "Unknown hook event: X" stderr
// line is matched generically below (source:'hook') without knowing whether
// the Console's allowlist actually considers X unknown. settings-preflight.js
// is the single source of truth for that allowlist (see its header comment —
// "the ONLY place the valid hook events are defined"). Reuse it here instead
// of re-deriving a second copy, so a hook event added to the allowlist stops
// producing a false "unknown hook" toast from BOTH emission paths at once.
var VALID_HOOK_EVENTS = require("../../settings-preflight").VALID_HOOK_EVENTS;

// Matches the hook event name out of a CLI "Unknown hook event: <Name>" line.
var UNKNOWN_HOOK_EVENT_RE = /^Unknown hook event:\s*(\S+)/;

// ---------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------
// Each entry specifies how a CLI stderr line maps to a diagnostic event.
//
//   matcher  — string prefix (checked with indexOf === 0) or RegExp (.test())
//   severity — "info" | "warning" | "error"
//   source   — well-known DIAGNOSTIC_SOURCES value or other free-form string
//
// Order matters: the FIRST matching entry wins.
// ---------------------------------------------------------------------------

var PATTERNS = [
  // Claude Code settings validation warnings
  {
    matcher: "Settings Warning:",
    severity: "warning",
    source: "settings",
  },

  // AgentTeams-style hook event the CLI doesn't recognise (regression coverage lr-28ee)
  {
    matcher: "Unknown hook event",
    severity: "warning",
    source: "hook",
  },

  // Deprecation notices emitted by the CLI (both capitalisation forms appear in practice)
  {
    matcher: /deprecated/i,
    severity: "warning",
    source: "cli",
  },

  // Lines the CLI silently ignores (e.g. unknown config keys)
  {
    matcher: "Ignoring",
    severity: "info",
    source: "cli",
  },
];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Test whether a stderr line matches a pattern entry.
 *
 * @param {string}          line    - Trimmed, non-empty stderr line.
 * @param {Object}          pattern - Entry from PATTERNS.
 * @param {string|RegExp}   pattern.matcher
 * @returns {boolean}
 */
function matches(line, pattern) {
  var m = pattern.matcher;
  if (typeof m === "string") return line.indexOf(m) === 0;
  return m.test(line);
}

/**
 * Parse a single CLI stderr line against the pattern table.
 *
 * Returns a validated diagnostic event object when the line matches, or null
 * when no pattern matches (caller keeps the raw [CLI-STDERR] log only).
 *
 * The returned object always passes validateDiagnosticEvent — if the
 * constructed event is somehow invalid (e.g. empty message after trim), null
 * is returned and the parse failure is logged.
 *
 * @param {string} rawLine - Untrimmed stderr line (may be empty).
 * @returns {{ type: "diagnostic", severity: string, source: string, message: string }|null}
 */
function parseDiagnosticLine(rawLine) {
  var line = rawLine ? rawLine.trim() : "";
  if (!line) return null;

  for (var i = 0; i < PATTERNS.length; i++) {
    var pattern = PATTERNS[i];
    if (matches(line, pattern)) {
      // lr-e901: reconcile the CLI-stderr "Unknown hook event" path against
      // the Console's own VALID_HOOK_EVENTS allowlist (settings-preflight.js).
      // The CLI's stderr message reflects the *installed CLI version's*
      // knowledge of hook events, which can lag the allowlist verified here
      // (see settings-preflight.js header, lr-7e22). When the named event IS
      // in VALID_HOOK_EVENTS, treat this as a stale/false CLI warning and
      // suppress it rather than surfacing a contradictory toast — do not
      // widen the allowlist to "fix" this, the allowlist is already correct.
      var hookMatch = pattern.source === "hook" && UNKNOWN_HOOK_EVENT_RE.exec(line);
      if (hookMatch && VALID_HOOK_EVENTS.indexOf(hookMatch[1]) !== -1) {
        return null;
      }

      var event = {
        type: "diagnostic",
        severity: pattern.severity,
        source: pattern.source,
        // Bound to 500 chars — same ceiling the existing [CLI-STDERR] log uses
        message: line.substring(0, 500),
      };

      try {
        validateDiagnosticEvent(event);
      } catch (e) {
        // Should not happen with valid PATTERNS entries; log and skip
        console.error("[diagnostic-patterns] invalid diagnostic event constructed:", e.message);
        return null;
      }

      return event;
    }
  }

  return null;
}

module.exports = {
  PATTERNS: PATTERNS,
  parseDiagnosticLine: parseDiagnosticLine,
};
