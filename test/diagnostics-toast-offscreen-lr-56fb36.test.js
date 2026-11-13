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

var cssRules = require("./fixtures/css-rules");

var BASE_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/base.css"),
  "utf8"
);
var DIAGNOSTICS_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/diagnostics.css"),
  "utf8"
);

// The leak this guarded (the base .toast rule's left:50% / bottom:80px bleeding
// into the corner-anchored diagnostic toast) is closed at the source: there is
// no base .toast positioning rule left to leak, and no toast rule positions
// itself. The rows below assert that end state.
test("base.css: no .toast rule remains to leak a center-bottom offset into a toast", () => {
  assert.ok(!/(^|[\s,}])\.toast\s*[{,.:]/.test(BASE_CSS),
    "base.css must not carry a .toast rule: the single-toast center-bottom pattern is gone");
  assert.ok(!/left:\s*50%/.test(BASE_CSS.slice(BASE_CSS.indexOf("Reload banner content"))),
    "no toast or banner rule in base.css centers itself with left:50%");
});

test("diagnostics.css: no toast rule sets left or bottom, so the stack alone places the card", () => {
  var toastRules = cssRules.rules(DIAGNOSTICS_CSS).filter(function (r) { return /toast/.test(r.selector); });
  assert.ok(toastRules.length > 0, "the toast content rules are still present");
  toastRules.forEach(function (r) {
    assert.ok(!/(^|[;\s])(left|bottom|right|top|position)\s*:/.test(r.body),
      "lr-56fb36: " + r.selector + " must not position itself (left/bottom/right/top/position)");
  });
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
