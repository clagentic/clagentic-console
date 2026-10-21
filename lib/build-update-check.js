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

module.exports = {
  readInstalledBuildSha: readInstalledBuildSha,
  checkForNewerInstalledBuild: checkForNewerInstalledBuild,
};
