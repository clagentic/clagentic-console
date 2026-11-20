// context-1m-beta.js — the 1M-token context beta flag, in one place.
//
// The SDK's model list reports no beta identifier and no context-window or
// beta-support field, so nothing the client receives names the flag. The dated
// identifier below is therefore a FALLBACK ONLY: it is what the toggles send
// when they switch the beta on, until a vendor field can supply it. Both
// toggles (the session popover in app-panels.js and the Settings pages in
// settings-defaults.js) import it from here; no other copy of the literal may
// exist. Once the beta is generally available the header is a no-op and this
// constant can be removed with its callers.
export var CONTEXT_1M_BETA_FALLBACK = "context-1m-2025-08-07";

// Matched by substring, not equality, so a revised identifier the vendor or an
// operator set (a different date) still counts as "on" and is removed on "off".
var CONTEXT_1M_MARKER = "context-1m";

export function hasContext1m(betas) {
  var list = betas || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].indexOf(CONTEXT_1M_MARKER) !== -1) return true;
  }
  return false;
}

// The beta list after the 1M toggle is switched on or off: every other beta is
// kept; the 1M flag is added once (as the fallback identifier) or all of its
// forms are removed.
export function withContext1m(betas, on) {
  var list = betas || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].indexOf(CONTEXT_1M_MARKER) === -1) out.push(list[i]);
  }
  if (on) out.push(CONTEXT_1M_BETA_FALLBACK);
  return out;
}
