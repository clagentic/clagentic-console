// diagnostics-dismiss-clear-all-parity.test.js
//
// Diagnostics dismiss / clear-all. The panel itself, its dismiss and clear-all
// controls and its empty state are the shared list panel; their behaviour is
// driven through the real modules in list-panel.test.js. What stays here are the
// source-text checks on the contracts that module keeps (stable ids, no server
// round-trip, the badge, the dedup).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var DIAGNOSTICS_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/diagnostics.js"),
  "utf8"
);

test("diagnostics.js: each entry gets a stable id at creation", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function addDiagnostic");
  assert.ok(idx !== -1, "expected addDiagnostic to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 700);

  assert.match(
    block,
    /id:\s*_nextDiagnosticId\+\+/,
    "addDiagnostic must stamp each entry with a stable, incrementing id so the panel keeps a row per entry and dismiss can find it"
  );
});

test("diagnostics.js: clear-all does not send any websocket message (client-side only, no server dismiss contract)", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function clearAllDiagnostics");
  assert.ok(idx !== -1, "expected clearAllDiagnostics to be defined");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 500);

  assert.ok(
    block.indexOf("ws.send") === -1 && block.indexOf("getWs") === -1,
    "clearAllDiagnostics must be purely client-side state — diagnostics have no backend dismiss message type, unlike notifications' notification_dismiss_all"
  );
});

test("diagnostics.js: _updateBadge still hides the badge at zero count (reused unmodified)", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _updateBadge");
  assert.ok(idx !== -1, "expected _updateBadge to be defined");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 300);

  assert.match(block, /count === 0/, "_updateBadge must still check for zero count");
  assert.match(block, /classList\.add\(\s*["']hidden["']\s*\)/, "_updateBadge must still hide the badge at zero");
});

test("diagnostics.js: addDiagnostic dedup logic is untouched (still consults _isDuplicateDiagnostic and returns early)", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function addDiagnostic");
  assert.ok(idx !== -1, "expected addDiagnostic to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 400);

  assert.match(block, /_isDuplicateDiagnostic\s*\(/, "addDiagnostic must still consult the dedup check (lr-e901 contract)");
  assert.match(block, /return;/, "addDiagnostic must still bail out early on a duplicate");
});
