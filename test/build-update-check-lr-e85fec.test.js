// build-update-check-lr-e85fec.test.js — unit tests for lib/build-update-check.js.
//
// lr-e85fec: detection half of daemon build-adoption. This module answers
// exactly one question — does the on-disk build differ from what the
// running process loaded at startup — and nothing else. It never restarts
// anything (see lib/daemon.js's onRestartForBuildUpdate for the operator-
// gated actuator, covered separately in daemon-build-update-restart-lr-e85fec.test.js).

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var os = require('os');

var { readInstalledBuildSha, checkForNewerInstalledBuild } = require('../lib/build-update-check');

function makeTempBuildShaFile(contents) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-e85fec-buildsha-'));
  var filePath = path.join(dir, 'build-sha.json');
  if (contents !== undefined) {
    fs.writeFileSync(filePath, contents);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// readInstalledBuildSha
// ---------------------------------------------------------------------------

test('readInstalledBuildSha: reads the sha field from a well-formed file', function () {
  var filePath = makeTempBuildShaFile(JSON.stringify({ sha: 'abc123', writtenAt: '2026-09-07T00:00:00Z' }));
  assert.equal(readInstalledBuildSha(filePath), 'abc123');
});

test('readInstalledBuildSha: returns null for a missing file', function () {
  var filePath = path.join(os.tmpdir(), 'lr-e85fec-does-not-exist-' + Date.now(), 'build-sha.json');
  assert.equal(readInstalledBuildSha(filePath), null);
});

test('readInstalledBuildSha: returns null for malformed JSON', function () {
  var filePath = makeTempBuildShaFile('{not json');
  assert.equal(readInstalledBuildSha(filePath), null);
});

test('readInstalledBuildSha: returns null when sha field is missing', function () {
  var filePath = makeTempBuildShaFile(JSON.stringify({ writtenAt: '2026-09-07T00:00:00Z' }));
  assert.equal(readInstalledBuildSha(filePath), null);
});

test('readInstalledBuildSha: returns null when sha field is not a string', function () {
  var filePath = makeTempBuildShaFile(JSON.stringify({ sha: 12345 }));
  assert.equal(readInstalledBuildSha(filePath), null);
});

// ---------------------------------------------------------------------------
// checkForNewerInstalledBuild
// ---------------------------------------------------------------------------

test('checkForNewerInstalledBuild: stale=false when both shas match', function () {
  var result = checkForNewerInstalledBuild({ loadedBuildSha: 'abc123', installedBuildSha: 'abc123' });
  assert.equal(result.stale, false);
});

test('checkForNewerInstalledBuild: stale=true when shas differ and both are known', function () {
  var result = checkForNewerInstalledBuild({ loadedBuildSha: 'old-sha', installedBuildSha: 'new-sha' });
  assert.equal(result.stale, true);
  assert.equal(result.loadedBuildSha, 'old-sha');
  assert.equal(result.installedBuildSha, 'new-sha');
});

test('checkForNewerInstalledBuild: stale=false when loadedBuildSha is null (no signal, never guess)', function () {
  var result = checkForNewerInstalledBuild({ loadedBuildSha: null, installedBuildSha: 'new-sha' });
  assert.equal(result.stale, false);
});

test('checkForNewerInstalledBuild: stale=false when installedBuildSha is null (e.g. transient read race)', function () {
  var result = checkForNewerInstalledBuild({ loadedBuildSha: 'old-sha', installedBuildSha: null });
  assert.equal(result.stale, false);
});

test('checkForNewerInstalledBuild: stale=false when both are null', function () {
  var result = checkForNewerInstalledBuild({});
  assert.equal(result.stale, false);
});

test('checkForNewerInstalledBuild: non-string inputs are treated as unknown (null), not coerced', function () {
  var result = checkForNewerInstalledBuild({ loadedBuildSha: 12345, installedBuildSha: 'new-sha' });
  assert.equal(result.stale, false);
  assert.equal(result.loadedBuildSha, null);
});
