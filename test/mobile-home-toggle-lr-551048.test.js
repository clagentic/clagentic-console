// mobile-home-toggle-lr-551048.test.js — lr-551048 regression coverage.
//
// Root cause: the mobile Home tab-bar button's click handler unconditionally
// called showHomeHub(), so tapping the button while the hub was already open
// re-opened it instead of closing it — the button did not behave as a toggle.
//
// Fix: import isHomeHubVisible/hideHomeHub from app-home-hub.js (already
// imported elsewhere in the frontend) and branch on the hub's visibility:
// when visible, hide it and clear the mobile tab-active state; otherwise
// show it as before.
//
// sidebar-mobile.js pulls in a long chain of DOM-touching modules (theme,
// scheduler, filebrowser, terminal, ws-ref, etc.) that assume a browser
// environment, so importing it directly under node:test is impractical.
// Matching the project's existing convention for DOM-heavy frontend modules
// (see diagnostics-panel-pointer-events-lr-b580.test.js), this is a
// source-text regression check against the built file.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var SIDEBAR_MOBILE_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/sidebar-mobile.js"),
  "utf8"
);

test("sidebar-mobile.js: imports isHomeHubVisible and hideHomeHub alongside showHomeHub", () => {
  assert.match(
    SIDEBAR_MOBILE_JS,
    /import\s*\{\s*showHomeHub\s*,\s*hideHomeHub\s*,\s*isHomeHubVisible\s*\}\s*from\s*['"]\.\/app-home-hub\.js['"]/,
    "expected showHomeHub, hideHomeHub, and isHomeHubVisible to be imported from app-home-hub.js so the mobile Home button can toggle instead of always opening the hub"
  );
});

test("sidebar-mobile.js: mobile-home-btn click handler toggles the hub instead of unconditionally showing it", () => {
  var idx = SIDEBAR_MOBILE_JS.indexOf('mobileHomeBtn.addEventListener("click"');
  assert.ok(idx !== -1, "expected the mobileHomeBtn click-handler wiring to exist");
  var block = SIDEBAR_MOBILE_JS.slice(idx, idx + 500);

  assert.match(
    block,
    /if\s*\(\s*isHomeHubVisible\s*\(\s*\)\s*\)\s*\{/,
    "click handler must branch on isHomeHubVisible() to decide whether to open or close the hub (lr-551048 root cause: showHomeHub() was called unconditionally)"
  );
  assert.match(
    block,
    /hideHomeHub\s*\(\s*\)/,
    "when the hub is already visible, the handler must call hideHomeHub() to close it"
  );
  assert.match(
    block,
    /showHomeHub\s*\(\s*\)/,
    "when the hub is not visible, the handler must still call showHomeHub() to open it (else branch preserved)"
  );
});

test("sidebar-mobile.js: closing the hub via toggle clears the home tab active state", () => {
  var idx = SIDEBAR_MOBILE_JS.indexOf('mobileHomeBtn.addEventListener("click"');
  assert.ok(idx !== -1, "expected the mobileHomeBtn click-handler wiring to exist");
  var block = SIDEBAR_MOBILE_JS.slice(idx, idx + 500);

  // The hide branch must call setMobileTabActive with something other than
  // "home" (e.g. null) so mobile-home-btn's active class is cleared,
  // keeping tab-active state consistent with the now-hidden hub.
  var hideBranchMatch = block.match(/if\s*\(\s*isHomeHubVisible\s*\(\s*\)\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
  assert.ok(hideBranchMatch, "expected an if/else branch keyed on isHomeHubVisible()");
  var hideBranch = hideBranchMatch[1];

  assert.match(
    hideBranch,
    /hideHomeHub\s*\(\s*\)/,
    "hide branch must call hideHomeHub()"
  );
  assert.match(
    hideBranch,
    /setMobileTabActive\s*\(\s*null\s*\)/,
    "hide branch must clear the active tab (setMobileTabActive(null)) so mobile-home-btn loses its active class, matching the now-hidden hub state"
  );
});
