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
//        merged HEAD and no daemon is currently running to check (nothing
//        to compare — not a failure).
//   1  — ARTIFACT_MISMATCH: installed build-sha.json does not match merged
//        HEAD (PART 1's original failure mode, unchanged).
//      — PROCESS_MISMATCH: the artifact matches, but the running daemon's
//        loaded SHA differs from merged HEAD, or the daemon itself reports
//        stale inodes (on-disk JS was replaced out from under it). THIS is
//        the failure mode that would have caught 2026-08-25 at 01:48 — see
//        test/verify-installed-build-lr-dc9a3b.test.js for the
//        demonstrated-failure-before-fix simulation.
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
//   { running: false }                                  — no daemon running
//   { running: true, loadedBuildSha, staleInodes, pid }  — daemon answered
//
// Throws only on a genuinely unexpected failure (the binary isn't on PATH,
// or it returned output this parser can't make sense of at all) — a daemon
// that is simply not running is NOT a throw, since that's an expected,
// non-failing state (nothing to compare against yet).
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
      // fall through to the generic failure below
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
      '[verify-installed-build] ARTIFACT_VERIFIED_NO_PROCESS: artifact matches merged HEAD; ' +
      'no running daemon to check against (nothing to compare — not a failure).'
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
