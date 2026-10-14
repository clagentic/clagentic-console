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

/** The repository to read history from, or null when there is none to try. */
function resolveHistoryRepo(configured, packageRoot) {
  if (typeof configured === 'string' && path.isAbsolute(configured)) return configured;
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
  if (!o.repo) return Promise.resolve(unavailable('no git history is available for this install'));
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

module.exports = { listBuildChanges: listBuildChanges, resolveHistoryRepo: resolveHistoryRepo, DEFAULT_LIMIT: DEFAULT_LIMIT };
