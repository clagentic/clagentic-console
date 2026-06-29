// drain-lr-6b30.test.js — unit tests for lib/drain.js (lr-6b30)
//
// Covers:
//   1. Drain state gates new sessions (isDraining returns true after enterDrain).
//   2. In-flight sessions complete before exit (exit deferred until count = 0).
//   3. Timeout-forced exit fires when active sessions do not complete in time.
//   4. Signal trigger via enterDrain (SIGUSR1/SIGUSR2 paths).
//   5. Config-driven drain timeout.
//   6. Structured log events on enter and exit.
//   7. onMemoryHighCrossing triggers drain.
//   8. Idempotency: multiple enter calls do not double-exit.

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var { createDrain, DEFAULT_DRAIN_TIMEOUT_MS } = require('../lib/drain');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal drain controller for tests.
 *
 * @param {object} overrides
 * @param {number} [overrides.activeCount]   — initial live query count
 * @param {number} [overrides.drainTimeoutMs]
 * @param {function[]} [overrides.logs]  — array to accumulate log events
 * @returns {{ drain, shutdownCalled, logs, setActiveCount }}
 */
function makeDrain(overrides) {
  var overrides = overrides || {};
  var activeCount = overrides.activeCount != null ? overrides.activeCount : 0;
  var logs = overrides.logs || [];
  var shutdownCalled = { count: 0 };

  var drain = createDrain({
    gracefulShutdown: function () { shutdownCalled.count++; },
    getActiveCount: function () { return activeCount; },
    drainTimeoutMs: overrides.drainTimeoutMs,
    log: function (event) { logs.push(event); },
  });

  return {
    drain: drain,
    shutdownCalled: shutdownCalled,
    logs: logs,
    setActiveCount: function (n) { activeCount = n; },
  };
}

// ---------------------------------------------------------------------------
// 1. Drain state gating
// ---------------------------------------------------------------------------

test('isDraining: false before enterDrain', function () {
  var h = makeDrain();
  assert.strictEqual(h.drain.isDraining(), false);
});

test('isDraining: true after enterDrain', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.enterDrain('signal_usr1');
  assert.strictEqual(h.drain.isDraining(), true);
});

test('isDraining: true when entered via onMemoryHighCrossing', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.onMemoryHighCrossing({ source: 'rss_vs_threshold' });
  assert.strictEqual(h.drain.isDraining(), true);
});

// ---------------------------------------------------------------------------
// 2. In-flight sessions complete before exit
// ---------------------------------------------------------------------------

test('exit deferred: gracefulShutdown not called while active count > 0', function (t, done) {
  var h = makeDrain({ activeCount: 1, drainTimeoutMs: 5000 });
  h.drain.enterDrain('signal_usr2');

  // Not yet shut down immediately after entering drain
  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 0, 'should not exit while active session exists');
    done();
  }, 50);
});

test('exit fires when active count drops to 0', function (t, done) {
  var h = makeDrain({ activeCount: 1, drainTimeoutMs: 5000 });
  h.drain.enterDrain('signal_usr2');

  // Simulate session ending
  setTimeout(function () {
    h.setActiveCount(0);
  }, 100);

  // Poll interval is 1s by default, so check after poll fires
  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'should exit once active count reaches 0');
    done();
  }, 1200);
});

// ---------------------------------------------------------------------------
// 3. Timeout-forced exit
// ---------------------------------------------------------------------------

test('timeout forced exit: exits after drainTimeoutMs even with active sessions', function (t, done) {
  var h = makeDrain({ activeCount: 1, drainTimeoutMs: 150 });
  h.drain.enterDrain('signal_usr1');

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'should force exit after timeout');
    var exitLog = h.logs.find(function (l) { return l.event === 'drain_exit'; });
    assert.ok(exitLog, 'drain_exit log must be emitted');
    assert.strictEqual(exitLog.reason, 'timeout_forced');
    done();
  }, 250);
});

// ---------------------------------------------------------------------------
// 4. Signal trigger via enterDrain
// ---------------------------------------------------------------------------

test('enterDrain with signal_usr1 reason', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.enterDrain('signal_usr1');
  assert.strictEqual(h.drain.isDraining(), true);
  var enterLog = h.logs.find(function (l) { return l.event === 'drain_enter'; });
  assert.ok(enterLog, 'drain_enter log must be emitted');
  assert.strictEqual(enterLog.reason, 'signal_usr1');
});

test('enterDrain with signal_usr2 reason', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.enterDrain('signal_usr2');
  assert.strictEqual(h.drain.isDraining(), true);
  var enterLog = h.logs.find(function (l) { return l.event === 'drain_enter'; });
  assert.ok(enterLog, 'drain_enter log must be emitted');
  assert.strictEqual(enterLog.reason, 'signal_usr2');
});

// ---------------------------------------------------------------------------
// 5. Config-driven drain timeout
// ---------------------------------------------------------------------------

test('DEFAULT_DRAIN_TIMEOUT_MS is 60 seconds', function () {
  assert.strictEqual(DEFAULT_DRAIN_TIMEOUT_MS, 60000);
});

test('custom drainTimeoutMs is respected', function (t, done) {
  var h = makeDrain({ activeCount: 1, drainTimeoutMs: 80 });
  h.drain.enterDrain('signal_usr1');

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 0, 'should not exit before custom timeout');
  }, 30);

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'should exit after custom drainTimeoutMs');
    done();
  }, 200);
});

test('drain controller exposes _DEFAULT_DRAIN_TIMEOUT_MS', function () {
  var h = makeDrain();
  assert.strictEqual(h.drain._DEFAULT_DRAIN_TIMEOUT_MS, DEFAULT_DRAIN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 6. Structured log events on enter and exit
// ---------------------------------------------------------------------------

test('drain_enter log includes required fields', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.enterDrain('memory_high_watermark', { source: 'cgroup.memory.events' });
  var enterLog = h.logs.find(function (l) { return l.event === 'drain_enter'; });
  assert.ok(enterLog, 'drain_enter log must exist');
  assert.strictEqual(enterLog.reason, 'memory_high_watermark');
  assert.strictEqual(enterLog.activeCount, 0);
  assert.ok(typeof enterLog.drainTimeoutMs === 'number', 'drainTimeoutMs must be a number');
  assert.ok(typeof enterLog.timestamp === 'string', 'timestamp must be a string');
  // Detail fields from watermark event should be merged
  assert.strictEqual(enterLog.source, 'cgroup.memory.events');
});

test('drain_exit log emitted when exiting due to zero active count', function (t, done) {
  var h = makeDrain({ activeCount: 0, drainTimeoutMs: 5000 });
  h.drain.enterDrain('signal_usr2');
  // Immediate exit when count was already 0
  setTimeout(function () {
    var exitLog = h.logs.find(function (l) { return l.event === 'drain_exit'; });
    assert.ok(exitLog, 'drain_exit log must be emitted');
    assert.strictEqual(exitLog.reason, 'active_count_zero');
    assert.ok(typeof exitLog.timestamp === 'string', 'timestamp must be a string');
    done();
  }, 50);
});

test('drain_exit log emitted when timeout forces exit', function (t, done) {
  var h = makeDrain({ activeCount: 1, drainTimeoutMs: 80 });
  h.drain.enterDrain('signal_usr1');

  setTimeout(function () {
    var exitLog = h.logs.find(function (l) { return l.event === 'drain_exit'; });
    assert.ok(exitLog, 'drain_exit log must be emitted');
    assert.strictEqual(exitLog.reason, 'timeout_forced');
    done();
  }, 200);
});

// ---------------------------------------------------------------------------
// 7. onMemoryHighCrossing triggers drain
// ---------------------------------------------------------------------------

test('onMemoryHighCrossing: enters drain with memory_high_watermark reason', function () {
  var h = makeDrain({ activeCount: 0 });
  h.drain.onMemoryHighCrossing({ source: 'rss_vs_threshold', currentBytes: 1000000 });
  assert.strictEqual(h.drain.isDraining(), true);
  var enterLog = h.logs.find(function (l) { return l.event === 'drain_enter'; });
  assert.ok(enterLog, 'drain_enter log must be emitted');
  assert.strictEqual(enterLog.reason, 'memory_high_watermark');
  assert.strictEqual(enterLog.source, 'rss_vs_threshold');
  assert.strictEqual(enterLog.currentBytes, 1000000);
});

// ---------------------------------------------------------------------------
// 8. Idempotency
// ---------------------------------------------------------------------------

test('enterDrain is idempotent: second call is a no-op', function (t, done) {
  var h = makeDrain({ activeCount: 0, drainTimeoutMs: 5000 });
  h.drain.enterDrain('signal_usr1');
  h.drain.enterDrain('signal_usr2');  // second call — must not double-exit

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'gracefulShutdown must be called exactly once');
    var enterLogs = h.logs.filter(function (l) { return l.event === 'drain_enter'; });
    assert.strictEqual(enterLogs.length, 1, 'only one drain_enter log must be emitted');
    done();
  }, 100);
});

test('onMemoryHighCrossing followed by signal does not double-exit', function (t, done) {
  var h = makeDrain({ activeCount: 0, drainTimeoutMs: 5000 });
  h.drain.onMemoryHighCrossing({});
  h.drain.enterDrain('signal_usr1');

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'gracefulShutdown must be called exactly once');
    done();
  }, 100);
});

// ---------------------------------------------------------------------------
// 9. createDrain: validation
// ---------------------------------------------------------------------------

test('createDrain throws when gracefulShutdown is missing', function () {
  assert.throws(function () {
    createDrain({ getActiveCount: function () { return 0; } });
  }, /gracefulShutdown/);
});

test('createDrain throws when getActiveCount is missing', function () {
  assert.throws(function () {
    createDrain({ gracefulShutdown: function () {} });
  }, /getActiveCount/);
});

// ---------------------------------------------------------------------------
// 10. Immediate exit when no in-flight sessions
// ---------------------------------------------------------------------------

test('immediate exit when activeCount is 0 at enterDrain time', function (t, done) {
  var h = makeDrain({ activeCount: 0, drainTimeoutMs: 5000 });
  h.drain.enterDrain('signal_usr1');

  setTimeout(function () {
    assert.strictEqual(h.shutdownCalled.count, 1, 'should exit immediately when no active sessions');
    done();
  }, 50);
});
