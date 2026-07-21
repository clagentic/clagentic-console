// hub-recent-sessions-icon-abbrev-fallback-lr-e5faff.test.js — lr-e5faff regression coverage.
//
// Bug: projects using the default text-based icon (getProjectAbbrev(), not an
// emoji or custom :slug: icon) rendered a BLANK icon slot in the Home Hub
// "RECENT SESSIONS" card — handleHubRecentSessions() emitted an empty
// .hub-recent-project-icon--blank span instead of the getProjectAbbrev()
// fallback that sidebar-projects.js (icon strip) and sidebar-mobile.js
// (mobile project list / chat header) already apply for the identical
// null-icon case. Emoji-icon and custom-icon projects rendered fine because
// they hit the projectIconHtml() branch.
//
// Fix: when sess.projectIcon is falsy, render
// escapeHtml(getProjectAbbrev(sess.projectTitle || sess.projectSlug)) into
// the icon span instead of leaving it blank, reusing the SAME
// getProjectAbbrev() exported from sidebar-projects.js rather than
// reimplementing the two-letter abbreviation logic.
//
// Matching the project's existing convention for DOM-heavy frontend modules
// (see hub-recent-sessions-merge-dot-lr-0aa7b6.test.js), this is a
// source-text regression check against the built file — app-home-hub.js
// pulls in a long chain of DOM-touching modules that assume a browser
// environment, making direct import under node:test impractical.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var HOME_HUB_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/app-home-hub.js"),
  "utf8"
);

var HOME_HUB_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/home-hub.css"),
  "utf8"
);

test("app-home-hub.js: imports getProjectAbbrev from sidebar-projects.js (reuse, not reimplementation)", () => {
  assert.match(
    HOME_HUB_JS,
    /import\s*\{\s*getProjectAbbrev\s*\}\s*from\s*['"]\.\/sidebar-projects\.js['"]/,
    "expected app-home-hub.js to import the existing getProjectAbbrev() rather than reimplementing the abbreviation logic"
  );
});

test("app-home-hub.js: handleHubRecentSessions no longer renders a blank icon span when sess.projectIcon is falsy", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  assert.ok(idx !== -1, "expected handleHubRecentSessions to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 2600);

  assert.doesNotMatch(
    block,
    /hub-recent-project-icon--blank/,
    "the blank icon span markup must be removed — a falsy sess.projectIcon must fall back to the abbreviation, not an empty box"
  );

  assert.match(
    block,
    /getProjectAbbrev\s*\(\s*sess\.projectTitle\s*\|\|\s*sess\.projectSlug\s*\)/,
    "expected the falsy-icon branch to call getProjectAbbrev(sess.projectTitle || sess.projectSlug)"
  );

  assert.match(
    block,
    /escapeHtml\s*\(\s*getProjectAbbrev/,
    "the abbreviation must be HTML-escaped before interpolation into the innerHTML-built row markup"
  );

  assert.match(
    block,
    /hub-recent-project-icon--abbrev/,
    "expected the fallback span to carry a distinct --abbrev modifier class for styling as a project badge"
  );
});

test("app-home-hub.js: the emoji / custom-icon path (projectIconHtml) is unchanged", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  var block = HOME_HUB_JS.slice(idx, idx + 2600);

  assert.match(
    block,
    /sess\.projectIcon\s*\n?\s*\?\s*'<span class="hub-recent-project-icon">'\s*\+\s*projectIconHtml\s*\(\s*sess\.projectIcon\s*\)/,
    "expected the truthy sess.projectIcon branch to still route through projectIconHtml() unchanged"
  );
});

test("home-hub.css: .hub-recent-project-icon--abbrev exists and styles the fallback as a badge (not blank box)", () => {
  var idx = HOME_HUB_CSS.indexOf(".hub-recent-project-icon--abbrev");
  assert.ok(idx !== -1, "expected a .hub-recent-project-icon--abbrev rule in home-hub.css");
  var block = HOME_HUB_CSS.slice(idx, idx + 400);

  assert.match(
    block,
    /font-weight:\s*700/,
    "the abbreviation badge should render bold text (matching the .mobile-project-abbrev / .wt-branch-abbrev badge styling used elsewhere)"
  );
  assert.match(
    block,
    /justify-content:\s*center/,
    "the abbreviation text must be centered within the badge box"
  );
});

test("home-hub.css: the old --blank rule is removed (superseded by --abbrev)", () => {
  assert.doesNotMatch(
    HOME_HUB_CSS,
    /\.hub-recent-project-icon--blank\s*\{/,
    "no .hub-recent-project-icon--blank { ... } rule may remain in home-hub.css — replaced by --abbrev, which always renders real fallback content"
  );
});
