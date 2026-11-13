'use strict';

// build-changes.js — the commits between the build a daemon is running and the
// build installed over it, for the operator deciding whether to restart.
//
// Git history is optional: an npm install carries none, a checkout or an
// operator-named source repository (daemon.json `buildSourceRepo`) does. When
// it cannot be read the answer says so; it never invents a list.

var fs = require('fs');
var path = require('path');
var { execFile } = require('child_process');

var SHA_RE = /^[0-9a-f]{7,40}$/i;
var DEFAULT_LIMIT = 30;
var SUBJECT_MAX = 200;
var GIT_TIMEOUT_MS = 5000;

// An install made from a packed tarball (npm install -g, including the
// install:local-test script) carries no .git directory, so the package
// directory cannot answer; buildSourceRepo in daemon.json can, and so can the
// source install:local-test records in the build.
var NO_REPO_REASON = 'this install carries no git history (it was installed from a package, not a checkout); ' +
  'set buildSourceRepo in daemon.json to the checkout it was built from to list the changes';

// Set only by install:local-test, for the one `npm pack` it runs. A pack or a
// publish without it embeds no host path.
var BUILD_SOURCE_ENV = 'CLAGENTIC_CONSOLE_BUILD_SOURCE_REPO';

/**
 * The lasting checkout a local install was built from, as recorded in the
 * package's own lib/build-sha.json, or null. It lives in the installed files,
 * not in daemon.json, so the daemon rewriting its config cannot drop it and an
 * operator's buildSourceRepo is never touched.
 */
function readRecordedSource(packageRoot, readFile) {
  var read = readFile || fs.readFileSync;
  try {
    var parsed = JSON.parse(read(path.join(packageRoot, 'lib', 'build-sha.json'), 'utf8'));
    var src = parsed && parsed.sourceRepo;
    return typeof src === 'string' && path.isAbsolute(src) ? src : null;
  } catch (_) {
    // absent, half-written or unparsable during an install: no recorded source
    return null;
  }
}

/**
 * The repository to read history from, or null when there is none to try.
 * Order: the operator's buildSourceRepo, the source recorded at local install,
 * the package root's own .git.
 */
function resolveHistoryRepo(configured, packageRoot, readFile) {
  if (typeof configured === 'string' && path.isAbsolute(configured)) return configured;
  var recorded = readRecordedSource(packageRoot, readFile);
  if (recorded) return recorded;
  try {
    if (fs.existsSync(path.join(packageRoot, '.git'))) return packageRoot;
  } catch (_) {
    // unreadable package root: no history to offer
  }
  return null;
}

function oneLine(text) {
  var line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > SUBJECT_MAX ? line.slice(0, SUBJECT_MAX - 3) + '...' : line;
}

/**
 * @param {object} o
 * @param {?string} o.repo — result of resolveHistoryRepo
 * @param {string} o.fromSha — the build the process loaded
 * @param {string} o.toSha — the build installed over it
 * @param {number} [o.limit]
 * @param {function} [o.execFileFn] — injectable for tests
 * @returns {Promise<{available: boolean, commits: Array<{sha: string, subject: string}>, truncated: boolean, reason: ?string}>}
 */
function listBuildChanges(o) {
  var limit = o.limit > 0 ? o.limit : DEFAULT_LIMIT;
  var run = o.execFileFn || execFile;
  function unavailable(reason) {
    return { available: false, commits: [], truncated: false, reason: reason };
  }
  if (!o.repo) return Promise.resolve(unavailable(NO_REPO_REASON));
  // Only hex revisions reach git, so a value can never be read as an option.
  if (!SHA_RE.test(String(o.fromSha)) || !SHA_RE.test(String(o.toSha))) {
    return Promise.resolve(unavailable('a build sha is not a git revision'));
  }
  var args = [
    '-C', o.repo,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    'log', '--no-ext-diff', '--no-textconv',
    '--format=%h%x09%s', '-n', String(limit + 1),
    o.fromSha + '..' + o.toSha,
  ];
  return new Promise(function (resolve) {
    run('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, function (err, stdout) {
      if (err) {
        resolve(unavailable('git could not list the commits between these builds'));
        return;
      }
      var lines = String(stdout).split('\n').filter(function (l) { return l.length > 0; });
      var truncated = lines.length > limit;
      var commits = lines.slice(0, limit).map(function (l) {
        var tab = l.indexOf('\t');
        return { sha: l.slice(0, tab), subject: oneLine(l.slice(tab + 1)) };
      });
      resolve({ available: true, commits: commits, truncated: truncated, reason: null });
    });
  });
}

module.exports = { listBuildChanges: listBuildChanges, resolveHistoryRepo: resolveHistoryRepo, readRecordedSource: readRecordedSource, BUILD_SOURCE_ENV: BUILD_SOURCE_ENV, DEFAULT_LIMIT: DEFAULT_LIMIT, NO_REPO_REASON: NO_REPO_REASON };
