"use strict";

// Everything that must be written before the process ends, behind ONE
// process "exit" listener however many callers register.
//
// Each project's session manager used to add its own listener, so a daemon with
// fifty projects added fifty to `process` at startup and tripped Node's
// MaxListenersExceededWarning (the default cap is 10; the daemon raises it, and
// raising it again would only move the line). The listener is installed when
// the first flusher registers and removed when the last one unregisters, so a
// daemon that opens and closes projects does not accumulate any.

var flushers = new Set();
var installed = false;

function flushAll() {
  flushers.forEach(function (flush) {
    // One flusher failing must not stop the others: this is the last chance
    // any of them gets to write.
    try { flush(); }
    catch (e) { console.error("[exit-flush] flush failed:", e && e.message ? e.message : e); }
  });
}

/**
 * @param {function(): void} flush - runs synchronously when the process exits.
 * @returns {function(): void} unregister; safe to call more than once.
 */
function registerExitFlush(flush) {
  flushers.add(flush);
  if (!installed) {
    process.on("exit", flushAll);
    installed = true;
  }
  return function unregister() {
    flushers.delete(flush);
    if (installed && flushers.size === 0) {
      process.removeListener("exit", flushAll);
      installed = false;
    }
  };
}

module.exports = { registerExitFlush: registerExitFlush };
