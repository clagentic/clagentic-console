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

function validateMemAvailableThresholdMB(rawValue) {
  var val = parseInt(rawValue, 10);
  if (isNaN(val) || val < 0) {
    return { ok: false, error: "Value must be a number >= 0" };
  }
  return { ok: true, value: val };
}

function validateTokensPerMbHeadroom(rawValue) {
  var val = parseInt(rawValue, 10);
  if (isNaN(val) || val < 10 || val > 500) {
    return { ok: false, error: "Value must be 10-500" };
  }
  return { ok: true, value: val };
}

module.exports = {
  validateMemAvailableThresholdMB: validateMemAvailableThresholdMB,
  validateTokensPerMbHeadroom: validateTokensPerMbHeadroom,
};
