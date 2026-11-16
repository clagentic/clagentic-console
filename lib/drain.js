// drain.js — drain and memory-pressure state for the daemon (lr-6b30).
//
// Two distinct states, deliberately not merged:
//
//   Drain (operator-initiated restart): entered by SIGUSR1 or SIGUSR2, and by
//     SIGTERM/SIGINT with a short bound (enterTermDrain) that fits the unit's
//     stop timeout.
//     - New WebSocket connections are rejected with a structured error.
//     - In-flight sessions are allowed to complete; the controller polls
//       opts.getActiveCount() and exits once it hits zero.
//     - A configurable drain timeout (default 60 s) forces exit if sessions do
//       not complete in time.
//
//   Pressure (MemoryHigh soft limit): entered by the watermark watcher's
//     onCrossing callback, left by its onRecovery callback.
//     - New sessions and new agent work are refused (isRefusingNewWork).
//     - Existing sessions keep running and WebSocket clients stay connected so
//       the pressure report reaches the UI.
//     - The daemon NEVER exits because of pressure. The memory belongs to the
//       sessions' own child processes, which a daemon restart cannot free — it
//       only kills them. MemoryMax and the kernel remain the hard backstop.
//
// The module exports createDrain(opts), which returns a controller object used
// by daemon.js, the WebSocket gate in server.js, and the new-work gate in
// sdk-bridge.js.
//
// Design constraints:
//   - No second memory poller; consume startMemoryHighWatcher's signals only.
//   - Reuse gracefulShutdown() from daemon.js; do not invent a parallel path.

'use strict';

// Default drain timeout in milliseconds.
var DEFAULT_DRAIN_TIMEOUT_MS = 60 * 1000;

// How often to check the live-query count after entering drain state.
var DRAIN_POLL_INTERVAL_MS = 1000;

// SIGTERM (systemctl stop/restart) drain bound. The unit's TimeoutStopSec is
// 20 s and gracefulShutdown() arms its own 10 s forced exit once it starts, so
// the drain wait plus that 10 s must stay under 20 s with margin. The default
// leaves 4 s of margin (6 + 10 = 16 s); the ceiling leaves 2 s (8 + 10 = 18 s)
// and clamps any configured value.
var DEFAULT_SIGTERM_DRAIN_TIMEOUT_MS = 6 * 1000;
var MAX_SIGTERM_DRAIN_TIMEOUT_MS = 8 * 1000;

function resolveSigtermTimeoutMs(configured) {
  if (typeof configured !== 'number' || !(configured > 0)) return DEFAULT_SIGTERM_DRAIN_TIMEOUT_MS;
  return Math.min(configured, MAX_SIGTERM_DRAIN_TIMEOUT_MS);
}

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
 * @param {function(boolean, object): void} [opts.onPressureChange]
 *   Called with (underPressure, detail) on each pressure transition so the
 *   caller can report it (UI broadcast). Errors are swallowed.
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
  var sigtermTimeoutMs = resolveSigtermTimeoutMs(opts.sigtermDrainTimeoutMs);

  var _log = opts.log || function (event) {
    try {
      process.stderr.write('[drain] ' + JSON.stringify(event) + '\n');
    } catch (_) {}
  };

  // --- State ---
  var onPressureChange = typeof opts.onPressureChange === 'function' ? opts.onPressureChange : null;
  var _isDraining = false;
  var _underPressure = false;
  var _drainReason = null;
  var _drainTimeout = null;
  var _drainDeadline = 0;
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

  function _armTimeout(ms) {
    if (_drainTimeout) clearTimeout(_drainTimeout);
    _drainDeadline = Date.now() + ms;
    _drainTimeout = setTimeout(_forceExit, ms);
    // Unref so the timeout alone does not prevent other exit paths.
    if (_drainTimeout && typeof _drainTimeout.unref === 'function') {
      _drainTimeout.unref();
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
   * @param {string} reason  — 'signal_usr1' | 'signal_usr2'
   * @param {object} [detail] — optional extra fields for the log event
   * @param {number} [timeoutMs] — bound for this entry; defaults to drainTimeoutMs
   */
  function enterDrain(reason, detail, timeoutMs) {
    var bound = timeoutMs > 0 ? timeoutMs : drainTimeoutMs;
    if (_isDraining) {
      // A shorter bound from a later entry (SIGTERM during an operator drain)
      // wins, so the stop timeout is never outlived; otherwise a no-op.
      if (!_exitCalled && _drainTimeout && Date.now() + bound < _drainDeadline) {
        _armTimeout(bound);
      }
      return;
    }
    _isDraining = true;
    _drainReason = reason;

    var activeCount = getActiveCount();
    var logEvent = Object.assign({
      event: 'drain_enter',
      reason: reason,
      activeCount: activeCount,
      drainTimeoutMs: bound,
      timestamp: new Date().toISOString(),
    }, detail || {});
    _emitLog(logEvent);

    // If no sessions are currently active, exit immediately.
    if (activeCount <= 0) {
      _callExit('active_count_zero');
      return;
    }

    // Arm the timeout guard so a stuck session cannot hold the daemon up forever.
    _armTimeout(bound);

    // Poll the live-query count every second so we exit as soon as sessions finish.
    _drainPollHandle = setInterval(_checkActiveCount, DRAIN_POLL_INTERVAL_MS);
    if (_drainPollHandle && typeof _drainPollHandle.unref === 'function') {
      _drainPollHandle.unref();
    }
  }

  /**
   * Enter drain for SIGTERM/SIGINT with the short stop-timeout-safe bound.
   * Idempotent; a second signal never extends the bound.
   *
   * @param {string} reason — 'signal_term' | 'signal_int'
   */
  function enterTermDrain(reason) {
    enterDrain(reason, undefined, sigtermTimeoutMs);
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

  function _setPressure(next, event, detail) {
    if (_underPressure === next) return;
    _underPressure = next;
    _emitLog(Object.assign({
      event: event,
      activeCount: getActiveCount(),
      timestamp: new Date().toISOString(),
    }, detail || {}));
    if (onPressureChange) {
      try { onPressureChange(next, detail || {}); } catch (_) {}
    }
  }

  /**
   * Called by the MemoryHigh watcher's onCrossing callback. Starts refusing
   * new work; never exits the daemon. Idempotent.
   *
   * @param {object} [detail] — fields from the watermark event (source, currentBytes, etc.)
   */
  function onMemoryHighCrossing(detail) {
    _setPressure(true, 'pressure_enter', detail);
  }

  /**
   * Called by the MemoryHigh watcher's onRecovery callback. Resumes accepting
   * new work. Idempotent.
   *
   * @param {object} [detail]
   */
  function onMemoryHighRecovery(detail) {
    _setPressure(false, 'pressure_exit', detail);
  }

  /**
   * True while the soft memory limit is exceeded.
   *
   * @returns {boolean}
   */
  function isUnderPressure() {
    return _underPressure;
  }

  /**
   * True when new sessions and new agent work must be refused: under memory
   * pressure, or draining for an operator-requested restart.
   *
   * @returns {boolean}
   */
  function isRefusingNewWork() {
    return _underPressure || _isDraining;
  }

  return {
    isDraining: isDraining,
    isUnderPressure: isUnderPressure,
    isRefusingNewWork: isRefusingNewWork,
    enterDrain: enterDrain,
    enterTermDrain: enterTermDrain,
    registerSignals: registerSignals,
    onMemoryHighCrossing: onMemoryHighCrossing,
    onMemoryHighRecovery: onMemoryHighRecovery,
    // Exposed for testing only.
    _DEFAULT_DRAIN_TIMEOUT_MS: DEFAULT_DRAIN_TIMEOUT_MS,
    _DRAIN_POLL_INTERVAL_MS: DRAIN_POLL_INTERVAL_MS,
  };
}

module.exports = {
  createDrain: createDrain,
  DEFAULT_DRAIN_TIMEOUT_MS: DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_SIGTERM_DRAIN_TIMEOUT_MS: DEFAULT_SIGTERM_DRAIN_TIMEOUT_MS,
  MAX_SIGTERM_DRAIN_TIMEOUT_MS: MAX_SIGTERM_DRAIN_TIMEOUT_MS,
};
