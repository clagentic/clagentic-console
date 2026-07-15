// hub-recent-sessions-alert-dot-lr-2b1f03.test.js — lr-2b1f03 regression coverage.
//
// Feature: the Home Hub Projects list shows a per-project alert count badge
// (proj.unread, rendered as .icon-strip-project-badge.has-unread etc), but
// the Recent Sessions list showed no alert indicator at all. This adds a
// small red dot on each Recent Sessions row whose project has 1+ unread
// items — reusing the SAME per-project unread source that drives the
// Projects-list badge, rather than inventing a new data path.
//
// app-home-hub.js imports getCachedProjects from app-projects.js, and
// pulls in a long chain of DOM-touching modules (theme, scheduler,
// filebrowser, ws-ref, etc.) that assume a browser environment, so
// importing it directly under node:test is impractical. Matching the
// project's existing convention for DOM-heavy frontend modules (see
// mobile-home-toggle-lr-551048.test.js), this is a source-text regression
// check against the built file.

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

test("app-home-hub.js: defines a projectHasAlert helper that reads getCachedProjects() unread state", () => {
  var idx = HOME_HUB_JS.indexOf("function projectHasAlert");
  assert.ok(idx !== -1, "expected a projectHasAlert(projectSlug) helper to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 600);

  assert.match(
    block,
    /getCachedProjects\s*\(\s*\)/,
    "projectHasAlert must reuse getCachedProjects() — the same per-project cache that drives the Projects-list unread badge — rather than inventing a new data path"
  );
  assert.match(
    block,
    /\.unread/,
    "projectHasAlert must key off proj.unread, the same field rendered as the Projects-list alert count badge (app-projects.js renderProjectList / sidebar-projects.js .icon-strip-project-badge)"
  );
});

test("app-home-hub.js: handleHubRecentSessions renders an alert dot for rows whose project has unread activity", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  assert.ok(idx !== -1, "expected handleHubRecentSessions to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 2000);

  assert.match(
    block,
    /projectHasAlert\s*\(\s*sess\.projectSlug\s*\)/,
    "handleHubRecentSessions must call projectHasAlert(sess.projectSlug) per row to decide whether to show the dot"
  );
  assert.match(
    block,
    /hub-recent-alert-dot/,
    "the alert indicator must use a dedicated hub-recent-alert-dot class, distinct from the existing hub-recent-dot (processing) indicator"
  );
});

test("app-home-hub.js: rows for projects with no alerts render unchanged (alertHtml is empty string, not a hidden element)", () => {
  var idx = HOME_HUB_JS.indexOf("var alertHtml");
  assert.ok(idx !== -1, "expected an alertHtml local computed per session row");
  var block = HOME_HUB_JS.slice(idx, idx + 300);

  assert.match(
    block,
    /\?\s*'<span class="hub-recent-alert-dot"[^']*'\s*\n?\s*:\s*''/,
    "alertHtml must fall back to an empty string when the project has no unread activity, so unaffected rows render exactly as before"
  );
});

test("home-hub.css: .hub-recent-alert-dot is styled as a small red dot", () => {
  var idx = HOME_HUB_CSS.indexOf(".hub-recent-alert-dot");
  assert.ok(idx !== -1, "expected a .hub-recent-alert-dot rule in home-hub.css");
  var block = HOME_HUB_CSS.slice(idx, idx + 300);

  assert.match(block, /border-radius:\s*50%/, "alert indicator must be a circular dot");
  assert.match(
    block,
    /#e74c3c/,
    "alert dot must use the same red (#e74c3c) as the existing .icon-strip-project-badge unread badge, matching established alert-color convention"
  );
});
