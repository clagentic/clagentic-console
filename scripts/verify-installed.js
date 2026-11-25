#!/usr/bin/env node
'use strict';

// verify-installed.js — entry point of `npm run verify:installed-build`.
//
// Runs the two independent post-merge checks and reports each result:
//   installed-build  scripts/verify-installed-build.js  (installed files + running process vs merged HEAD)
//   sdk-lock-drift   scripts/check-sdk-lock-drift.js    (installed SDK versions vs the lock)
//
// They were chained with `&&`, so a failing installed-build check stopped the
// drift check from ever running. Neither result says anything about the other,
// so both always run, each result is printed, and the exit code is non-zero if
// either failed. An installed-build PENDING_RESTART (the daemon still runs an
// earlier build until its next restart) exits 0 and is labelled in the summary.
//
// TOOL CONSIDERED: `a; b` / `a || true` in the npm script. A shell separator
// would run both but lose each exit status (or need extra shell to recover it),
// and loadout-merge rejects shell operator tokens in post_merge_steps commands.

const path = require('path');
const { spawnSync } = require('child_process');
const { PENDING_RESTART_MARKER } = require('./verify-installed-build');

const CHECKS = [
  { name: 'installed-build', script: 'verify-installed-build.js' },
  { name: 'sdk-lock-drift', script: 'check-sdk-lock-drift.js' },
];

const TAG = '[verify:installed-build]';

// stdout is captured and replayed so the summary can tell a pending-restart
// pass from a plain one; stderr and stdin stay attached.
function spawnScript(scriptPath) {
  const res = spawnSync(process.execPath, [scriptPath], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.error) return { status: 1, error: res.error.message };
  return {
    status: res.status === null ? 1 : res.status,
    signal: res.signal,
    pendingRestart: (res.stdout || '').includes(PENDING_RESTART_MARKER),
  };
}

/**
 * @param {object} [opts]
 * @param {Array<{name:string, script:string}>} [opts.checks]
 * @param {string} [opts.scriptsDir]
 * @param {function} [opts.runScript]  (absPath) => {status, error?}; for tests.
 * @param {function} [opts.log]
 * @returns {{ok: boolean, results: Array<{name:string, status:number}>}}
 */
function runAll(opts) {
  opts = opts || {};
  const checks = opts.checks || CHECKS;
  const scriptsDir = opts.scriptsDir || __dirname;
  const runScript = opts.runScript || spawnScript;
  const log = opts.log || ((m) => console.log(m));

  const results = [];
  for (const check of checks) {
    const res = runScript(path.join(scriptsDir, check.script));
    const status = res.status;
    const pendingRestart = status === 0 && !!res.pendingRestart;
    results.push({ name: check.name, status, pendingRestart });
    // A pending restart passes the step but is never a bare PASS: the merged
    // build is not live until the daemon restarts.
    const label = status !== 0 ? 'FAIL' : pendingRestart ? 'PASS (restart pending)' : 'PASS';
    log(`${TAG} ${check.name}: ${label} (exit ${status}${res.error ? `: ${res.error}` : ''})`);
  }

  const failed = results.filter((r) => r.status !== 0);
  const pending = results.filter((r) => r.pendingRestart);
  let summary;
  if (failed.length > 0) summary = `FAILED: ${failed.map((r) => r.name).join(', ')}`;
  else if (pending.length > 0) summary = 'all checks passed, daemon restart pending: the merged build is NOT live until the daemon restarts';
  else summary = 'all checks passed';
  log(`${TAG} ${summary}`);
  return { ok: failed.length === 0, results };
}

module.exports = { runAll, CHECKS };

if (require.main === module) {
  process.exit(runAll().ok ? 0 : 1);
}
