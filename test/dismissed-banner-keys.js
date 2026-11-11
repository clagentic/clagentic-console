"use strict";
// Test helper: groups the raw banner keys a notification stub was asked to
// dismiss by banner type. A key is "n:<type>:<target key>", the target key
// ending in the request id. Nothing is deduplicated: an id dismissed twice
// for one type must show up twice, since that is the regression to catch.

function idsByType(keys) {
  var out = {};
  keys.forEach(function (key) {
    var parts = key.split(":");
    var type = parts[1];
    (out[type] = out[type] || []).push(parts[parts.length - 1]);
  });
  return out;
}

// The banner types a prompt registers: every request id is dismissed once under
// each of them.
var BANNER_TYPES = ["permission_request", "ask_user", "elicitation"];

// The exact expectation when every banner type dismisses the same ids.
function sameIdsForEveryType(ids) {
  var out = {};
  BANNER_TYPES.forEach(function (type) { out[type] = ids.slice(); });
  return out;
}

module.exports = { idsByType: idsByType, BANNER_TYPES: BANNER_TYPES, sameIdsForEveryType: sameIdsForEveryType };
