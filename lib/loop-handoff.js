/**
 * Ralph Loop boundary compaction / handoff-to-disk (lr-ed10).
 *
 * At the completion of each loop iteration (the BOUNDARY between iterations),
 * this module optionally writes a structured handoff file to disk and returns
 * a brief summary that the next iteration prepends to its prompt.
 *
 * Design:
 *   - Opt-in only. No effect unless loopSettings.compactHandoff === true.
 *   - Handoff directory: CONFIG_DIR/handoffs/<loopId>/ — derived from the same
 *     config-dir root the rest of Console uses (lr-6204 path contract).
 *   - Each handoff file is named handoff-<N>.json (N = iteration number).
 *   - The structured frame contains: task, decisions, open_threads, key_files,
 *     verdict, iteration, timestamp.  All fields are populated from the session
 *     history at the iteration boundary; fallback to empty when unavailable.
 *   - The summary injected into the next iteration is intentionally brief:
 *     a few lines of plain text covering just the fields above.  It is
 *     prepended to the original PROMPT.md text by the caller.
 *   - Clean degradation: if the write fails the loop continues unchanged;
 *     if the read fails (no prior handoff exists) the loop continues unchanged.
 *
 * No new dependencies: uses only Node built-ins (fs, path, crypto).
 */

"use strict";

var fs = require("fs");
var path = require("path");
var { CONFIG_DIR } = require("./config");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the handoff directory path for a given loopId.
 * Always derived from CONFIG_DIR — never an absolute caller-supplied path.
 * Returns null if loopId is missing or fails the safety regex.
 *
 * @param {string} loopId
 * @returns {string|null}
 */
function handoffDir(loopId) {
  // Mirror the loop ID allowlist from scheduler.js / project-loop.js.
  if (!loopId || !/^loop_[A-Za-z0-9_-]+$/.test(loopId)) return null;
  return path.join(CONFIG_DIR, "handoffs", loopId);
}

/**
 * Return the path for iteration N's handoff file.
 * @param {string} loopId
 * @param {number} iteration
 * @returns {string|null}
 */
function handoffFilePath(loopId, iteration) {
  var dir = handoffDir(loopId);
  if (!dir) return null;
  return path.join(dir, "handoff-" + iteration + ".json");
}

/**
 * Extract a brief human-readable summary from a completed session's history.
 * Looks at the last assistant text blocks for decision/thread content.
 * Returns a string up to ~1 000 chars — enough for a continuation frame
 * without re-inflating the context.
 *
 * @param {Array} history  session.history array
 * @returns {string}
 */
function extractSessionSummary(history) {
  if (!Array.isArray(history) || history.length === 0) return "";

  // Collect assistant text in reverse order until we have ~800 chars.
  var chunks = [];
  var total = 0;
  for (var i = history.length - 1; i >= 0 && total < 800; i--) {
    var entry = history[i];
    var text = "";
    if (entry.type === "delta" && entry.text) text = entry.text;
    else if (entry.type === "text" && entry.text) text = entry.text;
    if (text) {
      chunks.unshift(text);
      total += text.length;
    }
  }
  return chunks.join("").slice(-800).trim();
}

/**
 * Scan assistant text for lines that look like decisions or open items.
 * Very lightweight heuristic — just extracts bullet-style lines.
 *
 * @param {string} text
 * @returns {{ decisions: string[], open_threads: string[] }}
 */
function parseDecisionsAndThreads(text) {
  var decisions = [];
  var threads = [];
  if (!text) return { decisions: decisions, open_threads: threads };

  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // Bullet / numbered list items
    var isBullet = /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line);
    if (!isBullet || line.length < 5) continue;

    var lower = line.toLowerCase();
    // Decision-like: keywords that suggest a resolved choice
    if (/\b(decided|chose|using|implemented|added|fixed|completed|done)\b/.test(lower)) {
      decisions.push(line.substring(0, 120));
    }
    // Thread-like: keywords that suggest something still open
    if (/\b(todo|open|still|pending|not yet|need to|should|must|missing|blocked)\b/.test(lower)) {
      threads.push(line.substring(0, 120));
    }
  }
  // Keep only the most recent N items to bound size
  return {
    decisions: decisions.slice(-5),
    open_threads: threads.slice(-5),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a structured handoff file at the end of iteration N.
 * Called at the iteration boundary — after the coder session completes
 * and before the next iteration starts.
 *
 * Silently no-ops when:
 *   - compactHandoff is not enabled (settings.compactHandoff !== true)
 *   - loopId is missing or invalid
 *   - any write error occurs (loop must continue regardless)
 *
 * @param {object} opts
 * @param {object}   opts.loopState    current loopState object
 * @param {object}   opts.session      completed coder session (with .history)
 * @param {string}   [opts.verdict]    judge verdict if available ("pass"|"fail"|null)
 * @returns {boolean} true if a handoff file was written, false otherwise
 */
function writeHandoff(opts) {
  var loopState = opts.loopState;
  var session = opts.session;
  var verdict = opts.verdict || null;

  // Guard: opt-in only
  var settings = loopState.settings || {};
  if (!settings.compactHandoff) return false;

  var loopId = loopState.loopId;
  var dir = handoffDir(loopId);
  if (!dir) return false;

  var filePath = handoffFilePath(loopId, loopState.iteration);
  if (!filePath) return false;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn("[loop-handoff] Failed to create handoff dir:", e.message);
    return false;
  }

  var rawSummary = extractSessionSummary(session.history || []);
  var parsed = parseDecisionsAndThreads(rawSummary);

  var frame = {
    schema_version: 1,
    loop_id: loopId,
    iteration: loopState.iteration,
    task: (loopState.promptText || "").substring(0, 500),
    decisions: parsed.decisions,
    open_threads: parsed.open_threads,
    key_files: [], // reserved for future tool-output parsing
    verdict: verdict,
    written_at: new Date().toISOString(),
  };

  var tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(frame, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    console.log("[loop-handoff] Wrote handoff for " + loopId + " iteration " + loopState.iteration);
    return true;
  } catch (e) {
    console.warn("[loop-handoff] Failed to write handoff file:", e.message);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
}

/**
 * Read the most recent handoff file for a loop and return a brief
 * structured summary string to prepend to the next iteration's prompt.
 *
 * Returns null when:
 *   - compactHandoff is not enabled
 *   - no prior handoff file exists (first iteration)
 *   - any read/parse error
 *
 * @param {object} opts
 * @param {object}   opts.loopState    current loopState (iteration already incremented)
 * @returns {string|null}
 */
function buildHandoffPreamble(opts) {
  var loopState = opts.loopState;

  // Guard: opt-in only
  var settings = loopState.settings || {};
  if (!settings.compactHandoff) return null;

  var loopId = loopState.loopId;
  // The handoff was written for the PREVIOUS iteration
  var prevIteration = loopState.iteration - 1;
  if (prevIteration < 1) return null;

  var filePath = handoffFilePath(loopId, prevIteration);
  if (!filePath) return null;

  var frame;
  try {
    var raw = fs.readFileSync(filePath, "utf8");
    frame = JSON.parse(raw);
  } catch (e) {
    // No prior handoff — first iteration or file missing (clean degradation)
    return null;
  }

  // Build a brief continuation frame — intentionally short
  var lines = [
    "## Continuation from iteration " + frame.iteration + " (structured handoff)",
    "",
  ];

  if (frame.decisions && frame.decisions.length > 0) {
    lines.push("**Decisions made in the previous iteration:**");
    for (var i = 0; i < frame.decisions.length; i++) {
      lines.push("  - " + frame.decisions[i]);
    }
    lines.push("");
  }

  if (frame.open_threads && frame.open_threads.length > 0) {
    lines.push("**Open items from the previous iteration:**");
    for (var j = 0; j < frame.open_threads.length; j++) {
      lines.push("  - " + frame.open_threads[j]);
    }
    lines.push("");
  }

  if (frame.verdict) {
    lines.push("**Previous judge verdict:** " + frame.verdict);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

/**
 * Return the handoff directory path for a given loopId.
 * Exported for tests; not part of the runtime hot path.
 */
function getHandoffDir(loopId) {
  return handoffDir(loopId);
}

module.exports = {
  writeHandoff: writeHandoff,
  buildHandoffPreamble: buildHandoffPreamble,
  getHandoffDir: getHandoffDir,
  // Exported for unit tests only
  _handoffFilePath: handoffFilePath,
  _extractSessionSummary: extractSessionSummary,
  _parseDecisionsAndThreads: parseDecisionsAndThreads,
};
