"use strict";

// The typed result of a provider that cannot supply an identity. A session that
// receives it starts without one: nothing is fabricated in its place.
//
//   code    a short stable identifier (lower-case letters, digits, underscore)
//   reason  one sentence for the person running the console, no secrets and no
//           host paths
//   quiet   true when the absence is expected rather than a fault (a runtime the
//           surface does not cover), so no notice is shown for it

var CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function unavailable(code, reason, options) {
  return {
    unavailable: true,
    code: CODE_PATTERN.test(code) ? code : "provider_error",
    reason: typeof reason === "string" && reason ? reason.slice(0, 200) : "the identity provider could not supply an identity",
    quiet: !!(options && options.quiet),
  };
}

function isUnavailable(value) {
  return !!value && typeof value === "object" && value.unavailable === true;
}

module.exports = { unavailable: unavailable, isUnavailable: isUnavailable, CODE_PATTERN: CODE_PATTERN };
