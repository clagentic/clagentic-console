#!/usr/bin/env node
"use strict";
//
// check-test-count.js — per-file completion + count floor for `npm test`
// (lr-795882, hardened after PEACHES/BOBBIE PR #395 review).
//
// PROBLEM: `node --test` can exit 0 with a self-consistent-looking summary
// even when a truncated run silently dropped an entire test file's worth of
// tests (proved by MILLER during lr-a7b03e: 1406/1385/1406/1406 across four
// runs on unmodified main, all exit 0, 1385 missing 21 real security tests
// from test/xss-escape.test.js). A green `npm test` did not prove the full
// suite ran. Fixing the underlying leaked handles (lr-795882) closed the
// mechanism that caused THAT truncation, but nothing short of verifying
// every file actually ran can catch the NEXT regression of this class — a
// future leaked handle in a NEW test file would reproduce the exact same
// silent-drop failure mode this script exists to catch.
//
// WHAT THIS DOES AND DOES NOT CATCH — state this plainly, not left for a
// reader to work out (PR #395 review, andy):
//   - CATCHES: any single test FILE that reports zero test:pass/test:fail
//     events at all — the literal MILLER failure mode (one file's tests
//     silently vanish while `node --test` still exits 0). This is a hard
//     per-file boundary, not a probabilistic total: every file named on
//     the command line is checked individually against the reporter's own
//     event stream; there is no "close enough" combined count to hide
//     behind, and — unlike an earlier version of this script — this
//     mechanism does NOT need to isolate each file into its own process
//     to get that per-file signal (see MECHANISM below), so it carries no
//     risk of changing test timing/ordering behavior.
//   - DOES NOT CATCH: a handful of tests silently dropped from WITHIN an
//     otherwise-reporting file (e.g. 3 of a file's 40 tests vanish but the
//     file still reports other passes and exits 0). Catching that would
//     require a checked-in expected test-name list per file, which is far
//     more maintenance than this bug class justifies. TEST_COUNT_FLOOR
//     below is a coarser secondary net for a LARGE in-file drop, not a
//     precise one.
//
// MECHANISM (v2 — replaces the v1 "single combined run + parse the shared
// TAP summary's total" design, which BOBBIE/PEACHES correctly flagged as
// too loose: a floor of 1300 against a live count of ~1407 has 107 tests
// of slack, comfortably hiding MILLER's own 21-test drop; and a v1.5
// per-file-isolated-process design, which was correct in principle but
// exposed an unrelated pre-existing test-order flake
// (project-connection-hydrate-session-model-lr-041af8.test.js's
// millisecond tie-break) purely as a side effect of changing how files are
// scheduled — rejected because the count-verification mechanism itself
// should never be the thing introducing new failure risk):
//
//   Run ALL files in ONE node --test invocation, exactly as `npm test`
//   always has (no per-file process isolation, no timing/ordering change),
//   but attach a CUSTOM REPORTER (test-file-completion-reporter.js)
//   alongside the normal `tap` reporter. Node's reporter API delivers a
//   `file` field on every test:pass/test:fail event REGARDLESS of what
//   TAP's own text output shows (TAP text has no per-file marker when
//   multiple files share one process — that's what made v1 unable to do
//   this without isolating files). The custom reporter emits one
//   machine-readable "RESULT <pass|fail> <file>" line per test result to a
//   separate destination stream; this script reads that stream, buckets
//   results by file, and requires every file passed on argv to have at
//   least one RESULT line.
//
var TEST_COUNT_FLOOR = 1300;

var path = require("path");
var { spawnSync } = require("child_process");

var files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("[check-test-count] no test files given (expected: node scripts/check-test-count.js <file...>)\n");
  process.exit(1);
}

var REPORTER_PATH = path.join(__dirname, "test-file-completion-reporter.js");

var result = spawnSync(process.execPath, [
  "--test",
  "--test-reporter=tap", "--test-reporter-destination=stdout",
  "--test-reporter=" + REPORTER_PATH, "--test-reporter-destination=stderr",
].concat(files), {
  stdio: ["inherit", "pipe", "pipe"],
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);

if (result.error) {
  process.stderr.write("[check-test-count] failed to spawn node --test: " + result.error.message + "\n");
  process.exit(1);
}

// The custom reporter's RESULT lines are the only thing routed to stderr —
// forward everything else Node itself wrote to stderr (real errors,
// warnings) so a normal `npm test` run still surfaces them, then parse the
// RESULT lines separately below.
var stderrLines = (result.stderr || "").split("\n");
var resultsByFile = Object.create(null);
var passCount = 0;
var failCount = 0;

stderrLines.forEach(function (line) {
  var match = /^RESULT (pass|fail) (.+)$/.exec(line);
  if (!match) {
    if (line) process.stderr.write(line + "\n");
    return;
  }
  var kind = match[1];
  var file = match[2];
  if (!resultsByFile[file]) resultsByFile[file] = 0;
  resultsByFile[file] += 1;
  if (kind === "pass") passCount += 1;
  else failCount += 1;
});

var missingFiles = files.filter(function (f) {
  var abs = path.resolve(f);
  return !resultsByFile[abs];
});

if (missingFiles.length > 0) {
  process.stderr.write(
    "[check-test-count] FAIL: " + missingFiles.length + " test file(s) reported ZERO test results — " +
    "treated as a truncated/incomplete run, not a pass, regardless of the overall exit code. This is " +
    "exactly the failure class lr-795882 fixed (MILLER, lr-a7b03e): a file whose tests silently vanish " +
    "while the overall run still exits 0.\n  " + missingFiles.join("\n  ") + "\n"
  );
  process.exit(1);
}

var totalTests = passCount + failCount;
if (totalTests < TEST_COUNT_FLOOR) {
  process.stderr.write(
    "[check-test-count] FAIL: total executed test count " + totalTests +
    " is below the floor of " + TEST_COUNT_FLOOR + " even though every file reported at least one result — " +
    "likely a large in-file test drop. See this script's header for what the floor does and does not " +
    "catch, and how to update it for a deliberate suite reduction.\n"
  );
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
