// build-update-check.js — lr-e85fec: detects that a newer build has been
// installed on disk than the one this running daemon process loaded at
// startup, so the daemon can OFFER the operator a restart instead of the
// condition sitting invisible until someone remembers to check.
//
// This is deliberately detection-only. It never restarts anything itself —
// see lib/daemon.js's onRestartForBuildUpdate for the operator-initiated
// actuator, and this module's own header note below for why that split is
// load-bearing, not incidental.
//
// Reuses existing signals rather than inventing new ones:
//   - `loadedBuildSha` (lib/daemon.js): captured ONCE at process startup from
//     lib/build-sha.json — never re-read, so it always reflects what THIS
//     process actually has in its module cache (lr-dc9a3b).
//   - the on-disk lib/build-sha.json file: re-read fresh on every poll here,
//     so it reflects whatever `npm install -g` most recently wrote — the
//     same file scripts/verify-installed-build.js compares against merged
//     HEAD at merge time.
//
// A daemon process that started before lib/build-sha.json existed (a dev
// checkout that never ran `npm pack`) reports loadedBuildSha === null. That
// is a legitimate "no build-identity signal available" state (see
// lib/daemon.js's own comment on the same condition) — never surfaced as a
// staleness diagnostic, since there is nothing to compare against.

'use strict';

var fs = require('fs');

/**
 * Read the current on-disk build-sha.json's `sha` field.
 *
 * @param {string} buildShaPath — absolute path to lib/build-sha.json.
 * @returns {string|null} the SHA, or null if the file is missing/malformed
 *   (a dev checkout that has never run `npm pack`, or a filesystem race with
 *   an in-progress install write — both are "unknown," not "stale").
 */
function readInstalledBuildSha(buildShaPath) {
  try {
    var raw = fs.readFileSync(buildShaPath, 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed.sha === 'string') return parsed.sha;
  } catch (_) {
    // Missing/unreadable/malformed — treated as "unknown," not "stale."
  }
  return null;
}

/**
 * Pure comparison: does the on-disk build differ from what this process
 * loaded at startup?
 *
 * @param {object} opts
 * @param {string|null} opts.loadedBuildSha — captured once at daemon startup.
 * @param {string|null} opts.installedBuildSha — freshly read from disk.
 * @returns {{stale: boolean, loadedBuildSha: string|null, installedBuildSha: string|null}}
 *   stale is true only when BOTH shas are known non-null strings and they
 *   differ — never true from an absent/unreadable signal on either side,
 *   matching lib/daemon.js's own "no signal" (never guess) discipline for
 *   loadedBuildSha above.
 */
function checkForNewerInstalledBuild(opts) {
  var o = opts || {};
  var loaded = typeof o.loadedBuildSha === 'string' ? o.loadedBuildSha : null;
  var installed = typeof o.installedBuildSha === 'string' ? o.installedBuildSha : null;
  return {
    stale: !!(loaded && installed && loaded !== installed),
    loadedBuildSha: loaded,
    installedBuildSha: installed,
  };
}

/**
 * Bounded wait for in-flight sessions to finish, then invoke `onIdle()`.
 * Extracted out of lib/daemon.js's onRestartForBuildUpdate so this timing
 * logic is unit-testable without spinning up a real daemon process (the
 * daemon script itself has no other exported surface — see
 * test/daemon-bootstrap-guard.test.js's subprocess-spawn approach for why
 * that path is reserved for bootstrap-only cases, not routine logic).
 *
 * This is the ONLY thing standing between "operator clicked restart" and
 * "daemon actually restarts" — it never fires without that click (see
 * lib/project-sessions.js's restart_for_build_update handler, which is the
 * sole caller of the onRestartForBuildUpdate that wraps this). It exists so
 * that click does not also mean "drop whatever is running right now" when
 * waiting a bounded amount of time can avoid that.
 *
 * @param {object} opts
 * @param {function(): number} opts.getActiveCount — same shape as
 *   drain.js's opts.getActiveCount (lib/sdk-bridge.js's getActiveLiveCount).
 * @param {function(): void} opts.onIdle — called exactly once, either when
 *   getActiveCount() reaches <= 0 or when the timeout elapses.
 * @param {number} [opts.timeoutMs] — defaults to DEFAULT_RESTART_WAIT_MS.
 * @param {number} [opts.pollIntervalMs] — defaults to 1000.
 * @param {function(function(): void, number): void} [opts.setTimeoutFn] —
 *   injectable for tests (default: a thin wrapper over the global
 *   setTimeout). Called as setTimeoutFn(fn, delayMs); must invoke fn with no
 *   arguments after that delay, same contract as the global setTimeout.
 * @param {function(): number} [opts.nowMs] — injectable for tests (default
 *   Date.now).
 */
var DEFAULT_RESTART_WAIT_MS = 60 * 1000;

function waitForIdleThenAct(opts) {
  var o = opts || {};
  if (typeof o.getActiveCount !== 'function') {
    throw new Error('waitForIdleThenAct: opts.getActiveCount must be a function');
  }
  if (typeof o.onIdle !== 'function') {
    throw new Error('waitForIdleThenAct: opts.onIdle must be a function');
  }
  var timeoutMs = (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) ? o.timeoutMs : DEFAULT_RESTART_WAIT_MS;
  var pollIntervalMs = (typeof o.pollIntervalMs === 'number' && o.pollIntervalMs > 0) ? o.pollIntervalMs : 1000;
  var now = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  var scheduleFn = typeof o.setTimeoutFn === 'function' ? o.setTimeoutFn : function (fn, delay) { setTimeout(fn, delay); };

  var deadline = now() + timeoutMs;
  var acted = false;

  function tick() {
    if (acted) return; // idempotent — a stray extra tick must never double-fire
    if (o.getActiveCount() <= 0 || now() >= deadline) {
      acted = true;
      o.onIdle();
      return;
    }
    scheduleFn(tick, pollIntervalMs);
  }

  tick();
}

module.exports = {
  readInstalledBuildSha: readInstalledBuildSha,
  checkForNewerInstalledBuild: checkForNewerInstalledBuild,
  waitForIdleThenAct: waitForIdleThenAct,
  DEFAULT_RESTART_WAIT_MS: DEFAULT_RESTART_WAIT_MS,
};
