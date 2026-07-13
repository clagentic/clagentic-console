"use strict";
/**
 * Grep-guard for lr-2ea2a7: exactly one call site in the entire lib/ tree may
 * call `session.history.push(` directly — the canonical implementation
 * inside recordHistoryEntry() in lib/sessions.js. Every other consumer
 * (project-user-message.js, project-loop.js, project-sessions.js,
 * project-external-trigger.js, project-user-mention.js, project.js, ...)
 * must route through sm.recordHistoryEntry() so the bounded in-heap tail cap
 * (HISTORY_INMEM_MAX / HISTORY_INMEM_TRIM_TO) applies uniformly, including to
 * long-running isProcessing sessions that are exempt from LRU eviction.
 *
 * This is a structural guard, not a behavioral one — it exists so a future
 * PR that adds a new "push a synthetic user_message into history" call site
 * (a common pattern in this codebase, see the ~9 sites this fix touched)
 * cannot silently reintroduce the unbounded-growth defect by bypassing the
 * cap helper.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var LIB_DIR = path.join(__dirname, "..", "lib");
var PUSH_PATTERN = /\.history\.push\(/g;

function walkJsFiles(dir) {
  var out = [];
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(walkJsFiles(full));
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

test("lr-2ea2a7: no .history.push( call sites outside lib/sessions.js's recordHistoryEntry()", function () {
  var files = walkJsFiles(LIB_DIR);
  var offenders = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var isSessionsJs = path.resolve(file) === path.resolve(LIB_DIR, "sessions.js");
    var content = fs.readFileSync(file, "utf8");
    var lines = content.split("\n");
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Skip comment lines referencing the pattern in prose (e.g. this file's
      // own docstring, or explanatory comments in the fixed call sites) --
      // only flag lines where the match is not inside a // comment.
      var codePart = line.split("//")[0];
      if (PUSH_PATTERN.test(codePart)) {
        if (!isSessionsJs) {
          offenders.push(file.replace(LIB_DIR, "lib") + ":" + (li + 1) + ": " + line.trim());
        }
      }
      PUSH_PATTERN.lastIndex = 0;
    }
  }

  assert.deepEqual(offenders, [],
    "found .history.push( outside lib/sessions.js -- route through sm.recordHistoryEntry() instead:\n" + offenders.join("\n"));
});

test("lr-2ea2a7: lib/sessions.js itself contains exactly one real (non-comment) .history.push( call", function () {
  var content = fs.readFileSync(path.join(LIB_DIR, "sessions.js"), "utf8");
  var lines = content.split("\n");
  var realCallCount = 0;
  for (var li = 0; li < lines.length; li++) {
    var codePart = lines[li].split("//")[0];
    if (PUSH_PATTERN.test(codePart)) realCallCount++;
    PUSH_PATTERN.lastIndex = 0;
  }
  assert.equal(realCallCount, 1,
    "expected exactly one real session.history.push( call site inside lib/sessions.js (recordHistoryEntry), found " + realCallCount);
});
