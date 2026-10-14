"use strict";

// One value for a key=value log line. Session titles, tool names, user ids and
// project slugs can come from outside the daemon, so nothing that could end a
// line or split a field survives: every character outside a small allowlist
// becomes "_", and the value is cut to maxLen. Never pass prompt text through
// here: the answer to "may this be logged?" is decided by the caller, this
// only keeps a permitted value on one line.

var DISALLOWED = /[^A-Za-z0-9._:@\/+-]/g;

// Control characters plus the Unicode line and paragraph separators. Built from
// char codes so the pattern never holds a raw line-terminator character.
var LINE_BREAKERS = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) +
    String.fromCharCode(0x7f) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]+",
  "g"
);

function logField(value, maxLen) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).replace(DISALLOWED, "_").slice(0, maxLen || 64);
}

// Free text that has to be readable (a refusal reason), for the END of a line:
// anything that could end the line or forge another becomes a space, and the
// text is cut to maxLen.
function logText(value, maxLen) {
  return String(value === undefined || value === null ? "" : value)
    .replace(LINE_BREAKERS, " ")
    .slice(0, maxLen || 200);
}

module.exports = { logField: logField, logText: logText };
