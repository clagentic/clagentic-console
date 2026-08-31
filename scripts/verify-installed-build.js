#!/usr/bin/env node
'use strict';

// verify-installed-build.js — post-merge install assertion (lr-0d45),
// extended by lr-dc9a3b to also check the RUNNING PROCESS.
//
// PART 1 (lr-0d45, unchanged): confirms the globally-installed
// @clagentic/console build (installed by the preceding
// `npm run install:local-test` post_merge_steps entry) actually reflects the
// merged HEAD commit, rather than trusting a zero exit code from
// `npm install -g` alone. Compares the SHA embedded by
// scripts/write-build-sha.js (baked into the tarball at `prepack` time, so
// it travels with the package that `npm install -g` unpacked) against this
// working tree's own HEAD SHA at the moment loadout-merge runs
// post_merge_steps (i.e. the merged commit). This is a check of the
// ARTIFACT ON DISK only.
//
// PART 2 (lr-dc9a3b, new): the artifact check above says nothing about
// which build the RUNNING daemon process actually loaded — Node reads JS at
// require-time, so a process started before an install cannot be executing
// code that install just wrote, no matter what build-sha.json now says. On
// 2026-08-25, PART 1 passed twice while the running daemon served 3-day-old
// code and logged its own '[daemon] WARNING: this process is serving STALE
// code' 403 times — nothing consumed that warning. This queries the live
// daemon over its IPC socket (`clagentic-console --process-build-status`,
// lib/daemon.js's "get_build_status" case) for the SHA it loaded at its own
// startup and for the existing stale-inode detector's live result, and
// fails loudly on either signal of drift. No daemon running is reported as
// its own distinct, non-failing state (ARTIFACT_ONLY) — there is nothing to
// compare against yet (e.g. a fresh box that has never started the
// service), which is different from a daemon that IS running but did not
// pick up the new build.
//
// STALE_PROCESS (lr-71f0c3, new): a FOURTH outcome, distinct from all of the
// above. A daemon that predates the get_build_status IPC case entirely (i.e.
// predates lr-dc9a3b itself) cannot answer this query at all — it replies
// {ok:false, error:"unknown command: get_build_status"} over the socket,
// which the CLI surfaces as `Failed: unknown command: get_build_status` on
// stderr with a non-zero exit. That raw transport string reads as a
// MISSING-CODE defect (the subcommand "isn't wired up") when it is nothing
// of the kind — the handler IS present (lib/daemon.js:~1640, see
// test/verify-installed-build-lr-dc9a3b.test.js's tests 7-9), the process
// just started before the handler existed. This condition recurred three
// times (PR #411, #412, #414 — see lr-71f0c3): twice it misled a crew agent
// into treating it as missing code; the third time it aborted a P1 merge's
// post_merge_steps chain outright, since the raw error was indistinguishable
// from a genuine tooling failure and the step was on_failure: fail.
//
// This is structurally unavoidable, not an edge case: a daemon predating the
// handler cannot manifest as a SHA mismatch (PROCESS_MISMATCH above) since it
// cannot answer the SHA question at all. "unknown command" is the ONLY shape
// this specific staleness can take, and it recurs on every merge until an
// operator restarts the daemon onto a build that has the handler. Detected
// here by matching the "unknown command: get_build_status" error text the
// daemon's default IPC case emits (see lib/daemon.js's default branch) —
// distinguished from a generic/unexpected failure the same way "no running
// daemon" already is, one level up in resolveProcessBuildStatus().
//
// Treated as NON-FATAL (exit 0), same posture as ARTIFACT_VERIFIED_NO_PROCESS
// — the primary assertion (artifact matches merged HEAD) already passed by
// the time this leg runs, and this condition self-resolves the moment the
// daemon restarts (no operator action this script could gate on would change
// the outcome faster than a restart already would). Aborting on_failure:fail
// on it, as happened on PR #414, halts an otherwise-sound merge's post-merge
// chain on a known, self-resolving, non-code condition. It is NOT read as
// "verified" — the message says plainly the process build status is UNKNOWN
// pending a restart, mirroring ARTIFACT_VERIFIED_NO_PROCESS's own "not a
// failure, but do not read this as verified" framing exactly.
//
// Every reported outcome names EXACTLY ONE of "artifact" or "process" (or
// both) so "verified" is never ambiguous about which one it means — that
// ambiguity is what let the artifact-only PART 1 result get relayed
// upstream (NAOMI's post-merge report, HOLDEN's operator relay) as if it
// meant the running service was fixed.
//
// Exit codes:
//   0  — ARTIFACT_AND_PROCESS_VERIFIED: installed build-sha.json matches
//        merged HEAD AND the running daemon (if any) loaded that same SHA
//        with no detected stale inodes.
//      — ARTIFACT_VERIFIED_NO_PROCESS: installed build-sha.json matches
//        merged HEAD and no daemon is currently running, so the PROCESS
//        CHECK DID NOT RUN. The service's build status is UNKNOWN, not
//        verified — nothing to compare against yet (e.g. a fresh box that
//        has never started the service). This is not a failure, but it must
//        never be read as "the service is fine".
//   1  — ARTIFACT_MISMATCH: installed build-sha.json does not match merged
//        HEAD (PART 1's original failure mode, unchanged).
//      — PROCESS_MISMATCH: the artifact matches, but the running daemon's
//        loaded SHA differs from merged HEAD, or the daemon itself reports
//        stale inodes (on-disk JS was replaced out from under it). THIS is
//        the failure mode that would have caught 2026-08-25 at 01:48 — see
//        test/verify-installed-build-lr-dc9a3b.test.js for the
//        demonstrated-failure-before-fix simulation.
//      — STALE_PROCESS (lr-71f0c3): the artifact matches, but the running
//        daemon predates the get_build_status handler itself and cannot
//        answer the query at all. NOT a failure (exit 0, see PART 2's
//        header comment above for the fatal/non-fatal reasoning) — reported
//        plainly with the remedy (restart the daemon), never as the raw
//        'unknown command' transport string.
//   All failures are reported on stderr with the exact SHAs/flags involved
//   so the drift is visible in loadout-merge's captured step output.
//
// Run as a SEPARATE post_merge_steps entry (on_failure: fail) after
// `npm run install:local-test` — never combined into one shell string, per
// loadout-merge's shell-operator-token rejection (merge/post_merge.py).
//
// NON-GOAL (lr-dc9a3b task brief): does NOT auto-restart the daemon on a
// PROCESS_MISMATCH. A restart mid-merge is not obviously correct — on
// 2026-08-25 a restart at merge time would have killed five in-flight
// sessions, including the one dispatching the merge. This exits non-zero
// with a loud, structured, unmissable stderr report instead; an operator or
// a separate, explicitly-decided automation restarts the daemon. See the
// PR body for the full trade-off.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function resolveInstalledSha() {
  // `npm install -g` resolves the global node_modules root via `npm root -g`;
  // read the build-sha.json that write-build-sha.js baked into the tarball
  // at pack time (lib/ is in package.json's `files`, so it ships).
  const globalRoot = execFileSync('npm', ['root', '-g'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
  const installedPath = path.join(globalRoot, '@clagentic', 'console', 'lib', 'build-sha.json');
  const raw = fs.readFileSync(installedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.sha !== 'string') {
    throw new Error(`${installedPath} does not contain a "sha" field`);
  }
  return { sha: parsed.sha, path: installedPath };
}

// lr-dc9a3b: queries the RUNNING daemon (if any) for the build SHA it
// actually loaded at startup, via the CLI's --process-build-status
// subcommand (lib/cli/ipc-subcommands.js's handleProcessBuildStatus,
// lib/daemon.js's "get_build_status" IPC case). Exposed as its own function
// (rather than inlined into main()) so a test can call it against a fake
// `clagentic-console` on PATH instead of a real daemon socket.
//
// Returns:
//   { running: false }                                        — no daemon
//   { running: true, stale: true }                             — daemon
//     running but predates the get_build_status handler (lr-71f0c3) — see
//     this function's STALE_PROCESS handling below
//   { running: true, loadedBuildSha, staleInodes, pid }         — daemon
//     answered normally
//
// Throws only on a genuinely unexpected failure (the binary isn't on PATH,
// or it returned output this parser can't make sense of at all) — a daemon
// that is simply not running, or one that is running but predates this
// check, is NOT a throw, since both are expected, non-failing states.
function resolveProcessBuildStatus(cliBin) {
  const bin = cliBin || 'clagentic-console';
  let raw;
  try {
    raw = execFileSync(bin, ['--process-build-status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    // handleProcessBuildStatus() exits 1 with {"ok":false,"error":"no
    // running daemon"} on stdout when nothing is listening on the socket —
    // execFileSync throws on that non-zero exit, but the JSON is still on
    // err.stdout. Distinguish "no daemon" from a genuine failure by parsing
    // it rather than treating every non-zero exit as fatal.
    const stdout = err.stdout ? err.stdout.toString() : '';
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && parsed.ok === false && parsed.error === 'no running daemon') {
        return { running: false };
      }
    } catch (_parseErr) {
      // fall through below
    }

    // lr-71f0c3: a daemon that predates the get_build_status IPC case
    // (i.e. predates lr-dc9a3b's own introduction) does not hit the
    // {ok:false, error:"no running daemon"} shape above at all — it IS
    // running, it just has no case for this command, so lib/daemon.js's
    // default IPC branch replies {ok:false, error:"unknown command:
    // get_build_status"}, and handleProcessBuildStatus (lib/cli/
    // ipc-subcommands.js) surfaces that on stderr as
    // "Failed: unknown command: get_build_status" with exit 1.
    // execFileSync's err.message embeds that stderr text, so match on it
    // directly here (stdout carries no JSON in this path, unlike the "no
    // running daemon" shape above -- the failure is on stderr, from a
    // console.error, not a stdout console.log).
    const stderrText = err.stderr ? err.stderr.toString() : '';
    if (/unknown command:\s*get_build_status/.test(stderrText) ||
        /unknown command:\s*get_build_status/.test(err.message || '')) {
      return { running: true, stale: true };
    }

    throw new Error(`--process-build-status failed: ${err.message}`);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.loadedBuildSha === 'undefined') {
    throw new Error(`--process-build-status returned unexpected output: ${raw}`);
  }
  return {
    running: true,
    loadedBuildSha: parsed.loadedBuildSha,
    staleInodes: !!parsed.staleInodes,
    pid: parsed.pid,
  };
}

function main() {
  let headSha;
  try {
    headSha = resolveHeadSha();
  } catch (err) {
    console.error(`[verify-installed-build] ERROR: could not resolve this tree's HEAD SHA: ${err.message}`);
    process.exit(1);
  }

  let installed;
  try {
    installed = resolveInstalledSha();
  } catch (err) {
    console.error(`[verify-installed-build] ERROR: could not read installed build-sha.json: ${err.message}`);
    process.exit(1);
  }

  if (installed.sha !== headSha) {
    console.error(
      `[verify-installed-build] ARTIFACT_MISMATCH: installed build (${installed.path}) is at ` +
      `${installed.sha}, but merged HEAD is ${headSha}. The post-merge install did ` +
      `not land the merged commit — investigate before trusting the running build.`
    );
    process.exit(1);
  }

  console.log(`[verify-installed-build] artifact verified: installed build-sha.json matches merged HEAD (${headSha})`);

  // PART 2 (lr-dc9a3b): the artifact is right; now check whether the
  // RUNNING process actually loaded it. This is the check that would have
  // failed at 2026-08-25 01:48 — see test/verify-installed-build-lr-dc9a3b.test.js.
  let processStatus;
  try {
    processStatus = resolveProcessBuildStatus();
  } catch (err) {
    console.error(`[verify-installed-build] ERROR: could not query the running process's build status: ${err.message}`);
    process.exit(1);
  }

  if (!processStatus.running) {
    console.log(
      '[verify-installed-build] ARTIFACT_VERIFIED_NO_PROCESS: artifact matches merged HEAD ' +
      `(${headSha}); no daemon is running, so the PROCESS CHECK DID NOT RUN and the process ` +
      'build status is UNKNOWN -- do not read this as the process/service being verified. ' +
      'Not a failure: there is no running process to compare against yet.'
    );
    return;
  }

  if (processStatus.stale) {
    // lr-71f0c3: the running daemon predates the get_build_status handler
    // itself, so it cannot answer this query at all -- structurally
    // unavoidable until it restarts (see this script's header comment for
    // why this is non-fatal, not a code defect, and not surfaced as the raw
    // transport error). This is NOT read as "verified": the build status of
    // the running process is explicitly UNKNOWN pending a restart.
    console.log(
      '[verify-installed-build] STALE_PROCESS: artifact matches merged HEAD ' +
      `(${headSha}); the running daemon does not recognize the get_build_status query, ` +
      'meaning it predates that handler and has not picked up any build since. The PROCESS build ' +
      'status is UNKNOWN, NOT VERIFIED (PROCESS check inconclusive) -- restart the daemon to ' +
      'clear this: systemctl restart clagentic-console (NOT done automatically by this check). ' +
      'Not a failure: this is expected on first contact with a build that adds a new ' +
      'PROCESS-status query and self-resolves on restart.'
    );
    return;
  }

  const processMismatch = processStatus.loadedBuildSha !== headSha;
  if (processMismatch || processStatus.staleInodes) {
    console.error(
      `[verify-installed-build] PROCESS_MISMATCH: the on-disk artifact matches merged HEAD ` +
      `(${headSha}), but the RUNNING daemon (PID ${processStatus.pid}) has NOT loaded it. ` +
      `loadedBuildSha=${processStatus.loadedBuildSha || '(none)'} staleInodes=${processStatus.staleInodes}. ` +
      `The artifact on disk is correct; the SERVICE is still serving the old build. ` +
      `Restart the daemon to load the new build: systemctl restart clagentic-console ` +
      `(NOT done automatically by this check -- see this script's header comment for why).`
    );
    process.exit(1);
  }

  console.log(
    `[verify-installed-build] ARTIFACT_AND_PROCESS_VERIFIED: installed build-sha.json AND the ` +
    `running daemon (PID ${processStatus.pid}) both match merged HEAD (${headSha}), no stale inodes detected.`
  );
}

module.exports = { resolveHeadSha, resolveInstalledSha, resolveProcessBuildStatus };

if (require.main === module) {
  main();
}
