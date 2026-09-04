// memory-setting-validate.js — shared range validation for the memory-guard
// config keys (lr-553d27).
//
// Extracted so the web/WS path (lib/daemon.js's onSetMemAvailableThreshold /
// onSetTokensPerMbHeadroom) and the raw IPC socket path (lib/daemon.js's
// set_mem_available_threshold / set_tokens_per_mb_headroom cases) validate
// against ONE contract instead of two independently-maintained copies. The
// divergence between those two copies is what let the raw IPC path silently
// clamp an out-of-range value to the default and report ok:true (the web
// path was fixed for this under lr-93e3c8; the raw IPC path was not) — see
// lr-553d27.
//
// Both functions return { ok: true, value } on success or
// { ok: false, error } on rejection; the error message always names the
// valid band so a caller (including the raw-socket escape-hatch documented
// to operators) can tell exactly what would be accepted.
//
// coerceCleanInteger (lr-553d27 fold-in, BOBBIE PR #417 coercion review):
// parseInt() alone accepts a PREFIX of its input -- parseInt("300abc", 10)
// is 300, not NaN -- so a caller sending {"value":"300abc"} over the raw IPC
// socket would have received ok:true with 300 silently persisted, a
// DIFFERENT value than the one it sent. That is the exact
// "control path reports success while silently substituting a different
// value" contract violation this task exists to close, one level down from
// the out-of-range case. A real number (already a clean integer/float, no
// parsing needed) or a numeric STRING that is a whole number with no trailing
// garbage is accepted; anything else (a non-numeric prefix, a decimal
// fraction, or a completely non-numeric value) is rejected. A caller passing
// a clean numeric string over a JSON socket (e.g. "1000") remains a
// legitimate, accepted case.
function coerceCleanInteger(rawValue) {
  if (typeof rawValue === "number") {
    return Number.isInteger(rawValue) ? rawValue : NaN;
  }
  if (typeof rawValue === "string" && /^-?\d+$/.test(rawValue.trim())) {
    return parseInt(rawValue, 10);
  }
  return NaN;
}

function validateMemAvailableThresholdMB(rawValue) {
  var val = coerceCleanInteger(rawValue);
  if (isNaN(val) || val < 0) {
    return { ok: false, error: "Value must be a number >= 0" };
  }
  return { ok: true, value: val };
}

function validateTokensPerMbHeadroom(rawValue) {
  var val = coerceCleanInteger(rawValue);
  if (isNaN(val) || val < 10 || val > 500) {
    return { ok: false, error: "Value must be 10-500" };
  }
  return { ok: true, value: val };
}

module.exports = {
  validateMemAvailableThresholdMB: validateMemAvailableThresholdMB,
  validateTokensPerMbHeadroom: validateTokensPerMbHeadroom,
};
