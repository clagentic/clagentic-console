"use strict";

// The registry-wide bound on an unanswered operator prompt: daemon.json
// `promptExpiryMinutes`. Read at each open(), so an edit applies to the next
// prompt; a prompt already open keeps the deadline it was given.
//
//   absent            -> 30 minutes
//   0                 -> no expiry
//   positive number   -> that many minutes
//   anything else     -> the default, with one warning naming the key
//
// Malformed means: not a number, negative, not finite, or beyond what a timer
// can hold (a larger value would make setTimeout fire at once).
// An administrator sets it in Settings (lib/prompt-expiry-settings.js).

var KEY = "promptExpiryMinutes";
var DEFAULT_MINUTES = 30;
var MAX_TIMER_MS = 2147483647;
// The largest whole number of minutes a timer can hold.
var MAX_MINUTES = Math.floor(MAX_TIMER_MS / 60000);

/**
 * @param {?object} cfg - the daemon configuration.
 * @returns {number} the configured minutes (0 = no expiry), or the default when
 *   the key is absent or malformed. Never warns: it is for showing the setting.
 */
function readExpiryMinutes(cfg) {
  var v = cfg ? cfg[KEY] : undefined;
  if (typeof v !== "number" || !isFinite(v) || v < 0) return DEFAULT_MINUTES;
  if (v === 0) return 0;
  return Math.max(1, Math.round(v * 60000)) > MAX_TIMER_MS ? DEFAULT_MINUTES : v;
}

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

module.exports = {
  createExpiryReader: createExpiryReader,
  readExpiryMinutes: readExpiryMinutes,
  KEY: KEY,
  DEFAULT_MINUTES: DEFAULT_MINUTES,
  MAX_MINUTES: MAX_MINUTES,
};
