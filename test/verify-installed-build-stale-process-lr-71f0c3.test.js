// Regression tests for lr-71f0c3 — a daemon that predates the
// get_build_status IPC case (i.e. predates lr-dc9a3b itself) cannot answer
// scripts/verify-installed-build.js's process-status query at all. It
// replies {ok:false, error:"unknown command: get_build_status"}, which
// lib/cli/ipc-subcommands.js's handleProcessBuildStatus surfaces on stderr
// as "Failed: unknown command: get_build_status" with a non-zero exit.
//
// Surfaced three times (PR #411, #412, #414 — see lr-71f0c3's description
// and comment #1): the raw transport string reads as a MISSING-CODE defect
// ("the subcommand needs wiring") when the handler IS present
// (lib/daemon.js's "get_build_status" case, lib/daemon.js:~1640) — the
// process just started before the handler existed. Twice this misled a
// crew agent pre-dispatch; the third time it aborted a sound P1 merge's
// post_merge_steps chain outright (on_failure: fail on a script that never
// distinguished this from a genuine tooling failure).
//
// These tests pin the four discriminated process-leg outcomes so they
// cannot collapse into each other again:
//   1. STALE_PROCESS is detected as its own state, not conflated with the
//      generic-failure throw path or the "no running daemon" path.
//   2. main() treats STALE_PROCESS as non-fatal (exit 0 / return, not
//      process.exit(1)) — see the script's header comment for why this is
//      a deliberate, justified choice, not an oversight.
//   3. STALE_PROCESS never surfaces the raw "unknown command" string in
//      main()'s own output.
//   4. The STALE_PROCESS message states plainly that the process build
//      status is UNKNOWN (never reads as "verified"), matching lr-dc9a3b
//      requirement 3's artifact/process discipline exactly.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var { execFileSync } = require("child_process");

var { resolveProcessBuildStatus } = require("../scripts/verify-installed-build");

// Builds a throwaway executable shim that stands in for a PRE-lr-dc9a3b
// `clagentic-console --process-build-status` — i.e. a running daemon that
// has no get_build_status IPC case, mirroring lib/daemon.js's default
// branch replying {ok:false, error:"unknown command: get_build_status"}
// and handleProcessBuildStatus surfacing that on stderr with exit 1.
function makeStaleCli() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-71f0c3-stalecli-"));
  var binPath = path.join(dir, "fake-clagentic-console-stale");
  var script =
    "#!/usr/bin/env node\n" +
    "process.stderr.write('Failed: unknown command: get_build_status\\n');\n" +
    "process.exit(1);\n";
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

// A genuine, unrelated CLI failure (not the "no running daemon" shape, not
// the "unknown command: get_build_status" shape) must still throw — this
// new detection must not swallow real failures the way "no running daemon"
// deliberately doesn't, but also must not over-match unrelated errors.
function makeGenericBrokenCli() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-71f0c3-brokencli-"));
  var binPath = path.join(dir, "fake-clagentic-console-broken");
  var script =
    "#!/usr/bin/env node\n" +
    "process.stderr.write('Failed: something else entirely broke\\n');\n" +
    "process.exit(1);\n";
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

// ---------------------------------------------------------------------------
// 1. resolveProcessBuildStatus reports a distinct {running:true, stale:true}
//    state for a daemon that predates the handler — not a throw, not
//    conflated with {running:false}.
// ---------------------------------------------------------------------------

test("lr-71f0c3: resolveProcessBuildStatus reports {running:true, stale:true} when the daemon replies 'unknown command: get_build_status'", function () {
  var fakeBin = makeStaleCli();

  var status = resolveProcessBuildStatus(fakeBin);

  assert.equal(status.running, true, "the daemon IS running -- it just predates the handler");
  assert.equal(status.stale, true);
  assert.equal(typeof status.loadedBuildSha, "undefined",
    "a stale-process result must not carry a loadedBuildSha -- the daemon could not report one");
});

// ---------------------------------------------------------------------------
// 2. A genuinely unrelated failure must still throw -- the new detection is
//    narrow (matches only the specific "unknown command: get_build_status"
//    shape), not a catch-all that swallows every non-zero exit.
// ---------------------------------------------------------------------------

test("lr-71f0c3: resolveProcessBuildStatus still throws on an unrelated failure, not just any non-zero exit", function () {
  var fakeBin = makeGenericBrokenCli();

  assert.throws(function () {
    resolveProcessBuildStatus(fakeBin);
  }, /--process-build-status failed/);
});

// ---------------------------------------------------------------------------
// 3. Source-level check: main()'s STALE_PROCESS branch does not call
//    process.exit(1) -- pins the deliberate non-fatal decision (see the
//    script's header comment for the reasoning) so a future edit cannot
//    silently flip this back to fatal without touching this test.
// ---------------------------------------------------------------------------

test("scripts/verify-installed-build.js: main()'s STALE_PROCESS branch is non-fatal (no process.exit(1))", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-installed-build.js"), "utf8");

  assert.match(src, /processStatus\.stale/, "main() must check processStatus.stale");
  assert.match(src, /STALE_PROCESS:/, "a distinct STALE_PROCESS outcome must be reported");

  var staleIdx = src.indexOf("if (processStatus.stale)");
  assert.ok(staleIdx !== -1, "expected an `if (processStatus.stale)` branch in main()");
  // The branch runs until the next top-level statement in main() -- the
  // processMismatch check immediately follows it in source order.
  var nextIdx = src.indexOf("const processMismatch", staleIdx);
  var branchBody = src.slice(staleIdx, nextIdx === -1 ? staleIdx + 900 : nextIdx);

  assert.doesNotMatch(branchBody, /process\.exit\(1\)/,
    "STALE_PROCESS must not exit non-zero -- it is a deliberate non-fatal outcome, not a failure");
  assert.match(branchBody, /return;/, "STALE_PROCESS must return (implicit exit 0), mirroring ARTIFACT_VERIFIED_NO_PROCESS");
});

// ---------------------------------------------------------------------------
// 4. The STALE_PROCESS message must never leak the raw transport string,
//    and must say plainly that the process build status is UNKNOWN --
//    never reads as "verified" (lr-dc9a3b requirement 3, restated for this
//    fourth outcome by lr-71f0c3).
// ---------------------------------------------------------------------------

test("scripts/verify-installed-build.js: STALE_PROCESS message never surfaces the raw 'unknown command' string and states the status is UNKNOWN", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-installed-build.js"), "utf8");

  var staleIdx = src.indexOf("if (processStatus.stale)");
  assert.ok(staleIdx !== -1);
  var nextIdx = src.indexOf("const processMismatch", staleIdx);
  var branchBody = src.slice(staleIdx, nextIdx === -1 ? staleIdx + 900 : nextIdx);

  // The console.log call itself (not this file's own header-comment prose,
  // which legitimately discusses the raw string for documentation purposes)
  // must not emit "unknown command" verbatim to the operator.
  var logIdx = branchBody.indexOf("console.log(");
  assert.ok(logIdx !== -1, "expected a console.log call in the STALE_PROCESS branch");
  // branchBody.indexOf(");", logIdx) would match the FIRST "..." occurrence,
  // including one inside a template literal like `(${headSha});` -- that is
  // not the call's actual closing paren. The call's own `return;` statement
  // immediately follows its closing `);` in source order, so anchor on that
  // instead of the first (wrong) `);` substring match.
  var returnIdx = branchBody.indexOf("return;", logIdx);
  assert.ok(returnIdx !== -1, "expected a `return;` statement after the console.log call");
  var logCall = branchBody.slice(logIdx, returnIdx);

  assert.doesNotMatch(logCall, /unknown command/i,
    "the operator-facing STALE_PROCESS message must not leak the raw 'unknown command' transport string");
  assert.match(logCall, /UNKNOWN/, "the message must state the process build status is UNKNOWN");
  assert.match(logCall, /restart/i, "the message must state the remedy is a daemon restart");
});

// ---------------------------------------------------------------------------
// 5. Detection lives in resolveProcessBuildStatus (the transport layer),
//    not duplicated ad hoc in main() -- keeps the "what shape does the
//    daemon's reply take" knowledge in one place.
// ---------------------------------------------------------------------------

test("scripts/verify-installed-build.js: resolveProcessBuildStatus is the single place that detects the 'unknown command: get_build_status' shape", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-installed-build.js"), "utf8");

  // resolveProcessBuildStatus contains two `.test(...)` calls against the
  // same regex literal (stderr and err.message) plus the header-comment
  // prose mentioning the literal string -- assert the regex-based detection
  // itself is confined to resolveProcessBuildStatus's body, not repeated
  // inside main().
  var fnStart = src.indexOf("function resolveProcessBuildStatus");
  var fnEnd = src.indexOf("\nfunction main", fnStart);
  var mainBody = src.slice(src.indexOf("function main("));

  assert.match(src.slice(fnStart, fnEnd), /unknown command/,
    "resolveProcessBuildStatus must contain the detection");
  assert.doesNotMatch(mainBody, /\/unknown command/,
    "main() must not duplicate the regex-based detection -- it should only branch on processStatus.stale");
});
