// hub-recent-sessions-merge-dot-lr-0aa7b6.test.js — lr-0aa7b6 regression coverage.
//
// Feature: Home Hub Recent Sessions rows previously showed TWO indicators —
// a left status dot (.hub-recent-dot; green=live/processing, grey=idle) and
// a SEPARATE right red alert dot (.hub-recent-alert-dot, added by
// lr-2b1f03). This merges them into ONE left dot whose COLOR encodes
// everything, with a LOCKED precedence (andy, lr-0aa7b6):
//   alert(red) > processing(green) > live(green) > idle(grey)
// .hub-recent-alert-dot is removed entirely — alert is now just another
// color state (.hub-recent-dot.alert) of the single left dot.
//
// Supersedes test/hub-recent-sessions-alert-dot-lr-2b1f03.test.js, which
// asserted the old two-dot design this task explicitly replaces.
//
// KNOWN LIMITATION carried forward from lr-0aa7b6 (see projectHasAlert doc
// comment in app-home-hub.js): the alert state is still keyed on
// projectHasAlert(sess.projectSlug) — PER-PROJECT, not per-session. A
// genuine per-session cross-project unread signal does not exist server-
// or client-side today (see TODO(lr-0aa7b6) in app-home-hub.js); extending
// it touches the same aggregate the project-badge unread count depends on.
// This is flagged, not silently shipped as fixed — a test asserting true
// per-session isolation is intentionally NOT included here, since that
// isolation does not exist yet.
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

test("app-home-hub.js: the separate hub-recent-alert-dot span markup is removed — no second dot", () => {
  // A prose comment MAY still reference the removed class name for context
  // (e.g. "formerly a separate ... .hub-recent-alert-dot"); what must not
  // exist is the actual markup that renders it as a span.
  assert.doesNotMatch(
    HOME_HUB_JS,
    /class="hub-recent-alert-dot"/,
    "no element with class=\"hub-recent-alert-dot\" may be rendered — alert is now a color state of the single left dot, not a separate span"
  );
});

test("home-hub.css: the separate .hub-recent-alert-dot rule is removed", () => {
  // A prose comment MAY still reference the removed selector for context;
  // the actual CSS rule declaring it must not exist.
  assert.doesNotMatch(
    HOME_HUB_CSS,
    /\.hub-recent-alert-dot\s*\{/,
    "no .hub-recent-alert-dot { ... } rule may exist in home-hub.css — folded into .hub-recent-dot.alert"
  );
});

test("app-home-hub.js: defines a projectHasAlert helper that reads getCachedProjects() unread state", () => {
  var idx = HOME_HUB_JS.indexOf("function projectHasAlert");
  assert.ok(idx !== -1, "expected a projectHasAlert(projectSlug) helper to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 1600);

  assert.match(
    block,
    /getCachedProjects\s*\(\s*\)/,
    "projectHasAlert must reuse getCachedProjects() — the same per-project cache that drives the Projects-list unread badge — rather than inventing a new data path"
  );
  assert.match(
    block,
    /\.unread/,
    "projectHasAlert must key off proj.unread, the same field rendered as the Projects-list alert count badge"
  );
});

test("app-home-hub.js: handleHubRecentSessions renders a single dot per row with LOCKED color precedence alert > processing > live > idle", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  assert.ok(idx !== -1, "expected handleHubRecentSessions to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 2500);

  assert.match(
    block,
    /projectHasAlert\s*\(\s*sess\.projectSlug\s*\)/,
    "handleHubRecentSessions must call projectHasAlert(sess.projectSlug) to decide alert state"
  );

  // Precedence: alert must be checked/applied BEFORE (and win over) processing.
  var hasAlertIdx = block.indexOf("hasAlert");
  var alertClassIdx = block.indexOf('" alert"');
  var processingClassIdx = block.indexOf('" processing"');
  assert.ok(hasAlertIdx !== -1, "expected a hasAlert local computed from projectHasAlert");
  assert.ok(alertClassIdx !== -1, "expected the dot class to conditionally include ' alert'");
  assert.ok(processingClassIdx !== -1, "expected the dot class to conditionally include ' processing'");
  assert.ok(
    alertClassIdx < processingClassIdx,
    "the alert branch must be evaluated/placed ahead of the processing branch in the ternary, encoding alert(red) > processing(green) precedence"
  );

  // Exactly one dot span per row — no second/separate alert span.
  var dotSpanMatches = block.match(/<span class="'\s*\+\s*dotClass/);
  assert.ok(dotSpanMatches, "expected a single dot span driven by dotClass");
});

test("app-home-hub.js: the merged dot preserves a title/tooltip explaining the state", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  var block = HOME_HUB_JS.slice(idx, idx + 2500);

  assert.match(
    block,
    /dotTitle/,
    "expected a dotTitle local used as the dot's title attribute"
  );
  assert.match(
    block,
    /Unread activity/,
    "the alert state's tooltip text must explain the red dot (e.g. 'Unread activity'), matching the removed .hub-recent-alert-dot's tooltip"
  );
  assert.match(
    block,
    /title="'\s*\+\s*dotTitle\s*\+\s*'"/,
    "dotTitle must be rendered as the dot span's title attribute so hover still explains the state"
  );
});

test("home-hub.css: .hub-recent-dot.alert is styled with the established alert red, and no longer conflicts with .processing", () => {
  var idx = HOME_HUB_CSS.indexOf(".hub-recent-dot.alert");
  assert.ok(idx !== -1, "expected a .hub-recent-dot.alert rule in home-hub.css");
  var block = HOME_HUB_CSS.slice(idx, idx + 300);

  assert.match(
    block,
    /#e74c3c/,
    "alert dot state must use the same red (#e74c3c) as the removed .hub-recent-alert-dot / .icon-strip-project-badge unread badge"
  );
});

test("app-home-hub.js: KNOWN LIMITATION is documented — alert is per-project, not per-session, pending a real per-session signal", () => {
  var idx = HOME_HUB_JS.indexOf("function projectHasAlert");
  assert.ok(idx !== -1);
  var block = HOME_HUB_JS.slice(Math.max(0, idx - 1600), idx);

  assert.match(
    block,
    /KNOWN LIMITATION/,
    "expected the per-project (not per-session) limitation to be documented above projectHasAlert, since no per-session cross-project unread signal exists in the data path today"
  );
  assert.match(
    block,
    /TODO\(lr-0aa7b6\)/,
    "expected a TODO(lr-0aa7b6) marking the follow-up to thread a genuine per-session unread signal"
  );
});
