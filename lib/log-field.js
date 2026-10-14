"use strict";

// One value for a key=value log line. Session titles, tool names, user ids and
// project slugs can come from outside the daemon, so nothing that could end a
// line or split a field survives: every character outside a small allowlist
// becomes "_", and the value is cut to maxLen. Never pass prompt text through
// here: the answer to "may this be logged?" is decided by the caller, this
// only keeps a permitted value on one line.

var DISALLOWED = /[^A-Za-z0-9._:@\/+-]/g;

function logField(value, maxLen) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).replace(DISALLOWED, "_").slice(0, maxLen || 64);
}

// Free text that has to be readable (a refusal reason), for the END of a line:
// control characters, which could end the line or forge another, become a
// space, and the text is cut to maxLen.
function logText(value, maxLen) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f  ]+/g, " ")
    .slice(0, maxLen || 200);
}

module.exports = { logField: logField, logText: logText };
