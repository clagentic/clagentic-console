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
// The two stylesheet checks read menus.css as text; the panel check runs the
// real module over the fake DOM and reads the stylesheet through css-rules.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");
var cssRules = require("./fixtures/css-rules");

var MENUS_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/menus.css"),
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

// The panel is dismissed through the open-menu registry (the shared component and
// its close control), not a document listener of its own. What lr-b580 guards is
// asserted here on the element and its stylesheet, not on the module's source:
// an open panel takes pointer events on its own bounds, and a closed one is
// hidden, so it blocks none. The focus-return behaviour is a runtime row in
// overlay-stack.test.js.
test("the diagnostics panel element takes pointer events when open and is hidden, so blocks none, when closed", async (t) => {
  await dom.setupToolsEnv(t);
  global.requestAnimationFrame = function (fn) { fn(); return 0; };
  var find = function (node, id) {
    return node.id === id ? node : node._children.reduce(function (hit, c) { return hit || find(c, id); }, null);
  };
  global.document.getElementById = function (id) { return find(global.document.body, id); };
  var panel = new dom.FakeElement("div");
  panel.id = "diagnostics-panel";
  panel.className = "hidden";
  var list = new dom.FakeElement("div");
  list.id = "diagnostics-panel-list";
  var toggle = new dom.FakeElement("button");
  toggle.id = "diagnostics-panel-btn";
  [panel, list, toggle].forEach(function (el) { global.document.body.appendChild(el); });
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?b580");
  diagnostics.initDiagnostics();

  toggle.click();
  assert.equal(panel.classList.contains("hidden"), false, "the toggle opens the panel");
  assert.equal(cssRules.valueAt(MENUS_CSS, "#diagnostics-panel", "pointer-events", 1280), "auto",
    "an open panel takes pointer events on its own bounds under the click-through #info-panels");
  assert.equal(cssRules.valueAt(MENUS_CSS, "#info-panels", "pointer-events", 1280), "none");

  toggle.click();
  assert.equal(panel.classList.contains("hidden"), true, "closing the panel hides it");
  assert.equal(cssRules.valueAt(MENUS_CSS, "#diagnostics-panel.hidden", "display", 1280), "none",
    "a hidden panel is display:none, so it blocks no pointer events");
});
