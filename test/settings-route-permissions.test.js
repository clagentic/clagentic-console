// Permission parity for the phone settings routes.
//
// Desktop offers Project Settings only to a user whose permissions do not set
// projectSettings to false (the project context menu), and Server Settings only
// to an administrator (the gear button is hidden for everyone else). A phone
// route must not offer what desktop withholds. The routes into each panel used
// to bypass those checks: the More sheet opened Project Settings with no check
// at all, and opened Server Settings by clicking the gear button, which is hidden
// for non-administrators but still answers a scripted click.
//
// The checks live at the openers (openProjectSettings, openServerSettings), so
// every route into a panel passes them. The frontend modules assume a browser
// (see mobile-home-toggle-lr-551048.test.js), so the wiring is pinned from the
// source text; the decision itself is exercised in settings-access.test.js.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function source(name) {
  return fs.readFileSync(path.join(__dirname, "../lib/public/modules", name), "utf8");
}

// Body of `function <name>(...) {` up to the next top-level closing brace.
function functionBody(src, name) {
  var start = src.indexOf("function " + name + "(");
  assert.ok(start !== -1, "expected function " + name + " to exist");
  var end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end);
}

var PROJECT = source("project-settings.js");
var SERVER = source("server-settings.js");
var MOBILE = source("sidebar-mobile.js");
var PROJECTS = source("sidebar-projects.js");

// [description, check]
var ROWS = [
  [
    "openProjectSettings checks the project-settings permission before it opens, for every caller",
    function () {
      var body = functionBody(PROJECT, "openProjectSettings");
      assert.match(body, /canOpenProjectSettings\(\s*store\.get\(['"]permissions['"]\)\s*\)/);
      assert.ok(
        body.indexOf("canOpenProjectSettings(") < body.indexOf("panelEl.classList.remove"),
        "the permission check must come before the panel is shown"
      );
    },
  ],
  [
    "the desktop project menu uses the same shared predicate, not its own copy of the rule",
    function () {
      assert.match(PROJECTS, /canOpenProjectSettings\(\s*store\.get\(['"]permissions['"]\)\s*\)/);
      assert.doesNotMatch(PROJECTS, /permissions'\)\.projectSettings !== false\) \{\s*\n\s*var settingsItem/);
    },
  ],
  [
    "openServerSettings asks the administrator check the gear button's visibility uses",
    function () {
      var body = functionBody(SERVER, "openServerSettings");
      assert.match(body, /checkAdminAccess\(\)/);
    },
  ],
  [
    "the gear button and the update notice open Server Settings through that checked opener",
    function () {
      assert.doesNotMatch(SERVER, /settingsBtn\.addEventListener\("click", function \(\) \{\s*openSettings\(\);/);
      assert.doesNotMatch(SERVER, /registerPlace\("update_available", openSettings\)/);
      assert.match(SERVER, /registerPlace\("update_available", function \(\) \{ openServerSettings\(\); \}\)/);
    },
  ],
  [
    "the More sheet no longer reaches Server Settings by clicking the hidden gear button",
    function () {
      assert.doesNotMatch(MOBILE, /getElementById\(["']server-settings-btn["']\)/);
    },
  ],
];

ROWS.forEach(function (row) {
  test("settings route permissions: " + row[0], row[1]);
});
