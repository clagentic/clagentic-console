#!/usr/bin/env node
'use strict';

// verify-installed.js — entry point of `npm run verify:installed-build`.
//
// Runs the two independent post-merge checks and reports each result:
//   installed-build  scripts/verify-installed-build.js  (installed files + running process vs merged HEAD)
//   sdk-lock-drift   scripts/check-sdk-lock-drift.js    (installed SDK versions vs the lock)
//
// They were chained with `&&`, so verify-installed-build's PROCESS_MISMATCH —
// expected after every merge until the daemon restarts — stopped the drift check
// from ever running. Neither result says anything about the other, so both always
// run, each result is printed, and the exit code is non-zero if either failed.
//
// TOOL CONSIDERED: `a; b` / `a || true` in the npm script. A shell separator
// would run both but lose each exit status (or need extra shell to recover it),
// and loadout-merge rejects shell operator tokens in post_merge_steps commands.

const path = require('path');
const { spawnSync } = require('child_process');

const CHECKS = [
  { name: 'installed-build', script: 'verify-installed-build.js' },
  { name: 'sdk-lock-drift', script: 'check-sdk-lock-drift.js' },
];

const TAG = '[verify:installed-build]';

function spawnScript(scriptPath) {
  const res = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });
  if (res.error) return { status: 1, error: res.error.message };
  return { status: res.status === null ? 1 : res.status, signal: res.signal };
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
    results.push({ name: check.name, status });
    log(`${TAG} ${check.name}: ${status === 0 ? 'PASS' : 'FAIL'} (exit ${status}${res.error ? `: ${res.error}` : ''})`);
  }

  const failed = results.filter((r) => r.status !== 0);
  log(`${TAG} ${failed.length === 0 ? 'all checks passed' : `FAILED: ${failed.map((r) => r.name).join(', ')}`}`);
  return { ok: failed.length === 0, results };
}

module.exports = { runAll, CHECKS };

if (require.main === module) {
  process.exit(runAll().ok ? 0 : 1);
}
