// Regression tests for lr-dc9a3b — verify:installed-build validated the
// ARTIFACT on disk (build-sha.json vs. merged HEAD) and said nothing about
// the build the RUNNING PROCESS loaded. On 2026-08-25 that gate reported
// PASS twice while the running daemon served 3-day-old code and logged its
// own '[daemon] WARNING: this process is serving STALE code' 403 times —
// nothing consumed the warning. This file exercises the new process-check
// half of scripts/verify-installed-build.js: resolveProcessBuildStatus(),
// which shells out to `clagentic-console --process-build-status` (a fake
// binary here, so no real daemon socket is needed) and parses its JSON.
//
// DEMONSTRATED-FAILURE DISCIPLINE (lr-4e1242): test 1 below is written to
// simulate the exact 2026-08-25 01:48 condition — artifact matches merged
// HEAD, but the running process loaded an older SHA. Reverting
// scripts/verify-installed-build.js to its pre-lr-dc9a3b state (i.e.
// deleting resolveProcessBuildStatus and PART 2 of main()) makes this
// module have no such export at all — a TypeError, not a quietly-wrong
// pass. Confirmed by stash-testing against the pre-fix version of this file
// (see PR body).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var { execFileSync } = require("child_process");

var { resolveProcessBuildStatus } = require("../scripts/verify-installed-build");

// Builds a throwaway executable shim that stands in for
// `clagentic-console --process-build-status`, printing canned JSON to
// stdout and exiting with the given code — mirrors handleProcessBuildStatus's
// real contract (lib/cli/ipc-subcommands.js) without touching a real daemon
// socket.
function makeFakeCli(stdoutJson, exitCode) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-dc9a3b-fakecli-"));
  var binPath = path.join(dir, "fake-clagentic-console");
  var script =
    "#!/usr/bin/env node\n" +
    "process.stdout.write(" + JSON.stringify(JSON.stringify(stdoutJson)) + ");\n" +
    "process.exit(" + exitCode + ");\n";
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

// ---------------------------------------------------------------------------
// 1. THE DEMONSTRATED FAILURE: artifact matches, process is stale — this is
//    exactly the 2026-08-25 01:48 condition. Proves the new signal correctly
//    reports a mismatch that the old artifact-only check could never see.
// ---------------------------------------------------------------------------

test("lr-dc9a3b: resolveProcessBuildStatus reports a mismatch when the running process loaded an older SHA than merged HEAD (simulated 2026-08-25 01:48 condition)", function () {
  var mergedHeadSha = "266427d47043cf5ed144465f3595acf30c1e9dd2";
  var staleLoadedSha = "e406ffe0000000000000000000000000000000"; // 3-day-old code, per the incident evidence
  var fakeBin = makeFakeCli({ loadedBuildSha: staleLoadedSha, staleInodes: true, pid: 3786112 }, 0);

  var status = resolveProcessBuildStatus(fakeBin);

  assert.equal(status.running, true);
  assert.equal(status.loadedBuildSha, staleLoadedSha);
  assert.notEqual(status.loadedBuildSha, mergedHeadSha,
    "the whole point: the process's loaded SHA must be visibly distinguishable from merged HEAD");
  assert.equal(status.staleInodes, true);
});

// ---------------------------------------------------------------------------
// 2. The happy path: process loaded exactly the merged SHA, no stale inodes.
// ---------------------------------------------------------------------------

test("lr-dc9a3b: resolveProcessBuildStatus reports a clean match when the running process loaded merged HEAD", function () {
  var mergedHeadSha = "266427d47043cf5ed144465f3595acf30c1e9dd2";
  var fakeBin = makeFakeCli({ loadedBuildSha: mergedHeadSha, staleInodes: false, pid: 4242 }, 0);

  var status = resolveProcessBuildStatus(fakeBin);

  assert.equal(status.running, true);
  assert.equal(status.loadedBuildSha, mergedHeadSha);
  assert.equal(status.staleInodes, false);
  assert.equal(status.pid, 4242);
});

// ---------------------------------------------------------------------------
// 3. No daemon running is its own non-throwing state, distinct from a
//    mismatch — nothing to compare against yet is not the same claim as
//    "compared and it disagreed".
// ---------------------------------------------------------------------------

test("lr-dc9a3b: resolveProcessBuildStatus reports {running:false} (not a throw) when no daemon is running", function () {
  var fakeBin = makeFakeCli({ ok: false, error: "no running daemon" }, 1);

  var status = resolveProcessBuildStatus(fakeBin);

  assert.equal(status.running, false);
});

// ---------------------------------------------------------------------------
// 4. A genuinely broken CLI invocation (not the "no daemon" shape) still
//    throws — this must not silently swallow real failures into a false
//    "nothing to compare" result.
// ---------------------------------------------------------------------------

test("lr-dc9a3b: resolveProcessBuildStatus throws on an unexpected non-zero exit that isn't the 'no running daemon' shape", function () {
  var fakeBin = makeFakeCli({ ok: false, error: "something else entirely broke" }, 1);

  assert.throws(function () {
    resolveProcessBuildStatus(fakeBin);
  }, /--process-build-status failed/);
});

// ---------------------------------------------------------------------------
// 5. Source-level check: main()'s PROCESS_MISMATCH branch actually gates on
//    resolveProcessBuildStatus's result and process.exit(1)s on it — proves
//    the wiring, not just the helper function in isolation (same posture as
//    lr-8b476f's source-check test for the IPC case body).
// ---------------------------------------------------------------------------

test("scripts/verify-installed-build.js: main() exits non-zero on PROCESS_MISMATCH, not just ARTIFACT_MISMATCH", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-installed-build.js"), "utf8");
  assert.match(src, /resolveProcessBuildStatus/, "main() must call resolveProcessBuildStatus");
  assert.match(src, /PROCESS_MISMATCH/, "a distinct PROCESS_MISMATCH outcome must exist, separate from ARTIFACT_MISMATCH");
  assert.match(src, /processMismatch \|\| processStatus\.staleInodes/,
    "the process-mismatch branch must gate on either a SHA mismatch or the existing stale-inode detector");

  // indexOf alone would find the header comment's mention of
  // "PROCESS_MISMATCH:" first, not the actual console.error call inside
  // main() — anchor on the code occurrence specifically (the template
  // literal that's actually emitted) via lastIndexOf, since it's the last
  // of the two mentions in the file.
  var mismatchIdx = src.lastIndexOf("PROCESS_MISMATCH:");
  assert.ok(mismatchIdx !== -1);
  var nearbySlice = src.slice(mismatchIdx, mismatchIdx + 600);
  assert.match(nearbySlice, /process\.exit\(1\)/, "PROCESS_MISMATCH must exit non-zero, mirroring ARTIFACT_MISMATCH's severity");
});

// ---------------------------------------------------------------------------
// 6. Word discipline: "verified" in this script's own output must always be
//    qualified with which of artifact/process it refers to — never bare.
// ---------------------------------------------------------------------------

test("scripts/verify-installed-build.js: every 'verified' output is qualified as artifact and/or process, never bare", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-installed-build.js"), "utf8");
  // Only the OUTPUT lines matter (console.log/console.error template
  // strings) — comments mentioning "verified" in prose are not the thing
  // this rule governs (it's about what a caller/reader of the gate's actual
  // output sees), so restrict to lines that are part of a console.log/
  // console.error call or its continuation (a template-literal backtick
  // line inside one of those calls).
  var lines = src.split("\n");
  var verifiedLines = [];
  var insideConsoleCall = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/console\.(log|error)\(/.test(line)) insideConsoleCall = true;
    if (insideConsoleCall && /verified/i.test(line)) verifiedLines.push(line);
    if (insideConsoleCall && /\);\s*$/.test(line)) insideConsoleCall = false;
  }
  assert.ok(verifiedLines.length > 0, "expected at least one console.log/error line mentioning 'verified'");
  verifiedLines.forEach(function (line) {
    assert.match(line, /ARTIFACT|artifact|PROCESS|process/i,
      "line mentioning 'verified' must be qualified as artifact and/or process: " + line.trim());
  });
});

// ---------------------------------------------------------------------------
// 7. lib/daemon.js's "get_build_status" IPC case is wired up (same
//    source-check posture as lr-8b476f's get_activity_diagnostics test —
//    daemon.js cannot be required in-process, see that file's header
//    comment) and reports the SHA captured at process startup, not a live
//    re-read of build-sha.json (which would defeat the whole point: a
//    re-read after an install would just report the artifact again, not
//    what THIS process loaded).
// ---------------------------------------------------------------------------

test("lib/daemon.js: get_build_status IPC case reports loadedBuildSha captured at startup and the existing checkStaleInodes() detector", function () {
  var daemonSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");

  var caseStart = daemonSrc.indexOf('case "get_build_status"');
  assert.ok(caseStart !== -1, 'expected a "get_build_status" IPC case in lib/daemon.js');
  var caseEnd = daemonSrc.indexOf("case ", caseStart + 1);
  var caseBody = daemonSrc.slice(caseStart, caseEnd === -1 ? caseStart + 400 : caseEnd);

  assert.match(caseBody, /loadedBuildSha/, "the case must report loadedBuildSha");
  assert.match(caseBody, /checkStaleInodes\(\)/, "the case must call the existing checkStaleInodes() detector, not a new/duplicate one");

  // loadedBuildSha must be captured ONCE at module load (a variable
  // assignment near the top of the file), never re-read from disk inside
  // the IPC case itself — otherwise this command would just report the
  // artifact again, identical to what verify-installed-build.js's PART 1
  // already checks, defeating the point of PART 2.
  assert.match(daemonSrc, /var loadedBuildSha = null;/, "loadedBuildSha must be a module-level variable captured once at startup");
  assert.doesNotMatch(caseBody, /readFileSync/, "the get_build_status case must not re-read build-sha.json from disk on each call");
});

test("lib/cli/ipc-subcommands.js: handleProcessBuildStatus sends {cmd: \"get_build_status\"} and is exported/wired", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "cli", "ipc-subcommands.js"), "utf8");
  assert.match(src, /function handleProcessBuildStatus\(/, "expected handleProcessBuildStatus to be defined");
  var start = src.indexOf("function handleProcessBuildStatus");
  var end = src.indexOf("\nfunction ", start + 1);
  var body = src.slice(start, end === -1 ? src.length : end);
  assert.match(body, /cmd:\s*["']get_build_status["']/, "handleProcessBuildStatus must send the get_build_status IPC command");
  assert.match(body, /console\.log\(JSON\.stringify/, "handleProcessBuildStatus must print JSON to stdout for machine readability");
  assert.match(src, /handleProcessBuildStatus:\s*handleProcessBuildStatus/, "handleProcessBuildStatus must be exported");
});

test("bin/cli.js: --process-build-status flag is wired to handleProcessBuildStatus", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(src, /--process-build-status/, "expected a --process-build-status flag in bin/cli.js");
  assert.match(src, /handleProcessBuildStatus\(\)/, "the flag must call handleProcessBuildStatus()");
});

// ---------------------------------------------------------------------------
// 8. Post-merge config wiring: the process-build check must actually run as
//    part of the merge gate, not just exist as dead code. verify-installed-
//    build.js is already the wired post_merge_steps entry (no new step
//    needed — PART 2 runs inside the same script), so this just confirms
//    the config still points at it.
// ---------------------------------------------------------------------------

test(".clagentic/loadout/config.yaml: post_merge_steps still runs verify:installed-build with on_failure: fail", function () {
  var configSrc = fs.readFileSync(path.join(__dirname, "..", ".clagentic", "loadout", "config.yaml"), "utf8");
  assert.match(configSrc, /npm run verify:installed-build/, "post_merge_steps must run verify:installed-build");
  var idx = configSrc.indexOf("npm run verify:installed-build");
  var nearby = configSrc.slice(idx, idx + 400);
  assert.match(nearby, /on_failure:\s*fail/, "verify:installed-build must remain on_failure: fail so a PROCESS_MISMATCH fails the merge loudly, not silently");
});
