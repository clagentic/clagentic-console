// diagnostics-preflight-scope-label-lr-7e22.test.js — lr-7e22 regression coverage.
//
// Root cause (lr-5db5 investigation, split into lr-7e22): runPreflight()
// (lib/settings-preflight.js) validates BOTH ~/.claude/settings.json and
// <projectDir>/.claude/settings.json independently, emitting one warning
// diagnostic per unknown hook key per file. These are correct, distinct
// diagnostics, but formatDiagnosticSource('preflight') rendered the identical
// label "Preflight" for every one, so two-or-more legitimate warnings visually
// stacked as apparent duplicates in the fixed-position toast slot.
//
// Fix: settings-preflight.js now attaches scope:'user'|'project' to each
// diagnostic (based on which settings file produced it). diagnostics.js reads
// entry.scope and passes it through to formatDiagnosticSource(source, scope)
// at both render sites (toast header + panel row), producing distinguishable
// labels like "Preflight · user" vs "Preflight · project".
//
// These are source-text regression checks (no DOM harness required), matching
// the project's existing diagnostics-panel-pointer-events-lr-b580.test.js
// convention for modules that only do DOM work inside functions.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var DIAGNOSTICS_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/diagnostics.js"),
  "utf8"
);

test("diagnostics.js: addDiagnostic reads msg.scope onto the entry", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function addDiagnostic");
  assert.ok(idx !== -1, "expected addDiagnostic to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 400);

  assert.match(
    block,
    /scope:\s*msg\.scope\s*\|\|\s*["']["']/,
    "addDiagnostic must carry msg.scope onto the internal entry so the render sites can distinguish user vs project preflight diagnostics"
  );
});

test("diagnostics.js: toast header passes entry.scope into _formatSource", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _showDiagnosticToast");
  assert.ok(idx !== -1, "expected _showDiagnosticToast to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 1200);

  assert.match(
    block,
    /_formatSource\(entry\.source,\s*entry\.scope\)/,
    "toast header must pass entry.scope to _formatSource so multiple legitimate preflight warnings across settings files render distinguishable source labels (lr-7e22)"
  );
});

test("diagnostics.js: panel row passes entry.scope into _formatSource", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _appendEntry");
  assert.ok(idx !== -1, "expected _appendEntry to exist");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 1200);

  assert.match(
    block,
    /_formatSource\(entry\.source,\s*entry\.scope\)/,
    "panel row must pass entry.scope to _formatSource, matching the toast header so both surfaces agree on the distinguishable label (lr-7e22)"
  );
});
