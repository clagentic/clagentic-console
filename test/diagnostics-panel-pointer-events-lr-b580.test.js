// diagnostics-panel-pointer-events-lr-b580.test.js — lr-b580 regression coverage.
//
// Root cause: #diagnostics-panel lives inside #info-panels
// (lib/public/css/menus.css), which is `position: fixed; pointer-events: none`
// so it can span the viewport without blocking clicks on the app underneath.
// Sibling panels (#usage-panel, #status-panel, #context-panel, #team-panel)
// opt back into `pointer-events: auto` on their own bounds via a shared
// selector. lr-8294 added #diagnostics-panel to the DOM/CSS file but never
// added it to that selector, so the panel inherited `pointer-events: none`
// from its parent -- the panel itself (including its own X button) became
// unclickable, while clicks elsewhere in the app still worked (the panel was
// inert, not a click-trapping backdrop).
//
// Fix: add #diagnostics-panel to the shared pointer-events:auto selector, and
// add a click-outside-to-dismiss handler in diagnostics.js (the panel has no
// backdrop element, so dismissal is done via a document click listener that
// mirrors the existing configPopover outside-click pattern in
// app-panels.js), reusing the shared closePanelAndRefocus() helper so
// Escape-close+refocus stays consistent with all dismiss paths.
//
// These are source-text regression checks (no DOM harness required), matching
// the project's existing xss-escape.test.js / server-settings-mobile-parity
// convention for modules that only do DOM work inside functions.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var MENUS_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/menus.css"),
  "utf8"
);
var DIAGNOSTICS_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/diagnostics.js"),
  "utf8"
);

test("menus.css: #diagnostics-panel is included in the shared pointer-events:auto selector", () => {
  // Isolate the selector block that follows the "Usage panel" comment so this
  // assertion is scoped to the regression site.
  var idx = MENUS_CSS.indexOf("/* --- Usage panel --- */");
  assert.ok(idx !== -1, 'expected "/* --- Usage panel --- */" comment block to exist in menus.css');
  var block = MENUS_CSS.slice(idx, idx + 400);

  assert.match(
    block,
    /#usage-panel,\s*#status-panel,\s*#context-panel,\s*#team-panel,\s*#diagnostics-panel\s*\{[^}]*pointer-events:\s*auto/,
    "#diagnostics-panel must share the pointer-events:auto rule with its sibling panels -- without it, the panel inherits pointer-events:none from #info-panels and becomes fully unclickable (lr-b580 root cause)"
  );
});

test("menus.css: #diagnostics-panel.hidden is included in the shared display:none selector", () => {
  assert.match(
    MENUS_CSS,
    /#usage-panel\.hidden,\s*#status-panel\.hidden,\s*#context-panel\.hidden,\s*#team-panel\.hidden,\s*#diagnostics-panel\.hidden\s*\{\s*display:\s*none;\s*\}/,
    "#diagnostics-panel.hidden must be listed alongside its sibling panels for consistency with the shared panel pattern"
  );
});

test("diagnostics.js: initDiagnostics wires a click-outside-to-dismiss handler", () => {
  var idx = DIAGNOSTICS_JS.indexOf("export function initDiagnostics");
  assert.ok(idx !== -1, "expected initDiagnostics to be exported");
  var block = DIAGNOSTICS_JS.slice(idx, idx + 2000);

  assert.match(
    block,
    /document\.addEventListener\(\s*["']click["']/,
    "initDiagnostics must register a document-level click listener so the panel is dismissable by clicking outside it (lr-b580: the panel has no backdrop element to bind to)"
  );
});

test("diagnostics.js: the click-outside handler reuses closePanelAndRefocus (not a bare closePanel call)", () => {
  var docClickIdx = DIAGNOSTICS_JS.indexOf('document.addEventListener("click"');
  assert.ok(docClickIdx !== -1, 'expected document.addEventListener("click", ...) to exist');
  var block = DIAGNOSTICS_JS.slice(docClickIdx, docClickIdx + 400);

  assert.match(
    block,
    /closePanelAndRefocus\s*\(\s*\)/,
    "click-outside dismissal must go through closePanelAndRefocus() so focus is restored to the topbar toggle button, consistent with the Escape-key and close-button dismiss paths"
  );
});

test("diagnostics.js: click-outside handler ignores clicks on the panel itself and its toggle button", () => {
  var docClickIdx = DIAGNOSTICS_JS.indexOf('document.addEventListener("click"');
  assert.ok(docClickIdx !== -1, 'expected document.addEventListener("click", ...) to exist');
  var block = DIAGNOSTICS_JS.slice(docClickIdx, docClickIdx + 400);

  assert.match(
    block,
    /panelEl\.contains\(e\.target\)/,
    "handler must not dismiss when the click originated inside the panel itself (e.g. on the X button)"
  );
  assert.match(
    block,
    /panelToggleBtn.*contains\(e\.target\)/,
    "handler must not dismiss when the click originated on the topbar toggle button (that click already handles open/close via its own listener)"
  );
});
