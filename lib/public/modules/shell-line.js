// shell-line.js - the pure parts of the composer's ! command line: which typed
// line is a command, and how a result reads. No DOM here, so the rules are
// testable on their own; user-shell.js draws and sends.

/**
 * The command a composer line carries, or null when the line is not one. A line
 * is a command when it starts with ! (leading whitespace aside) and a command
 * follows. Only the ! and the whitespace right after it are removed: the rest is
 * the command exactly as typed, so a trailing escaped space is part of it.
 * @param {string} raw - the composer's text as typed, not trimmed
 * @returns {?string}
 */
export function parseShellLine(raw) {
  if (typeof raw !== "string") return null;
  var line = raw.replace(/^\s+/, "");
  if (line.charAt(0) !== "!") return null;
  var command = line.slice(1).replace(/^\s+/, "");
  return command.trim() ? command : null;
}

/**
 * The command a composer line carries once its collapsed paste chips are folded
 * in. A chip is kept out of the textarea, so the line alone cannot say what runs.
 * The typed tail (cleaned as parseShellLine does) comes first, then each paste in
 * the order it was added, joined by newlines. The console keeps no cursor
 * position for a chip, so pastes follow the typed text rather than sitting where
 * they were dropped. A blank tail adds nothing, so "!" plus a paste is the paste.
 * @param {string} raw - the composer's text as typed, not trimmed
 * @param {string[]} pastes - the text of each paste chip, in paste order
 * @returns {?string} null when the line is not a command or the result is blank
 */
export function shellCommandFrom(raw, pastes) {
  if (typeof raw !== "string") return null;
  var line = raw.replace(/^\s+/, "");
  if (line.charAt(0) !== "!") return null;
  var tail = line.slice(1).replace(/^\s+/, "");
  var parts = tail.trim() ? [tail] : [];
  (Array.isArray(pastes) ? pastes : []).forEach(function (p) {
    if (typeof p === "string") parts.push(p);
  });
  var command = parts.join("\n");
  return command.trim() ? command : null;
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
  if (msg.refused) return { state: "refused", status: msg.message || msg.reason || "The command was not run." };
  if (msg.denied) return { state: "denied", status: msg.message || msg.reason || "The command was not approved, so it did not run." };
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
