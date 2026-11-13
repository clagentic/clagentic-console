// diagnostics-panel-pointer-events-lr-b580.test.js — lr-b580 regression coverage.
//
// Root cause: #diagnostics-panel lives inside #info-panels
// (lib/public/css/menus.css), which is `position: fixed; pointer-events: none`
// so it can span the viewport without blocking clicks on the app underneath.
// Sibling panels (#usage-panel, #status-panel, #context-panel)
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
    /#usage-panel,\s*#status-panel,\s*#context-panel,\s*#diagnostics-panel\s*\{[^}]*pointer-events:\s*auto/,
    "#diagnostics-panel must share the pointer-events:auto rule with its sibling panels -- without it, the panel inherits pointer-events:none from #info-panels and becomes fully unclickable (lr-b580 root cause)"
  );
});

test("menus.css: #diagnostics-panel.hidden is included in the shared display:none selector", () => {
  assert.match(
    MENUS_CSS,
    /#usage-panel\.hidden,\s*#status-panel\.hidden,\s*#context-panel\.hidden,\s*#diagnostics-panel\.hidden\s*\{\s*display:\s*none;\s*\}/,
    "#diagnostics-panel.hidden must be listed alongside its sibling panels for consistency with the shared panel pattern"
  );
});

// The panel is dismissed by a click outside it (lr-b580) through the open-menu
// registry: the panel is adopted as a menu with the topbar toggle as its opener,
// so a click inside it or on the toggle is not an outside click, and the module
// carries no document listener of its own.
test("diagnostics.js: the panel is adopted as a menu, with the toggle button as its opener", () => {
  assert.match(
    DIAGNOSTICS_JS,
    /openInfoPanel\(\s*panelEl,\s*\{[^}]*opener:\s*panelToggleBtn/,
    "the panel must open through the shared component with panelToggleBtn as opener (a click on the toggle is the toggle's own)"
  );
  assert.ok(
    !/document\.addEventListener\(/.test(DIAGNOSTICS_JS),
    "outside click and Escape belong to the registry: diagnostics.js adds no document listener"
  );
});

test("diagnostics.js: focus returns to the topbar toggle however the panel closes", () => {
  var idx = DIAGNOSTICS_JS.indexOf("function _onPanelClosed");
  assert.ok(idx !== -1, "expected the close hook to exist");
  assert.match(
    DIAGNOSTICS_JS.slice(idx, idx + 500),
    /panelToggleBtn\.focus\(\)/,
    "the close hook restores focus to the topbar toggle (WCAG 2.1 2.4.3), for the close control, Escape and an outside click alike"
  );
});
