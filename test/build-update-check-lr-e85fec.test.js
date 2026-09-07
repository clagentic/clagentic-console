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

var { readInstalledBuildSha, checkForNewerInstalledBuild, waitForIdleThenAct, DEFAULT_RESTART_WAIT_MS } = require('../lib/build-update-check');

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

// ---------------------------------------------------------------------------
// waitForIdleThenAct
//
// Uses an injected fake clock + scheduler (nowMs / setTimeoutFn) so the whole
// suite runs synchronously — no real timers, no test relying on wall-clock
// timing to pass reliably under CI load.
// ---------------------------------------------------------------------------

/**
 * Build a fake scheduler: fn(nowMs, setTimeoutFn) pair that lets a test
 * manually advance "time" and pump pending callbacks, without any real
 * setTimeout involved.
 */
function makeFakeClock(startMs) {
  var current = startMs || 0;
  var pending = []; // [{ fireAt, cb }]

  return {
    nowMs: function () { return current; },
    setTimeoutFn: function (cb, delay) {
      pending.push({ fireAt: current + delay, cb: cb });
    },
    // Advance the clock by `ms` and fire any callback whose fireAt has been
    // reached, in fireAt order. Newly-scheduled callbacks from a fired
    // callback are eligible in the same advance() call (mirrors how a real
    // event loop would let a same-tick setTimeout(..., 0) fire before the
    // next macrotask boundary, close enough for this test's purposes since
    // this module's own poll loop always schedules at pollIntervalMs > 0).
    advance: function (ms) {
      current += ms;
      var fired = true;
      while (fired) {
        fired = false;
        for (var i = 0; i < pending.length; i++) {
          if (pending[i].fireAt <= current) {
            var due = pending.splice(i, 1)[0];
            due.cb();
            fired = true;
            break;
          }
        }
      }
    },
  };
}

test('waitForIdleThenAct: calls onIdle immediately when activeCount is already 0', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  waitForIdleThenAct({
    getActiveCount: function () { return 0; },
    onIdle: function () { idleCalls++; },
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  assert.equal(idleCalls, 1);
});

test('waitForIdleThenAct: does not call onIdle while sessions are active and under the timeout', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  waitForIdleThenAct({
    getActiveCount: function () { return 1; },
    onIdle: function () { idleCalls++; },
    timeoutMs: 60000,
    pollIntervalMs: 1000,
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  assert.equal(idleCalls, 0, 'must not fire while a session is still active and time remains');
  clock.advance(5000);
  assert.equal(idleCalls, 0, 'must still not fire after a few polls with an active session');
});

test('waitForIdleThenAct: calls onIdle once activeCount drops to 0 during polling', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  var activeCount = 1;
  waitForIdleThenAct({
    getActiveCount: function () { return activeCount; },
    onIdle: function () { idleCalls++; },
    timeoutMs: 60000,
    pollIntervalMs: 1000,
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  assert.equal(idleCalls, 0);
  activeCount = 0; // session finishes
  clock.advance(1000); // next poll tick observes the drop
  assert.equal(idleCalls, 1);
});

test('waitForIdleThenAct: forces onIdle after the timeout even with sessions still active', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  waitForIdleThenAct({
    getActiveCount: function () { return 1; }, // never drops to 0
    onIdle: function () { idleCalls++; },
    timeoutMs: 5000,
    pollIntervalMs: 1000,
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  clock.advance(4000);
  assert.equal(idleCalls, 0, 'must not force-fire before the timeout elapses');
  clock.advance(2000); // now past the 5000ms deadline
  assert.equal(idleCalls, 1, 'must force-fire once the timeout elapses, active session or not');
});

test('waitForIdleThenAct: onIdle fires exactly once even if polling continues past the deadline', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  waitForIdleThenAct({
    getActiveCount: function () { return 1; },
    onIdle: function () { idleCalls++; },
    timeoutMs: 2000,
    pollIntervalMs: 500,
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  clock.advance(10000); // way past the deadline, in one jump
  assert.equal(idleCalls, 1, 'onIdle must never fire more than once regardless of how many ticks are pending');
});

test('waitForIdleThenAct: defaults timeoutMs to DEFAULT_RESTART_WAIT_MS when not provided', function () {
  var clock = makeFakeClock(0);
  var idleCalls = 0;
  waitForIdleThenAct({
    getActiveCount: function () { return 1; },
    onIdle: function () { idleCalls++; },
    pollIntervalMs: 1000,
    nowMs: clock.nowMs,
    setTimeoutFn: clock.setTimeoutFn,
  });
  clock.advance(DEFAULT_RESTART_WAIT_MS - 1000);
  assert.equal(idleCalls, 0, 'must not fire just before the default deadline');
  clock.advance(1000);
  assert.equal(idleCalls, 1, 'must fire at the default deadline');
});

test('waitForIdleThenAct: throws when getActiveCount is missing', function () {
  assert.throws(function () {
    waitForIdleThenAct({ onIdle: function () {} });
  }, /getActiveCount/);
});

test('waitForIdleThenAct: throws when onIdle is missing', function () {
  assert.throws(function () {
    waitForIdleThenAct({ getActiveCount: function () { return 0; } });
  }, /onIdle/);
});
