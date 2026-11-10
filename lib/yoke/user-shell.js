"use strict";

// One shell command the person typed for themselves, run by the console for an
// agent that has no call of its own for it, and the text that records it in the
// agent's transcript. Adapters call this; the callers above the adapter go
// through QueryHandle.runUserShellCommand and never reach this module.
//
// The command runs through the platform shell, in the given directory, with the
// environment the caller hands over, under the identity of the console process:
// this module never changes uid.

var { spawn } = require("child_process");

// After the shell exits, how long to wait for its output pipes to close before
// settling anyway: a background process the command left behind can hold them.
var PIPE_DRAIN_GRACE_MS = 250;

function warnUnlessGone(err) {
  if (err && err.code !== "ESRCH") console.warn("[yoke/user-shell] could not stop the command:", err.message);
}

function truncationMarker(maxBytes) {
  return "\n[output truncated at " + maxBytes + " bytes]";
}

// A buffer cut at an arbitrary byte can end inside a multibyte character, which
// would decode to U+FFFD. Drops that partial character from the end, so what is
// kept is whole characters and never more than was kept before.
function dropPartialChar(buf) {
  var lead = buf.length - 1;
  var back = 0;
  while (lead >= 0 && back < 3 && (buf[lead] & 0xC0) === 0x80) { lead--; back++; }
  if (lead < 0) return buf;
  var b = buf[lead];
  var width = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
  return width > buf.length - lead ? buf.subarray(0, lead) : buf;
}

// Keeps at most maxBytes of buf, backed off to a character boundary.
function cutBuffer(buf, maxBytes) {
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), cut: false };
  return { text: dropPartialChar(buf.subarray(0, maxBytes)).toString("utf8"), cut: true };
}

/**
 * Cuts text to at most maxBytes of UTF-8, with the truncation marker when it cut.
 * The cut backs off to a character boundary.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{output: string, truncated: boolean}}
 */
function capText(text, maxBytes) {
  var kept = cutBuffer(Buffer.from(String(text == null ? "" : text), "utf8"), maxBytes);
  return { output: kept.cut ? kept.text + truncationMarker(maxBytes) : kept.text, truncated: kept.cut };
}

/**
 * Runs a command to its end, its timeout, or an interrupt.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string} opts.cwd
 * @param {number} opts.timeoutMs      the command's process group is killed when it runs longer
 * @param {number} opts.maxOutputBytes output kept; the rest is read and dropped
 * @param {object} [opts.env]          default: the console process's own
 * @param {AbortSignal} [opts.signal]  aborting kills the command's process group
 * @returns {Promise<{exitCode: ?number, durationMs: number, output: string,
 *   truncated: boolean, timedOut: boolean, interrupted: boolean}>}
 */
function runShellCommand(opts) {
  var started = Date.now();
  var maxBytes = opts.maxOutputBytes;
  var signal = opts.signal || null;

  return new Promise(function (resolve) {
    var chunks = [];
    var kept = 0;
    var readTruncated = false;
    var timedOut = false;
    var interrupted = false;
    var settled = false;
    var drainTimer = null;
    var timeoutTimer = null;
    var child = null;

    function finish(exitCode, extraOutput) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(drainTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      // The cap is applied to everything the person is shown, the failure text
      // included, so no text added here can push the output past it.
      var buf = Buffer.concat(chunks);
      if (extraOutput) buf = Buffer.concat([buf, Buffer.from((buf.length ? "\n" : "") + extraOutput, "utf8")]);
      // Bytes dropped while reading mean the kept ones may end inside a character.
      var result = readTruncated
        ? { text: dropPartialChar(buf.subarray(0, maxBytes)).toString("utf8"), cut: true }
        : cutBuffer(buf, maxBytes);
      var truncated = readTruncated || result.cut;
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        durationMs: Date.now() - started,
        output: truncated ? result.text + truncationMarker(maxBytes) : result.text,
        truncated: truncated,
        timedOut: timedOut,
        interrupted: interrupted,
      });
    }

    function killTree() {
      if (!child || !child.pid) return;
      try {
        // The command's own process group, so what it started dies with it.
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        warnUnlessGone(err);
      }
    }

    function onAbort() {
      interrupted = true;
      killTree();
    }

    function collect(chunk) {
      var room = maxBytes - kept;
      if (room <= 0) { readTruncated = true; return; }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept += room;
        readTruncated = true;
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    }

    if (signal && signal.aborted) {
      interrupted = true;
      finish(null, null);
      return;
    }

    try {
      child = spawn(opts.command, {
        shell: true,
        cwd: opts.cwd,
        env: opts.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      finish(null, "Could not start the command: " + err.message);
      return;
    }

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", function (err) {
      finish(null, "Could not run the command: " + err.message);
    });
    child.on("exit", function (code) {
      // The command is over: a timeout that fires during the drain must not mark
      // it as timed out.
      clearTimeout(timeoutTimer);
      drainTimer = setTimeout(function () { finish(code, null); }, PIPE_DRAIN_GRACE_MS);
    });
    child.on("close", function (code) {
      finish(code, null);
    });

    timeoutTimer = setTimeout(function () {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function escapeAngles(text) {
  return String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The text that records a finished command in an agent's conversation. The
 * command and its output are data a program (or a hostile file) can shape, so
 * angle brackets in them are escaped: the wrapper's own tags are then the only
 * tags in the block, and output cannot close it early and pose as what follows.
 *
 * @param {string} command
 * @param {{exitCode: ?number, durationMs: number, output: string, truncated: boolean,
 *   timedOut: boolean, interrupted?: boolean}} result
 * @returns {string}
 */
function formatTranscriptText(command, result) {
  var lines = [
    "<user_shell_command>",
    "<command>" + escapeAngles(command) + "</command>",
    "<exit_code>" + (result.exitCode === null || result.exitCode === undefined ? "none" : result.exitCode) + "</exit_code>",
    "<duration_ms>" + Math.round(result.durationMs || 0) + "</duration_ms>",
  ];
  if (result.timedOut) lines.push("<timed_out>true</timed_out>");
  if (result.interrupted) lines.push("<interrupted>true</interrupted>");
  if (result.truncated) lines.push("<truncated>true</truncated>");
  lines.push("<output>", escapeAngles(result.output || ""), "</output>", "</user_shell_command>");
  return lines.join("\n");
}

module.exports = {
  runShellCommand: runShellCommand,
  formatTranscriptText: formatTranscriptText,
  capText: capText,
};
