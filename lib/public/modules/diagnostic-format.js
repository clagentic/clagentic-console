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

/**
 * Format a raw diagnostic source identifier for display.
 * @param {string} source - The source field from the diagnostic message.
 * @returns {string} Human-readable source label.
 */
export function formatDiagnosticSource(source) {
  if (!source) return "Diagnostic";
  return SOURCE_LABELS[source] || source;
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
