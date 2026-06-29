// drain.js — graceful drain state for the daemon (lr-6b30).
//
// Drain is entered when either:
//   A. The lr-de07 MemoryHigh watermark watcher fires an onCrossing callback.
//   B. An operator sends SIGUSR1 or SIGUSR2 (manual drain/restart signal).
//
// While draining:
//   - New WebSocket session connections are rejected with a structured error.
//   - In-flight sessions are allowed to complete. The drain controller checks
//     the live query count via opts.getActiveCount() and exits once it hits zero.
//   - A configurable drain timeout (default 60 s) forces exit if sessions do
//     not complete in time.
//
// The module exports createDrain(opts), which returns a controller object used
// by daemon.js and the WebSocket gate in server.js.
//
// Design constraints:
//   - No second memory poller; consume startMemoryHighWatcher's signal only.
//   - Reuse gracefulShutdown() from daemon.js; do not invent a parallel path.
//   - One drain state machine; both trigger paths set the same state.

'use strict';

// Default drain timeout in milliseconds.
var DEFAULT_DRAIN_TIMEOUT_MS = 60 * 1000;

// How often to check the live-query count after entering drain state.
var DRAIN_POLL_INTERVAL_MS = 1000;

/**
 * Create a drain controller.
 *
 * @param {object} opts
 * @param {function(): void} opts.gracefulShutdown
 *   Called when all in-flight sessions complete (or timeout expires).
 * @param {function(): number} opts.getActiveCount
 *   Returns the current number of in-flight queries. Provided by daemon.js
 *   from sdk-bridge's getActiveLiveCount(). Queried on a 1-second interval
 *   after drain is entered.
 * @param {number} [opts.drainTimeoutMs]
 *   Maximum ms to wait for in-flight sessions before forcing exit.
 *   Reads from config.drainTimeoutMs if provided; defaults to 60000.
 * @param {function(object): void} [opts.log]
 *   Structured log emitter. Receives a plain object; default emits JSON to
 *   stderr so journald captures it alongside other daemon output.
 *
 * @returns {DrainController}
 */
function createDrain(opts) {
  if (!opts || typeof opts.gracefulShutdown !== 'function') {
    throw new Error('drain.createDrain: opts.gracefulShutdown must be a function');
  }
  if (typeof opts.getActiveCount !== 'function') {
    throw new Error('drain.createDrain: opts.getActiveCount must be a function');
  }

  var gracefulShutdown = opts.gracefulShutdown;
  var getActiveCount = opts.getActiveCount;
  var drainTimeoutMs = (opts.drainTimeoutMs != null && opts.drainTimeoutMs > 0)
    ? opts.drainTimeoutMs
    : DEFAULT_DRAIN_TIMEOUT_MS;

  var _log = opts.log || function (event) {
    try {
      process.stderr.write('[drain] ' + JSON.stringify(event) + '\n');
    } catch (_) {}
  };

  // --- State ---
  var _isDraining = false;
  var _drainReason = null;
  var _drainTimeout = null;
  var _drainPollHandle = null;
  var _signalsRegistered = false;
  var _exitCalled = false;

  // --- Internal helpers ---

  function _emitLog(event) {
    try { _log(event); } catch (_) {}
  }

  function _callExit(reason) {
    if (_exitCalled) return;
    _exitCalled = true;
    _clearTimers();
    _emitLog({
      event: 'drain_exit',
      reason: reason,
      activeCount: getActiveCount(),
      timestamp: new Date().toISOString(),
    });
    gracefulShutdown();
  }

  function _clearTimers() {
    if (_drainTimeout) {
      clearTimeout(_drainTimeout);
      _drainTimeout = null;
    }
    if (_drainPollHandle) {
      clearInterval(_drainPollHandle);
      _drainPollHandle = null;
    }
  }

  function _checkActiveCount() {
    if (!_isDraining || _exitCalled) return;
    var count = getActiveCount();
    if (count <= 0) {
      _callExit('active_count_zero');
    }
  }

  function _forceExit() {
    _callExit('timeout_forced');
  }

  // --- Public API ---

  /**
   * Enter drain state. Idempotent: subsequent calls from either trigger path
   * are no-ops — only the first crossing matters.
   *
   * @param {string} reason  — 'memory_high_watermark' | 'signal_usr1' | 'signal_usr2'
   * @param {object} [detail] — optional extra fields for the log event
   */
  function enterDrain(reason, detail) {
    if (_isDraining) return; // already draining — idempotent
    _isDraining = true;
    _drainReason = reason;

    var activeCount = getActiveCount();
    var logEvent = Object.assign({
      event: 'drain_enter',
      reason: reason,
      activeCount: activeCount,
      drainTimeoutMs: drainTimeoutMs,
      timestamp: new Date().toISOString(),
    }, detail || {});
    _emitLog(logEvent);

    // If no sessions are currently active, exit immediately.
    if (activeCount <= 0) {
      _callExit('active_count_zero');
      return;
    }

    // Arm the timeout guard so a stuck session cannot hold the daemon up forever.
    _drainTimeout = setTimeout(_forceExit, drainTimeoutMs);
    // Unref so the timeout alone does not prevent other exit paths.
    if (_drainTimeout && typeof _drainTimeout.unref === 'function') {
      _drainTimeout.unref();
    }

    // Poll the live-query count every second so we exit as soon as sessions finish.
    _drainPollHandle = setInterval(_checkActiveCount, DRAIN_POLL_INTERVAL_MS);
    if (_drainPollHandle && typeof _drainPollHandle.unref === 'function') {
      _drainPollHandle.unref();
    }
  }

  /**
   * Returns true when the daemon is in drain state.
   *
   * @returns {boolean}
   */
  function isDraining() {
    return _isDraining;
  }

  /**
   * Register SIGUSR1 and SIGUSR2 as manual drain triggers.
   *
   * Idempotent: safe to call multiple times.
   */
  function registerSignals() {
    if (_signalsRegistered) return;
    _signalsRegistered = true;

    // SIGUSR1 is used by Node.js built-in debugger on some platforms — we still
    // register it because this daemon does not use the built-in debugger in
    // production, and operator-initiated drain is the intended use case here.
    process.on('SIGUSR1', function () {
      enterDrain('signal_usr1');
    });
    process.on('SIGUSR2', function () {
      enterDrain('signal_usr2');
    });
  }

  /**
   * Called by the MemoryHigh watcher's onCrossing callback.
   * Enters drain state with the watermark event detail attached to the log.
   *
   * @param {object} [detail] — fields from the watermark event (source, currentBytes, etc.)
   */
  function onMemoryHighCrossing(detail) {
    enterDrain('memory_high_watermark', detail || {});
  }

  return {
    isDraining: isDraining,
    enterDrain: enterDrain,
    registerSignals: registerSignals,
    onMemoryHighCrossing: onMemoryHighCrossing,
    // Exposed for testing only.
    _DEFAULT_DRAIN_TIMEOUT_MS: DEFAULT_DRAIN_TIMEOUT_MS,
    _DRAIN_POLL_INTERVAL_MS: DRAIN_POLL_INTERVAL_MS,
  };
}

module.exports = { createDrain: createDrain, DEFAULT_DRAIN_TIMEOUT_MS: DEFAULT_DRAIN_TIMEOUT_MS };
