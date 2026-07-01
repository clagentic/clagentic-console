// diagnostic-format.js — Pure formatting helpers for diagnostic messages.
// No DOM dependencies; importable in unit tests directly.
// Part of epic lr-1a52 stage 4/5 (lr-8294).

// Human-readable labels for known diagnostic source identifiers.
// Sources from stage 5/5 (lr-1a26) preflight may add new entries here;
// the default falls back to the raw source string.
var SOURCE_LABELS = {
  hook: "Hook",
  cli: "CLI",
  settings: "Settings",
  stderr: "CLI",
  preflight: "Preflight",
};

// Terse scope suffixes shown alongside the source label (lr-7e22). Settings
// preflight runs against both ~/.claude/settings.json and the project's
// .claude/settings.json independently, emitting one diagnostic per unknown
// key per file — without a scope suffix, two distinct warnings render an
// identical "Preflight" header and visually stack as apparent duplicates.
var SCOPE_LABELS = {
  user: "user",
  project: "project",
};

/**
 * Format a raw diagnostic source identifier for display.
 * @param {string} source - The source field from the diagnostic message.
 * @param {string} [scope] - Optional file/config scope ('user' | 'project').
 *                           When present and recognized, appended to the
 *                           source label so diagnostics from different
 *                           scopes are distinguishable at a glance.
 * @returns {string} Human-readable source label.
 */
export function formatDiagnosticSource(source, scope) {
  if (!source) return "Diagnostic";
  var label = SOURCE_LABELS[source] || source;
  var scopeLabel = scope && SCOPE_LABELS[scope];
  return scopeLabel ? label + " · " + scopeLabel : label;
}

/**
 * Map severity to a short display label.
 * @param {string} severity - 'info' | 'warning' | 'error'
 * @returns {string}
 */
export function formatDiagnosticSeverity(severity) {
  if (!severity) return "INFO";
  return severity.toUpperCase();
}
