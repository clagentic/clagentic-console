// diagnostics-toast-dedup-placement-lr-e901.test.js — lr-e901 regression coverage.
//
// Two of the three lr-e901 defects live in lib/public/modules/diagnostics.js
// and lib/public/css/diagnostics.css:
//
//   (2) doubling — addDiagnostic() pushed + toasted every entry unconditionally,
//       so the same underlying condition arriving via two independent emitters
//       (CLI-stderr capture + deterministic settings-preflight runPreflight())
//       produced two toasts. Fix: dedup keyed on (source, scope, message)
//       within a short time window before pushing/toasting.
//
//   (3) placement/stacking — .toast-diagnostic was position:fixed center-bottom,
//       directly over the composer/input box, with no stacking offset for
//       concurrent toasts. Fix: re-anchor to a fixed top-right corner stack
//       (#diagnostic-toast-container), following the existing corner-anchored,
//       flex-column-stacked precedent already used by .notif-banner-container
//       (notifications-center.css) — normal flow + gap handles stacking with
//       no per-toast JS offset math. Mobile keeps the lr-2fdd top-anchor
//       behavior, widened to full-width.
//
// diagnostics.js is an ESM module with DOM + icons.js dependencies that this
// project's test runner does not exercise via a DOM harness (see the existing
// diagnostics-panel-pointer-events-lr-b580.test.js convention) — these are
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

// ---------------------------------------------------------------------------
// Defect 2 — doubling / dedup
// ---------------------------------------------------------------------------

test("diagnostics.js: addDiagnostic checks for a duplicate before pushing/toasting", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function addDiagnostic");
  assert.ok(idx !== -1, "expected addDiagnostic to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 400);

  assert.match(
    block,
    /_isDuplicateDiagnostic\s*\(/,
    "addDiagnostic must consult a duplicate check before recording a new entry (lr-e901 doubling defect)"
  );
  assert.match(
    block,
    /return;/,
    "addDiagnostic must bail out early (return) when a duplicate is detected, skipping both the panel push and the toast"
  );
});

test("diagnostics.js: dedup identity includes source, scope, and message", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _diagnosticKey");
  assert.ok(idx !== -1, "expected a _diagnosticKey helper to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 300);

  assert.match(block, /msg\.source/, "dedup key must include source");
  assert.match(block, /msg\.scope/,
    "dedup key must include scope -- runPreflight() intentionally emits one diagnostic " +
    "per settings file (user vs project, lr-7e22); those are distinct conditions and " +
    "must NOT be collapsed together by dedup"
  );
  assert.match(block, /msg\.message/, "dedup key must include message");
});

test("diagnostics.js: dedup uses a bounded time window, not a permanent block", () => {
  assert.match(
    DIAGNOSTICS_JS,
    /DEDUP_WINDOW_MS/,
    "expected a DEDUP_WINDOW_MS constant so identical diagnostics are only " +
    "collapsed within a short window (not permanently blocked for the rest of the session)"
  );
});

// ---------------------------------------------------------------------------
// Defect 3 — placement / stacking
// ---------------------------------------------------------------------------

test("diagnostics.css: #diagnostic-toast-container is a fixed, corner-anchored, gap-stacked container", () => {
  var idx = DIAGNOSTICS_CSS.indexOf("#diagnostic-toast-container {");
  assert.ok(idx !== -1, "expected #diagnostic-toast-container rule to exist");
  var block = DIAGNOSTICS_CSS.slice(idx, idx + 400);

  assert.match(block, /position:\s*fixed/, "container must be position:fixed");
  assert.match(block, /display:\s*flex/, "container must use flex layout for stacking");
  assert.match(block, /flex-direction:\s*column/, "container must stack children in a column");
  assert.match(block, /gap:/, "container must define a gap so stacked toasts do not touch/overlap");

  // Off the input box: must NOT be center-bottom (the lr-e901 root cause).
  assert.ok(block.indexOf("left: 50%") === -1,
    "container must not be center-anchored (left:50%) -- that was the lr-e901 placement defect, directly over the composer/input box");
});

test("diagnostics.css: .toast-diagnostic no longer self-positions with position:fixed", () => {
  var idx = DIAGNOSTICS_CSS.indexOf(".toast-diagnostic {");
  assert.ok(idx !== -1, "expected .toast-diagnostic rule to exist");
  var block = DIAGNOSTICS_CSS.slice(idx, idx + 400);

  assert.ok(block.indexOf("position: fixed") === -1,
    "individual toasts must not be position:fixed anymore -- positioning now comes from the parent #diagnostic-toast-container so multiple concurrent toasts stack instead of overlapping at the same fixed spot");
});

test("diagnostics.js: toasts are appended into the shared toast container, not document.body directly", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _showDiagnosticToast");
  assert.ok(idx !== -1, "expected _showDiagnosticToast to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 2000);

  assert.match(
    block,
    /_getToastContainer\(\)\.appendChild\(el\)/,
    "_showDiagnosticToast must append into the shared stacking container, not document.body directly (lr-e901 placement/stacking defect)"
  );
});

test("diagnostics.css: mobile media query keeps top-anchor behavior on the container (lr-2fdd intact)", () => {
  var idx = DIAGNOSTICS_CSS.indexOf("@media (max-width: 768px)");
  assert.ok(idx !== -1, "expected a mobile media query to exist");
  var block = DIAGNOSTICS_CSS.slice(idx, idx + 900);

  assert.match(
    block,
    /#diagnostic-toast-container\s*\{[^}]*top:\s*calc\(var\(--safe-top\)/,
    "mobile must keep the lr-2fdd top-anchor fix (clearing the notch/status bar via --safe-top) on the container"
  );
});
