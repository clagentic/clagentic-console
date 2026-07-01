// server-settings-mobile-parity-lr-87ca.test.js — lr-87ca regression coverage.
//
// Root cause (andy, 2026-07-01): #server-settings-btn lives inside #top-bar,
// which is display:none at <=768px (lib/public/css/title-bar.css). Before
// this fix, the mobile "More" sheet opened Server Settings by
// synthetic-clicking that hidden button — functional, but not a first-class
// discoverable nav path (the button never appears in the mobile UI at all).
//
// Fix: server-settings.js exports openServerSettings(), a public entry point
// independent of the desktop button element (mirrors the existing
// openProjectSettings() pattern already used by Project Settings).
// sidebar-mobile.js imports it and calls it directly instead of dispatching
// a synthetic click.
//
// These are source-text regression checks (no DOM harness required — both
// modules perform their DOM work inside functions, not at import time,
// consistent with the project's existing xss-escape.test.js convention).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var SERVER_SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/server-settings.js"),
  "utf8"
);
var SIDEBAR_MOBILE_SRC = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/sidebar-mobile.js"),
  "utf8"
);

test("server-settings.js exports openServerSettings as a public entry point", () => {
  assert.match(
    SERVER_SETTINGS_SRC,
    /export function openServerSettings\s*\(/,
    "openServerSettings must be an exported function so callers outside this module can open the panel without the desktop button"
  );
});

test("sidebar-mobile.js imports openServerSettings from server-settings.js", () => {
  assert.match(
    SIDEBAR_MOBILE_SRC,
    /import\s*\{\s*openServerSettings\s*\}\s*from\s*['"]\.\/server-settings\.js['"]/,
    "the mobile More sheet must import the real open function, not rely on a global lookup"
  );
});

test("sidebar-mobile.js Server Settings entry calls openServerSettings(), not a synthetic click", () => {
  // Isolate the "Server Settings" addItem() call block so this assertion is
  // scoped to the regression site rather than the whole file.
  var idx = SIDEBAR_MOBILE_SRC.indexOf('addItem("settings", "Server Settings"');
  assert.ok(idx !== -1, 'expected addItem("settings", "Server Settings", ...) call to exist');
  var block = SIDEBAR_MOBILE_SRC.slice(idx, idx + 500);

  assert.match(
    block,
    /openServerSettings\s*\(\s*\)/,
    "Server Settings mobile entry must call openServerSettings() directly"
  );
  assert.doesNotMatch(
    block,
    /getElementById\(["']server-settings-btn["']\)/,
    "Server Settings mobile entry must not look up the desktop-only #server-settings-btn (hidden at <=768px, lr-87ca root cause)"
  );
  assert.doesNotMatch(
    block,
    /\.click\(\)/,
    "Server Settings mobile entry must not dispatch a synthetic click — that is the discoverability defect lr-87ca fixes"
  );
});

test("SETTINGS_SECTIONS registry includes custom-icons (lr-d1d9 section stays reachable via the mobile palette)", () => {
  var idx = SERVER_SETTINGS_SRC.indexOf("var SETTINGS_SECTIONS");
  assert.ok(idx !== -1, "expected SETTINGS_SECTIONS array to exist");
  var arrayEnd = SERVER_SETTINGS_SRC.indexOf("];", idx);
  var block = SERVER_SETTINGS_SRC.slice(idx, arrayEnd);

  assert.match(
    block,
    /section:\s*['"]custom-icons['"]/,
    "custom-icons must stay registered in SETTINGS_SECTIONS — this is the shared registry that drives both the desktop nav sidebar and the mobile settings palette (openSettingsPalette), so removing it here would silently break mobile discoverability of Custom Icons even though the entry-point fix above is correct"
  );
});
