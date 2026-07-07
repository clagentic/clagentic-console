// diagnostics-dismiss-clear-all-parity.test.js
//
// Diagnostics panel dismiss / clear-all parity with the Notifications panel
// (app-notifications.js dismissNotif / clearAllBanners). The Diagnostics
// panel previously only ever grew — settings.json preflight warnings piled
// up permanently across sessions with no way to clear them.
//
// diagnostics.js is an ESM module with DOM + icons.js dependencies that this
// project's test runner does not exercise via a DOM harness (see the
// existing diagnostics-panel-pointer-events-lr-b580.test.js /
// diagnostics-toast-dedup-placement-lr-e901.test.js convention) — these are
// source-text regression checks matching that same convention.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var DIAGNOSTICS_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/diagnostics.js"),
  "utf8"
);
var DIAGNOSTICS_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/diagnostics.css"),
  "utf8"
);
var INDEX_HTML = fs.readFileSync(
  path.join(__dirname, "../lib/public/index.html"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Stable identity
// ---------------------------------------------------------------------------

test("diagnostics.js: each entry gets a stable id at creation", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function addDiagnostic");
  assert.ok(idx !== -1, "expected addDiagnostic to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 700);

  assert.match(
    block,
    /id:\s*_nextDiagnosticId\+\+/,
    "addDiagnostic must stamp each entry with a stable, incrementing id so a specific rendered item can be located and removed on dismiss"
  );
});

test("diagnostics.js: rendered items carry the entry id in the DOM", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _appendEntry");
  assert.ok(idx !== -1, "expected _appendEntry to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 700);

  assert.match(
    block,
    /setAttribute\(\s*["']data-diag-id["']\s*,\s*String\(entry\.id\)\s*\)/,
    "_appendEntry must stamp data-diag-id on the rendered item so dismissDiagnostic() can locate the matching DOM node"
  );
});

// ---------------------------------------------------------------------------
// Per-entry dismiss
// ---------------------------------------------------------------------------

test("diagnostics.js: each item renders a dismiss control wired to dismissDiagnostic", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _appendEntry");
  assert.ok(idx !== -1, "expected _appendEntry to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 1200);

  assert.match(
    block,
    /diagnostics-item-dismiss/,
    "each rendered .diagnostics-item must include a .diagnostics-item-dismiss control"
  );
  assert.match(
    block,
    /dismissDiagnostic\(\s*entry\.id\s*\)/,
    "the per-item dismiss control must call dismissDiagnostic(entry.id)"
  );
  assert.match(
    block,
    /setAttribute\(\s*["']aria-label["']/,
    "the dismiss control must carry an aria-label for accessibility parity with the Notifications panel"
  );
});

test("diagnostics.js: dismissDiagnostic removes the entry from the array and the DOM, then updates the badge", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function dismissDiagnostic");
  assert.ok(idx !== -1, "expected dismissDiagnostic to be defined");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 700);

  assert.match(block, /diagnostics\.splice\(/, "dismissDiagnostic must remove the matching entry from the diagnostics array");
  assert.match(block, /data-diag-id/, "dismissDiagnostic must locate the DOM node via data-diag-id");
  assert.match(block, /removeChild\(/, "dismissDiagnostic must remove the DOM node, not just hide it");
  assert.match(block, /_updateBadge\s*\(\s*\)/, "dismissDiagnostic must refresh the badge after removal");
});

test("diagnostics.js: dismissDiagnostic restores the empty-state placeholder once the list is empty", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function dismissDiagnostic");
  assert.ok(idx !== -1, "expected dismissDiagnostic to be defined");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 700);

  assert.match(
    block,
    /diagnostics\.length === 0/,
    "dismissDiagnostic must check whether the array is now empty"
  );
  assert.match(
    block,
    /_restoreEmptyPlaceholder\s*\(\s*\)/,
    "dismissDiagnostic must restore the .diagnostics-empty placeholder when the last entry is dismissed"
  );
});

// ---------------------------------------------------------------------------
// Clear-all
// ---------------------------------------------------------------------------

test("index.html: diagnostics panel header includes a Clear all control alongside the close button", () => {
  var idx = INDEX_HTML.indexOf('id="diagnostics-panel"');
  assert.ok(idx !== -1, "expected #diagnostics-panel to exist in index.html");
  var block = INDEX_HTML.slice(idx, idx + 600);

  assert.match(
    block,
    /diagnostics-panel-clear-all/,
    "the diagnostics panel header must include a .diagnostics-panel-clear-all control (parity with the Notifications panel's clear-all)"
  );
  assert.match(
    block,
    /diagnostics-panel-clear-all[^>]*aria-label=/,
    "the clear-all control must carry an aria-label"
  );
});

test("diagnostics.js: initDiagnostics wires the clear-all button to clearAllDiagnostics", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function initDiagnostics");
  assert.ok(idx !== -1, "expected initDiagnostics to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 2500);

  assert.match(
    block,
    /clearAllBtn/,
    "initDiagnostics must look up the clear-all button"
  );
  assert.match(
    block,
    /clearAllDiagnostics\s*\(\s*\)/,
    "the clear-all button's click handler must call clearAllDiagnostics()"
  );
});

test("diagnostics.js: clearAllDiagnostics empties the array and list, and restores the empty state", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function clearAllDiagnostics");
  assert.ok(idx !== -1, "expected clearAllDiagnostics to be defined");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 500);

  assert.match(block, /diagnostics\s*=\s*\[\]/, "clearAllDiagnostics must empty the diagnostics array");
  assert.match(block, /panelListEl\.innerHTML\s*=\s*["']["']/, "clearAllDiagnostics must clear the rendered list");
  assert.match(block, /_restoreEmptyPlaceholder\s*\(\s*\)/, "clearAllDiagnostics must restore the empty-state placeholder");
  assert.match(block, /_updateBadge\s*\(\s*\)/, "clearAllDiagnostics must refresh the badge (hides it since count is now 0)");
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

// ---------------------------------------------------------------------------
// Badge / dedup preserved (do NOT modify contract)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

test("diagnostics.css: .diagnostics-item-dismiss and .diagnostics-panel-clear-all are styled", () => {
  assert.match(DIAGNOSTICS_CSS, /\.diagnostics-item-dismiss\s*\{/, "expected .diagnostics-item-dismiss rule to exist");
  assert.match(DIAGNOSTICS_CSS, /\.diagnostics-panel-clear-all\s*\{/, "expected .diagnostics-panel-clear-all rule to exist");
});
