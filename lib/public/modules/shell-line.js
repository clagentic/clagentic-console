// shell-line.js - the pure parts of the composer's ! command line: which typed
// line is a command, and how a result reads. No DOM here, so the rules are
// testable on their own; user-shell.js draws and sends.

/**
 * The command a composer line carries, or null when the line is not one: a line
 * is a command when it starts with ! and something follows it.
 * @param {string} text - the composer's text, already trimmed
 * @returns {?string}
 */
export function parseShellLine(text) {
  if (typeof text !== "string" || text.charAt(0) !== "!") return null;
  var command = text.slice(1).trim();
  return command ? command : null;
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
  return Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s";
}

/**
 * How one shell_result reads: its state (for the card's style) and the status
 * line under the output. Every way a command can end says so in words.
 * @param {object} msg - a shell_result
 * @returns {{state: string, status: string}}
 */
export function describeResult(msg) {
  if (msg.refused) return { state: "refused", status: msg.reason || "The command was not run." };
  if (msg.denied) return { state: "denied", status: msg.reason || "The command was not approved, so it did not run." };
  if (msg.error) return { state: "error", status: "The command could not run." };
  var parts = [];
  if (msg.timedOut) parts.push("timed out and was stopped");
  else if (msg.interrupted) parts.push("interrupted");
  else if (msg.exitCode === null || msg.exitCode === undefined) parts.push("ended without an exit code");
  else parts.push("exit " + msg.exitCode);
  var took = formatDuration(msg.durationMs);
  if (took) parts.push(took);
  if (msg.truncated) parts.push("output cut at the size limit");
  var failed = msg.timedOut || msg.interrupted || (typeof msg.exitCode === "number" && msg.exitCode !== 0) ||
    msg.exitCode === null || msg.exitCode === undefined;
  return { state: failed ? "failed" : "ok", status: parts.join(" · ") };
}
