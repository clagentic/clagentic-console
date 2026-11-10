"use strict";

// The registry-wide bound on an unanswered operator prompt: daemon.json
// `promptExpiryMinutes`. Read at each open(), so an edit applies to the next
// prompt; a prompt already open keeps the deadline it was given.
//
//   absent            -> 1440 (24 hours)
//   0                 -> no expiry
//   positive number   -> that many minutes
//   anything else     -> the default, with one warning naming the key
//
// Malformed means: not a number, negative, not finite, or beyond what a timer
// can hold (a larger value would make setTimeout fire at once).

var KEY = "promptExpiryMinutes";
var DEFAULT_MINUTES = 1440;
var MAX_TIMER_MS = 2147483647;

/**
 * @returns {function(?object): number} (daemon config) -> expiry in ms, 0 for
 *   none. One reader per registry: it warns once per malformed value.
 */
function createExpiryReader() {
  var warned = Object.create(null);

  function warnOnce(value) {
    var id = typeof value + ":" + String(value);
    if (warned[id]) return;
    warned[id] = true;
    console.warn("[prompt-registry] " + KEY + " must be 0 (no expiry) or a positive number of minutes; using the default of " + DEFAULT_MINUTES);
  }

  return function expiryMs(cfg) {
    var v = cfg ? cfg[KEY] : undefined;
    if (v === undefined || v === null) return DEFAULT_MINUTES * 60000;
    if (typeof v !== "number" || !isFinite(v) || v < 0) {
      warnOnce(v);
      return DEFAULT_MINUTES * 60000;
    }
    if (v === 0) return 0;
    var ms = Math.max(1, Math.round(v * 60000));
    if (ms > MAX_TIMER_MS) {
      warnOnce(v);
      return DEFAULT_MINUTES * 60000;
    }
    return ms;
  };
}

module.exports = { createExpiryReader: createExpiryReader, KEY: KEY, DEFAULT_MINUTES: DEFAULT_MINUTES };
