"use strict";

// The identity record a session carries: which provider vouched for it and at
// what grade. Read back from a session file, so it is rebuilt from known values
// only, whatever the file holds.

var contract = require("./contract");
var CODE_PATTERN = require("./unavailable").CODE_PATTERN;

function sanitizeRecord(value) {
  if (!value || typeof value !== "object") return null;
  var provider = value.provider;
  if (typeof provider !== "string" || !contract.NAME_PATTERN.test(provider)) return null;
  var record = {
    provider: provider,
    grade: contract.GRADES.indexOf(value.grade) === -1 ? null : value.grade,
    origin: contract.ORIGINS.indexOf(value.origin) === -1 ? null : value.origin,
  };
  if (typeof value.unavailable === "string" && CODE_PATTERN.test(value.unavailable)) record.unavailable = value.unavailable;
  return record;
}

module.exports = { sanitizeRecord: sanitizeRecord };
