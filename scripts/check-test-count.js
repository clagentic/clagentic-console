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

var fs = require("fs");
var path = require("path");
var { spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// CI legibility (lr-e551b9, MILLER re-diagnosis of PR #400 / lr-4e1242 seq 5;
// re-diagnosed again post-merge, same task, when the shipped fix turned out
// not to survive a real CI pipe — see DELIVERY below).
//
// GitHub Actions does not surface arbitrary stderr text anywhere a crew
// agent can reach it: the raw job log requires following a redirect to a
// blob store that loadout-git-host-api correctly refuses (crew-manifest
// lr-90a3e1). A `::error::`-prefixed line, by contrast, is turned into a
// check-run ANNOTATION by the Actions runner, which IS reachable via the
// GitHub API. emitAnnotation() below exists so every FAIL path
// in this script — not just the final exit code — lands somewhere a crew
// agent can actually read it, without changing which conditions fail the
// run (see the module header above: every condition that fails today must
// keep failing).
//
// DELIVERY (lr-e551b9 reopen, MILLER third-pass diagnosis, confidence 0.93,
// reproduced locally and in CI on PR #400's rebased head): the first version
// of this function used `process.stdout.write`. When stdout is a PIPE
// (always true in CI, and in any captured run), that write is ASYNCHRONOUS —
// it queues in userspace once the 64KB kernel pipe buffer fills. The
// multi-MB TAP dump this script also writes to stdout vastly exceeds that
// buffer, so by the time emitAnnotation() ran, its own write was queued
// BEHIND the still-draining TAP blob. process.exit() then tore the process
// down without draining the queue, so the annotation reached the Writable
// stream object and never reached the file descriptor: exit code 1 with NO
// annotation, indistinguishable from a genuine test failure at the very
// point this script exists to make that distinguishable.
//
// Fixed by writing the annotation with fs.writeSync(1, ...) instead of
// process.stdout.write(...). writeSync is a direct, synchronous syscall to
// the fd — it is not subject to the Writable stream's internal async queue
// at all, so there is no buffer to race process.exit() against. This is
// belt: it holds even if something upstream changes how/when the process
// terminates. See below for suspenders (annotation ordered before the large
// stdout dump; process.exitCode instead of process.exit()).
// ---------------------------------------------------------------------------
// writeFullySync(fd, data) — fs.writeSync performs exactly ONE write(2)
// syscall attempt and returns the number of bytes actually written; it does
// NOT loop to guarantee the whole buffer lands, and a pipe fd can legitimately
// short-write under backpressure once the payload is large (BOBBIE, PR #402
// comment 5360992190). The single unlooped call this replaced discarded that
// return value entirely, so a short write silently truncated its output —
// exactly the class of silent-truncation defect this whole task (lr-e551b9)
// exists to eliminate, now against the raw TAP evidence trail instead of the
// verdict. This loops until every byte is confirmed written.
//
// `data` may be a Buffer or a string; if it is a string it is converted to a
// Buffer ONCE up front, and the loop advances over that Buffer by byte
// offset. This matters because fs.writeSync's offset/length/return-value
// semantics are BYTE-indexed always, but a JS string is indexed by UTF-16
// code unit — slicing a string by a byte count returned from a short write
// would misalign mid multi-byte UTF-8 sequence. Converting once avoids that
// mismatch entirely rather than trying to reconcile the two index spaces on
// every partial-write iteration.
//
// Any thrown error (e.g. EPIPE/EAGAIN) propagates uncaught — deliberately not
// swallowed here. This function is called from FAIL-path code whose only job
// is to make a non-zero exit legible; the exit code itself is already
// determined by classifyRun() before either write site runs (see
// process.exitCode below), so an uncaught throw here can only ever turn an
// already-nonzero process into a hard crash (still non-zero), never a FAIL
// verdict into exit 0. Swallowing the error here would risk exactly that.
function writeFullySync(fd, data) {
  var buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  var offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function emitAnnotation(message) {
  // GitHub Actions workflow-command syntax. `%`, CR and LF must be escaped
  // in the message text per GitHub's documented encoding for `::error::` —
  // https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
  var escaped = String(message)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  writeFullySync(1, "::error::" + escaped + "\n");
}

// classifyRun() is the pure decision core of this script: given the raw
// spawnSync() result plus the bucketed RESULT-line data, decide whether the
// run passes and, if not, exactly WHY. Pulled out of the top-level script
// body (which is otherwise unavoidably I/O-coupled — it shells out to a
// real `node --test`) specifically so the signal-death path (the highest-
// value item in lr-e551b9) is exercisable by a fast, deterministic unit
// test against a hand-built `result` object, without spawning a real child
// process or running the real suite.
//
// Returns { ok: bool, exitCode: number, reason: string|null, kind: string }.
// `kind` names which of this script's distinct FAIL routes produced the
// verdict (see the module header's WHAT THIS DOES AND DOES NOT CATCH /
// MECHANISM sections for the full list). Checked in this precedence order
// when multiple conditions are live at once (lr-e551b9 fold-in, PR #401):
// 'spawn-error' > 'missing-files' > 'signal-death' > 'below-floor' >
// 'test-failure' (a genuine node --test non-zero exit with no wrapper-level
// condition tripped — i.e. an ordinary named test failure, not a wrapper
// failure) > 'ok'. missing-files outranks signal-death because it names a
// specific file, the most actionable cause available; signal-death outranks
// below-floor because a signal-killed run IS the truncated run that
// produces a below-floor count in the first place — see the check itself
// for the full reasoning.
function classifyRun(result, files, resultsByFile, totalTests, floor) {
  if (result.error) {
    return {
      ok: false,
      exitCode: 1,
      kind: "spawn-error",
      reason: "failed to spawn node --test: " + result.error.message,
    };
  }

  var missingFiles = files.filter(function (f) {
    var abs = path.resolve(f);
    return !resultsByFile[abs];
  });

  if (missingFiles.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      kind: "missing-files",
      reason: (
        missingFiles.length + " test file(s) reported ZERO test results — " +
        "treated as a truncated/incomplete run, not a pass, regardless of the overall exit code. This is " +
        "exactly the failure class lr-795882 fixed (MILLER, lr-a7b03e): a file whose tests silently vanish " +
        "while the overall run still exits 0.\n  " + missingFiles.join("\n  ")
      ),
    };
  }

  if (result.status === null) {
    // The child `node --test` ORCHESTRATOR process itself (not an
    // individual per-file worker/subprocess it manages internally — Node's
    // own test runner already reports THOSE as ordinary test:fail events
    // with a `signal` field, which is why they show up as RESULT lines
    // above and never reach this branch) was killed by a signal rather than
    // exiting normally. status is null in exactly this case (Node's
    // child_process docs: exactly one of status/signal is non-null).
    // Previously this exited 1 with ZERO explanatory output — indistinguishable
    // from a genuine test failure at the exit-code level. lr-e551b9.
    //
    // Checked BEFORE below-floor (PEACHES PR #401 finding, lr-e551b9
    // fold-in): an OOM-killed/externally-signaled orchestrator IS a
    // truncated run, and a truncated run is exactly what produces a
    // below-floor total — the two conditions fire TOGETHER in the ordinary
    // case this whole check exists to make legible. Reporting below-floor
    // here would name the wrong cause precisely when the cause matters
    // most (the run still fails either way — exitCode stays 1 — but the
    // diagnostic would mislabel it). missing-files is still checked above
    // this because it names a more specific, actionable culprit (an actual
    // file) when both conditions are live.
    return {
      ok: false,
      exitCode: 1,
      kind: "signal-death",
      reason: (
        "node --test was killed by " + result.signal + " — likely OOM or an external kill (e.g. CI job " +
        "timeout/cancellation); no test failure was reported because the process did not exit normally. " +
        "This is NOT the same as a per-file worker crash (Node's test runner already reports those as a " +
        "named test:fail with a signal field); this is the top-level orchestrator process itself dying."
      ),
    };
  }

  if (totalTests < floor) {
    return {
      ok: false,
      exitCode: 1,
      kind: "below-floor",
      reason: (
        "total executed test count " + totalTests +
        " is below the floor of " + floor + " even though every file reported at least one result — " +
        "likely a large in-file test drop. See this script's header for what the floor does and does not " +
        "catch, and how to update it for a deliberate suite reduction."
      ),
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      exitCode: result.status,
      kind: "test-failure",
      reason: (
        "node --test exited " + result.status + " with a named test failure above (see the TAP `not ok` " +
        "line(s)) — this is an ordinary test failure, not a wrapper-level condition."
      ),
    };
  }

  return { ok: true, exitCode: 0, kind: "ok", reason: null };
}

module.exports = {
  classifyRun: classifyRun,
  emitAnnotation: emitAnnotation,
  writeFullySync: writeFullySync,
};

// Everything below only runs when this file is executed directly (`node
// scripts/check-test-count.js <file...>`), not when required as a module by
// a unit test.
if (require.main === module) {
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

  var totalTests = passCount + failCount;
  var verdict = classifyRun(result, files, resultsByFile, totalTests, TEST_COUNT_FLOOR);

  // DELIVERY ORDER (lr-e551b9 reopen). The annotation is emitted BEFORE the
  // large TAP dump below, not after: emitAnnotation() now uses
  // fs.writeSync(1, ...), a direct synchronous syscall that bypasses the
  // stdout Writable's async queue entirely, so this ordering is not load-
  // bearing for the annotation's own delivery — but it also means the
  // annotation is never at risk of landing "behind" a dump that is itself
  // subject to the async-pipe race (see below), belt-and-suspenders rather
  // than relying on ordering alone.
  if (!verdict.ok) {
    var line = "[check-test-count] FAIL (" + verdict.kind + "): " + verdict.reason;
    process.stderr.write(line + "\n");
    // Surfaced as a check-run annotation too (see emitAnnotation's own
    // comment) — this is what makes the reason reachable without the raw
    // job log, for every FAIL route including the previously-silent
    // signal-death path.
    emitAnnotation(line);
  }

  // The raw TAP dump is written with writeFullySync too, for the same reason
  // as the annotation above: process.stdout.write() queues asynchronously
  // once a pipe's 64KB kernel buffer fills, and a ~1400-test TAP blob is
  // multi-MB — far larger than that buffer. Losing the raw output is a
  // real, independent problem even though the annotation above no longer
  // depends on it: a developer reading a captured `npm test` run should
  // still see the actual TAP text, not a truncation artifact. A single
  // unlooped fs.writeSync call here would carry the same short-write risk
  // as the annotation write did (BOBBIE, PR #402) — writeFullySync loops
  // until the whole multi-MB buffer is confirmed delivered.
  if (result.stdout) writeFullySync(1, result.stdout);

  // process.exitCode (not process.exit()) lets the event loop drain
  // naturally instead of tearing the process down immediately — the second
  // half of MILLER's recommended (a)+(b) combination. Nothing below this
  // line can reset process.exitCode or call process.exit(0): this is the
  // last statement in the script, so there is no later code path that could
  // turn a red run green. The FAIL-OPEN CONSTRAINT (lr-795882, engram
  // 7613980) requires this be verified, not assumed — every exit-1
  // condition above still sets verdict.exitCode to 1 or the child's own
  // non-zero status; process.exitCode is set from that value unconditionally
  // and nothing else touches it.
  process.exitCode = verdict.exitCode;
}
