"use strict";
// Shared rows for the prompt expiry tests: every promptExpiryMinutes value that
// is present but unusable, and so reads as the default. One table, so the
// reader's and the setting's tests cannot drift apart.

var MALFORMED_MINUTES = [-5, "10", NaN, Infinity, true, {}, 1e9];

module.exports = { MALFORMED_MINUTES: MALFORMED_MINUTES };
