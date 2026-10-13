'use strict';

// build-identity.js — what build is this process running, and is it still the
// build installed on disk?
//
// An install replaces the package's files. A running Node process keeps what
// it already loaded, so "adopted" means two things must both hold: the sha the
// process recorded at startup equals the sha of the installed build, and the
// installed files are byte-for-byte what the process started from. The second
// half is what tells an identical reinstall (same sha, same bytes, new inodes)
// apart from a genuinely different build with an unchanged sha.
//
// The kernel's "(deleted)" mapping marker is NOT part of this decision: an
// identical reinstall unlinks the native module the daemon keeps mapped, so
// that marker appears and never clears, although nothing the daemon runs
// differs from what is installed.

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var { readInstalledBuildSha } = require('./build-update-check');

var STATES = { ADOPTED: 'adopted', STALE: 'stale', INCONCLUSIVE: 'inconclusive' };

/**
 * Walks `dir` and calls fn(absPath, relPath) for every regular file, in a
 * stable order. Symlinks and special files are not content of the build.
 */
function walkFiles(dir, relBase, fn) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var abs = path.join(dir, entry.name);
    var rel = relBase ? relBase + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walkFiles(abs, rel, fn);
    else if (entry.isFile()) fn(abs, rel);
  }
}

/**
 * A hasher over one package root (the directory holding lib/ and
 * package.json). `hash()` returns a hex digest of every file under lib/ plus
 * package.json, or null when the tree cannot be read right now (an install in
 * progress removes files mid-walk). Per-file digests are remembered by
 * (inode, size, mtime), so a poll re-reads only files an install replaced.
 */
function createTreeHasher(packageRoot) {
  var known = new Map(); // abs path -> { key, digest }

  function fileDigest(abs) {
    var st = fs.statSync(abs);
    var key = st.ino + ':' + st.size + ':' + st.mtimeMs;
    var cached = known.get(abs);
    if (cached && cached.key === key) return cached.digest;
    var digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    known.set(abs, { key: key, digest: digest });
    return digest;
  }

  function hash() {
    try {
      var outer = crypto.createHash('sha256');
      var seen = new Set();
      var add = function (abs, rel) {
        seen.add(abs);
        outer.update(rel + '\0' + fileDigest(abs) + '\n');
      };
      walkFiles(path.join(packageRoot, 'lib'), 'lib', add);
      add(path.join(packageRoot, 'package.json'), 'package.json');
      // Files that left the tree must not keep their remembered digest.
      known.forEach(function (_v, abs) { if (!seen.has(abs)) known.delete(abs); });
      return outer.digest('hex');
    } catch (_) {
      return null;
    }
  }

  return { hash: hash };
}

/**
 * Pure comparison of what the process loaded against what is installed.
 * Exactly one of adopted / stale / inconclusive, never a guess: a missing
 * piece on either side is inconclusive with the reason, not stale.
 *
 * @param {{sha: ?string, contentHash: ?string}} loaded
 * @param {{sha: ?string, contentHash: ?string}} installed
 */
function assessBuild(loaded, installed) {
  var l = loaded || {};
  var i = installed || {};
  var base = {
    loadedBuildSha: l.sha || null,
    installedBuildSha: i.sha || null,
    loadedContentHash: l.contentHash || null,
    installedContentHash: i.contentHash || null,
  };
  function result(state, reason, detail) {
    return Object.assign({ state: state, reason: reason, detail: detail }, base);
  }
  if (!l.sha) {
    return result(STATES.INCONCLUSIVE, 'no-loaded-sha',
      'this process has no embedded build sha (a checkout that never ran npm pack)');
  }
  if (!i.sha) {
    return result(STATES.INCONCLUSIVE, 'no-installed-sha',
      'the installed build-sha.json is missing or unreadable');
  }
  if (l.sha !== i.sha) {
    return result(STATES.STALE, 'sha', 'the installed build (' + i.sha + ') is not the one this process loaded (' + l.sha + ')');
  }
  if (!l.contentHash || !i.contentHash) {
    return result(STATES.INCONCLUSIVE, 'hash-unavailable',
      'the installed files could not be read to compare their content');
  }
  if (l.contentHash !== i.contentHash) {
    return result(STATES.STALE, 'content',
      'the installed files differ from the ones this process loaded, although both report build ' + l.sha);
  }
  return result(STATES.ADOPTED, 'identical', 'the installed build is the one this process loaded');
}

/**
 * Captures the running build once, at startup, and reads the installed one on
 * demand. `libDir` is the lib/ directory this process was loaded from.
 */
function createBuildIdentity(libDir) {
  var packageRoot = path.resolve(libDir, '..');
  var buildShaPath = path.join(libDir, 'build-sha.json');
  var hasher = createTreeHasher(packageRoot);
  var loaded = { sha: readInstalledBuildSha(buildShaPath), contentHash: hasher.hash() };

  function readInstalled() {
    return { sha: readInstalledBuildSha(buildShaPath), contentHash: hasher.hash() };
  }

  return {
    loaded: loaded,
    readInstalled: readInstalled,
    assess: function () { return assessBuild(loaded, readInstalled()); },
  };
}

module.exports = {
  STATES: STATES,
  assessBuild: assessBuild,
  createBuildIdentity: createBuildIdentity,
  createTreeHasher: createTreeHasher,
};
