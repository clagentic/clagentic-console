// diagnostics-toast-offscreen-lr-56fb36.test.js — lr-56fb36 regression coverage.
//
// The base .toast class (base.css) is the single-toast, center-bottom
// pattern: position:fixed; left:50%; bottom:80px; transform:translateX(-50%)
// translateY(...). lr-e901 introduced #diagnostic-toast-container, a
// corner-anchored flex-column stack, and re-pointed .toast-diagnostic
// (diagnostics.css) to position:relative so the container does the
// positioning instead of each toast self-positioning.
//
// .toast-diagnostic already overrode `position` and `transform` — but never
// overrode `left` or `bottom`. Those two properties from the base .toast
// rule are NOT conflicting declarations that get replaced wholesale; CSS
// merges non-overridden properties from earlier equal-specificity rules, so
// left:50% and bottom:80px kept applying to every diagnostic toast. That
// leftover left:50% offset — computed against the shrink-to-fit fixed
// container's containing block, not the toast's own centered position —
// is what pushed the box past the right viewport edge on both desktop and
// mobile despite the lr-fab390/lr-4ef618 max-width clamps, which only bound
// the box's own width, never its offset from the container.
//
// diagnostics.css is a plain stylesheet with no DOM harness in this
// project's test runner (see diagnostics-toast-dedup-placement-lr-e901.test.js
// header note) — these are source-text regression checks matching that
// convention.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var BASE_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/base.css"),
  "utf8"
);
var DIAGNOSTICS_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/diagnostics.css"),
  "utf8"
);

test("base.css: .toast still sets left:50% (sanity — confirms the leak source is real, not already removed)", () => {
  var idx = BASE_CSS.indexOf(".toast {");
  assert.ok(idx !== -1, "expected a base .toast rule to exist");
  var block = BASE_CSS.slice(idx, idx + 400);

  assert.match(block, /left:\s*50%/,
    "base .toast is expected to keep left:50% for its own center-bottom single-toast use -- " +
    "this test's companion assertion below is what must explicitly cancel it for .toast-diagnostic");
});

test("diagnostics.css: .toast-diagnostic explicitly resets left so the base .toast center-bottom offset cannot leak through", () => {
  var idx = DIAGNOSTICS_CSS.indexOf(".toast-diagnostic {");
  assert.ok(idx !== -1, "expected .toast-diagnostic rule to exist");
  var end = DIAGNOSTICS_CSS.indexOf("}", idx);
  var block = DIAGNOSTICS_CSS.slice(idx, end);

  assert.match(
    block,
    /left:\s*auto/,
    "lr-56fb36: .toast-diagnostic must set left:auto -- otherwise base.css's .toast left:50% " +
    "(designed for the old center-bottom single-toast pattern) keeps applying and offsets the " +
    "box away from the normal-flow position #diagnostic-toast-container computes for it, pushing " +
    "it past the right viewport edge on both desktop and mobile"
  );
});

test("diagnostics.css: .toast-diagnostic explicitly resets bottom so the base .toast vertical offset cannot leak through", () => {
  var idx = DIAGNOSTICS_CSS.indexOf(".toast-diagnostic {");
  assert.ok(idx !== -1, "expected .toast-diagnostic rule to exist");
  var end = DIAGNOSTICS_CSS.indexOf("}", idx);
  var block = DIAGNOSTICS_CSS.slice(idx, end);

  assert.match(
    block,
    /bottom:\s*auto/,
    "lr-56fb36: .toast-diagnostic must set bottom:auto -- base.css's .toast bottom:80px is a " +
    "leftover from the center-bottom single-toast pattern and should not affect the corner-" +
    "anchored, container-positioned diagnostic toast"
  );
});

test("diagnostics.css: mobile media query does not need to re-reset left/bottom (already auto from the base rule above)", () => {
  var idx = DIAGNOSTICS_CSS.indexOf("@media (max-width: 768px)");
  assert.ok(idx !== -1, "expected a mobile media query to exist");
  var block = DIAGNOSTICS_CSS.slice(idx, idx + 900);

  // Mobile widens the container to left:16px/right:16px and constrains the
  // child to width:100%/max-width:100% -- it must not reintroduce left:50%
  // or bottom on .toast-diagnostic, which would resurrect the leak this
  // fix removes.
  assert.ok(block.indexOf("left: 50%") === -1,
    "mobile .toast-diagnostic override must not reintroduce left:50%");
});
